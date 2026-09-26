import {
  type Obj,
  object,
  isObject,
  truthy,
  get,
  pythonJson,
  streamErrorMessage,
  ProtocolBridgeError,
} from './compat-helpers'
export const sse = (event: string, payload: Obj) =>
  `event: ${event}\ndata: ${pythonJson(payload)}\n\n`
export const done = () => 'data: [DONE]\n\n'
export function chatChunk(
  id: unknown,
  model: unknown,
  delta: Obj = {},
  finish: unknown = null,
  usage?: unknown,
): string {
  const payload: Obj = {
    id,
    object: 'chat.completion.chunk',
    model: model || '',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
  if (usage != null) payload.usage = usage
  return `data: ${pythonJson(payload)}\n\n`
}
export function anthropicUsage(raw: unknown): Obj {
  const usage = object(raw),
    read = Number(usage.cache_read_input_tokens || 0),
    write = Number(usage.cache_creation_input_tokens || 0)
  const result: Obj = {
    prompt_tokens: Number(usage.input_tokens || 0) + read + write,
    completion_tokens: Number(usage.output_tokens || 0),
  }
  if (read) result.prompt_tokens_details = { cached_tokens: read }
  if (write) result.cache_creation_input_tokens = write
  return result
}
export function responsesChatUsage(raw: unknown): Obj {
  const usage = object(raw),
    details = object(usage.input_tokens_details)
  const read = Number(
      details.cached_tokens || usage.cache_read_input_tokens || 0,
    ),
    write = Number(
      usage.cache_creation_input_tokens || details.cache_write_tokens || 0,
    )
  const result: Obj = {
    prompt_tokens: Number(usage.input_tokens || 0),
    completion_tokens: Number(usage.output_tokens || 0),
  }
  if (read) result.prompt_tokens_details = { cached_tokens: read }
  if (write) result.cache_creation_input_tokens = write
  return result
}
export abstract class SourceStream {
  finished = false
  private pendingEvent: string | null = null
  abstract feed(value: unknown, event?: string | null): string
  /** Caller must only invoke finish after a verified upstream terminal, never on arbitrary EOF. */
  abstract finish(): string
  feed_line(line: string): string {
    if (line.startsWith('event:')) {
      this.pendingEvent = line.slice(6).trim()
      return ''
    }
    if (!line.startsWith('data:')) {
      if (!line.trim()) this.pendingEvent = null
      return ''
    }
    const raw = line.slice(5).trim(),
      event = this.pendingEvent
    this.pendingEvent = null
    if (raw === '' || raw === '[DONE]')
      return raw === '[DONE]' ? this.finish() : ''
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return ''
    }
    return this.feed(value, event)
  }
}
export class AnthropicToOpenAIStream extends SourceStream {
  private model: unknown
  private id: unknown = 'chatcmpl_coati'
  private started = false
  private finishSent = false
  private indexes = new Map<unknown, number>()
  private nextIndex = 0
  private toolsSeen = false
  private usage: Obj = {}
  constructor(model?: string) {
    super()
    this.model = model || ''
  }
  private start(value?: unknown): string {
    if (this.started) return ''
    this.started = true
    const message = object(value)
    this.id = message.id || this.id
    if (!this.model) this.model = message.model || ''
    return chatChunk(this.id, this.model, { role: 'assistant', content: '' })
  }
  private emitFinish(reason?: unknown, usage?: unknown): string {
    if (this.finishSent) return ''
    this.finishSent = true
    if (isObject(usage))
      Object.assign(
        this.usage,
        Object.fromEntries(Object.entries(usage).filter(([, v]) => v != null)),
      )
    const reasons: Record<string, string> = {
      end_turn: 'stop',
      stop_sequence: 'stop',
      tool_use: 'tool_calls',
      max_tokens: 'length',
    }
    return chatChunk(
      this.id,
      this.model,
      {},
      reasons[String(reason)] || 'stop',
      truthy(this.usage) ? anthropicUsage(this.usage) : undefined,
    )
  }
  feed(value: unknown, event?: string | null): string {
    if (!isObject(value) || this.finished) return ''
    const obj = value,
      kind = event || obj.type || '',
      error = streamErrorMessage(obj)
    if (error) throw new ProtocolBridgeError(error)
    let out = ''
    if (kind === 'message_start') {
      const message = object(obj.message)
      if (isObject(message.usage))
        Object.assign(
          this.usage,
          Object.fromEntries(
            Object.entries(message.usage).filter(([, v]) => v != null),
          ),
        )
      out += this.start(message)
    } else if (kind === 'content_block_start') {
      out += this.start()
      const block = object(obj.content_block)
      if (block.type === 'tool_use') {
        const source = get(obj, 'index', this.nextIndex)
        let index = this.indexes.get(source)
        if (index === undefined) {
          index = this.nextIndex++
          this.indexes.set(source, index)
        }
        this.toolsSeen = true
        out += chatChunk(this.id, this.model, {
          tool_calls: [
            {
              index,
              id: block.id || `call_${index}`,
              type: 'function',
              function: { name: block.name || '', arguments: '' },
            },
          ],
        })
      }
    } else if (kind === 'content_block_delta') {
      out += this.start()
      const delta = object(obj.delta)
      if (delta.type === 'text_delta' && delta.text)
        out += chatChunk(this.id, this.model, { content: delta.text })
      else if (delta.type === 'thinking_delta' && delta.thinking)
        out += chatChunk(this.id, this.model, {
          reasoning_content: delta.thinking,
        })
      else if (delta.type === 'input_json_delta' && delta.partial_json) {
        const source = get(obj, 'index', 0),
          index = this.indexes.get(source) ?? this.nextIndex
        this.indexes.set(source, index)
        this.nextIndex = Math.max(this.nextIndex, index + 1)
        this.toolsSeen = true
        out += chatChunk(this.id, this.model, {
          tool_calls: [{ index, function: { arguments: delta.partial_json } }],
        })
      }
    } else if (kind === 'message_delta') {
      let reason = object(obj.delta).stop_reason
      if (truthy(reason) || truthy(obj.usage)) {
        if (this.toolsSeen && reason == null) reason = 'tool_use'
        out += this.emitFinish(reason, obj.usage)
      }
    } else if (kind === 'message_stop') {
      out += this.emitFinish(this.toolsSeen ? 'tool_use' : 'end_turn') + done()
      this.finished = true
    }
    return out
  }
  finish(): string {
    if (this.finished) return ''
    const out =
      this.start() +
      this.emitFinish(this.toolsSeen ? 'tool_use' : 'end_turn') +
      done()
    this.finished = true
    return out
  }
}
export class ResponsesToOpenAIStream extends SourceStream {
  private model: unknown
  private id: unknown = 'chatcmpl_coati'
  private started = false
  private finishSent = false
  private indexes = new Map<unknown, number>()
  private nextIndex = 0
  private toolsSeen = false
  private refusalSeen = false
  constructor(model?: string) {
    super()
    this.model = model || ''
  }
  private start(value?: unknown): string {
    if (this.started) return ''
    this.started = true
    const response = object(value)
    this.id = response.id || this.id
    if (!this.model) this.model = response.model || ''
    return chatChunk(this.id, this.model, { role: 'assistant', content: '' })
  }
  private emitFinish(status?: unknown, usage?: unknown): string {
    if (this.finishSent) return ''
    this.finishSent = true
    const reason = this.toolsSeen
      ? 'tool_calls'
      : status === 'incomplete'
        ? 'length'
        : 'stop'
    return chatChunk(
      this.id,
      this.model,
      {},
      reason,
      usage != null ? responsesChatUsage(usage) : undefined,
    )
  }
  feed(value: unknown, event?: string | null): string {
    if (!isObject(value) || this.finished) return ''
    const obj = value,
      kind = event || obj.type || '',
      error = streamErrorMessage(obj)
    if (error) throw new ProtocolBridgeError(error)
    let out = ''
    if (kind === 'response.created') out += this.start(obj.response)
    else if (kind === 'response.output_item.added') {
      out += this.start()
      const item = object(obj.item)
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const source = get(obj, 'output_index', this.nextIndex)
        let index = this.indexes.get(source)
        if (index === undefined) {
          index = this.nextIndex++
          this.indexes.set(source, index)
        }
        this.toolsSeen = true
        out += chatChunk(this.id, this.model, {
          tool_calls: [
            {
              index,
              id: item.call_id || item.id || `call_${index}`,
              type: 'function',
              function: { name: item.name || '', arguments: '' },
            },
          ],
        })
      }
    } else if (kind === 'response.output_text.delta') {
      out += this.start()
      if (obj.delta)
        out += chatChunk(this.id, this.model, { content: obj.delta })
    } else if (kind === 'response.refusal.delta') {
      out += this.start()
      if (obj.delta) {
        this.refusalSeen = true
        out += chatChunk(this.id, this.model, { content: String(obj.delta) })
      }
    } else if (kind === 'response.refusal.done') {
      if (!this.refusalSeen && obj.refusal) {
        out += this.start()
        this.refusalSeen = true
        out += chatChunk(this.id, this.model, { content: String(obj.refusal) })
      }
    } else if (
      kind === 'response.reasoning_summary_text.delta' ||
      kind === 'response.reasoning_text.delta'
    ) {
      out += this.start()
      if (obj.delta)
        out += chatChunk(this.id, this.model, { reasoning_content: obj.delta })
    } else if (
      kind === 'response.function_call_arguments.delta' ||
      kind === 'response.custom_tool_call_input.delta'
    ) {
      out += this.start()
      const source = get(obj, 'output_index', 0),
        index = this.indexes.get(source) ?? this.nextIndex
      this.indexes.set(source, index)
      this.nextIndex = Math.max(this.nextIndex, index + 1)
      this.toolsSeen = true
      if (obj.delta)
        out += chatChunk(this.id, this.model, {
          tool_calls: [{ index, function: { arguments: obj.delta } }],
        })
    } else if (
      ['response.completed', 'response.incomplete', 'response.done'].includes(
        String(kind),
      )
    ) {
      const response = isObject(obj.response) ? obj.response : obj
      out += this.emitFinish(response.status, response.usage) + done()
      this.finished = true
    }
    return out
  }
  finish(): string {
    if (this.finished) return ''
    const out = this.start() + this.emitFinish('completed') + done()
    this.finished = true
    return out
  }
}
