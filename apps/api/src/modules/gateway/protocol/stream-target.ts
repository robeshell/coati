import {
  type Obj,
  object,
  isObject,
  array,
  truthy,
  get,
  text,
  pythonJson,
} from './compat-helpers'
import { sse } from './stream-source'
import { responseEnvelope, outputText } from './responses-helpers'
export interface TargetStream {
  finished: boolean
  start(): string
  feed(value: unknown): string
  finish(reason?: unknown, usage?: unknown): string[]
}
export class OpenAIToAnthropicStream implements TargetStream {
  finished = false
  private started = false
  private thinkingOpen = false
  private textIndex: number | null = null
  private nextIndex = 0
  private tools = new Map<unknown, number>()
  private id: unknown = 'msg_coati'
  constructor(private model = '') {}
  start(): string {
    if (this.started) return ''
    this.started = true
    return sse('message_start', {
      type: 'message_start',
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }
  private openThinking(): string[] {
    if (this.thinkingOpen) return []
    const event = sse('content_block_start', {
      type: 'content_block_start',
      index: this.nextIndex,
      content_block: { type: 'text', text: '' },
    })
    this.thinkingOpen = true
    this.nextIndex++
    return [event]
  }
  private closeThinking(): string[] {
    if (!this.thinkingOpen) return []
    this.thinkingOpen = false
    return [
      sse('content_block_stop', {
        type: 'content_block_stop',
        index: this.nextIndex - 1,
      }),
    ]
  }
  private openText(): string[] {
    const chunks = this.closeThinking()
    if (this.textIndex === null) {
      this.textIndex = this.nextIndex++
      chunks.push(
        sse('content_block_start', {
          type: 'content_block_start',
          index: this.textIndex,
          content_block: { type: 'text', text: '' },
        }),
      )
    }
    return chunks
  }
  /** Responses items carry their final opaque value at item completion. */
  completeReasoning(text: string, signature: string): string {
    if (!text && !signature) return ''
    const chunks = this.started ? [] : [this.start()]
    chunks.push(...this.closeThinking())
    if (this.textIndex !== null) {
      chunks.push(
        sse('content_block_stop', {
          type: 'content_block_stop',
          index: this.textIndex,
        }),
      )
      this.textIndex = null
    }
    const index = this.nextIndex++
    chunks.push(
      sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: signature
          ? { type: 'thinking', thinking: '' }
          : { type: 'text', text: '' },
      }),
    )
    if (text)
      chunks.push(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: signature
            ? { type: 'thinking_delta', thinking: text }
            : { type: 'text_delta', text },
        }),
      )
    if (signature)
      chunks.push(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature },
        }),
      )
    chunks.push(
      sse('content_block_stop', { type: 'content_block_stop', index }),
    )
    return chunks.join('')
  }
  feed(value: unknown): string {
    if (!isObject(value) || this.finished) return ''
    const obj = value
    if (obj.id) this.id = obj.id
    const out = this.started ? [] : [this.start()],
      choice = object(array(obj.choices)[0]),
      delta = object(choice.delta)
    if (truthy(delta.reasoning_content)) {
      out.push(
        ...this.openThinking(),
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: this.nextIndex - 1,
          delta: { type: 'text_delta', text: delta.reasoning_content },
        }),
      )
    }
    if (truthy(delta.content)) {
      out.push(
        ...this.openText(),
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: this.textIndex,
          delta: { type: 'text_delta', text: delta.content },
        }),
      )
    }
    for (const call of array(delta.tool_calls)) {
      if (!isObject(call)) continue
      const index = get(call, 'index', 0),
        fn = object(call.function)
      out.push(...this.closeThinking())
      if (this.textIndex !== null) {
        out.push(
          sse('content_block_stop', {
            type: 'content_block_stop',
            index: this.textIndex,
          }),
        )
        this.textIndex = null
      }
      let block = this.tools.get(index)
      if (block === undefined) {
        block = this.nextIndex
        out.push(
          sse('content_block_start', {
            type: 'content_block_start',
            index: block,
            content_block: {
              type: 'tool_use',
              id: call.id || `tool_${index}`,
              name: fn.name || '',
              input: {},
            },
          }),
        )
        this.tools.set(index, block)
        this.nextIndex = block + 1
      }
      if (truthy(fn.arguments))
        out.push(
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: block,
            delta: {
              type: 'input_json_delta',
              partial_json:
                typeof fn.arguments === 'string'
                  ? fn.arguments
                  : pythonJson(fn.arguments),
            },
          }),
        )
    }
    if (truthy(choice.finish_reason) || (truthy(obj.usage) && !truthy(delta)))
      out.push(...this.finish(choice.finish_reason, obj.usage))
    return out.join('')
  }
  finish(reason?: unknown, rawUsage?: unknown): string[] {
    if (this.finished) return []
    this.finished = true
    const chunks = this.started ? [] : [this.start()]
    chunks.push(...this.closeThinking())
    if (this.textIndex !== null) {
      chunks.push(
        sse('content_block_stop', {
          type: 'content_block_stop',
          index: this.textIndex,
        }),
      )
      this.textIndex = null
    }
    for (const index of this.tools.values())
      chunks.push(
        sse('content_block_stop', { type: 'content_block_stop', index }),
      )
    this.tools.clear()
    const reasons: Record<string, string> = {
        stop: 'end_turn',
        tool_calls: 'tool_use',
        length: 'max_tokens',
      },
      usage = object(rawUsage)
    chunks.push(
      sse('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: reasons[String(reason)] || 'end_turn',
          stop_sequence: null,
        },
        usage: {
          output_tokens: Number(
            usage.completion_tokens || usage.output_tokens || 0,
          ),
        },
      }),
    )
    chunks.push(sse('message_stop', { type: 'message_stop' }))
    return chunks
  }
}
export class OpenAIToResponsesStream implements TargetStream {
  finished = false
  private started = false
  private id: unknown = 'resp_coati'
  private created = Date.now()
  private sequence = 0
  private index = 0
  private textOpen = false
  private reasoningOpen = false
  private refusalOpen = false
  private tools = new Map<number, Obj>()
  private toolIndexes = new Map<number, number>()
  private textBuffer: string[] = []
  private reasoningBuffer: string[] = []
  private reasoningSignature: string[] = []
  private reasoningId = 'rs_coati'
  private reasoningCount = 0
  private refusalBuffer: string[] = []
  private output: Obj[] = []
  constructor(private model = '') {}
  private event(name: string, payload: Obj): string {
    return sse(name, {
      ...payload,
      type: payload.type ?? name,
      sequence_number: this.sequence++,
    })
  }
  start(): string {
    if (this.started) return ''
    this.started = true
    const response = responseEnvelope(
      this.id,
      this.model,
      [],
      null,
      false,
      this.created,
    )
    response.status = 'in_progress'
    return (
      this.event('response.created', { response }) +
      this.event('response.in_progress', { response: { ...response } })
    )
  }
  private openReasoning(): string[] {
    if (this.reasoningOpen) return []
    this.reasoningOpen = true
    this.reasoningId =
      this.reasoningCount++ === 0
        ? 'rs_coati'
        : `rs_coati_${this.reasoningCount}`
    const item = { id: this.reasoningId, type: 'reasoning', summary: [] }
    return [
      this.event('response.output_item.added', {
        output_index: this.index,
        item,
      }),
      this.event('response.reasoning_summary_part.added', {
        item_id: item.id,
        output_index: this.index,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }),
    ]
  }
  /** Direct Messages-to-Responses bridge: opaque signatures never enter Chat deltas. */
  feedSignedReasoning(text = '', signature = '', end = false): string {
    const chunks = this.started ? [] : [this.start()]
    if (!this.reasoningOpen)
      chunks.push(...this.closeText(), ...this.closeRefusal())
    chunks.push(...this.openReasoning())
    if (text) {
      this.reasoningBuffer.push(text)
      chunks.push(
        this.event('response.reasoning_summary_text.delta', {
          item_id: this.reasoningId,
          output_index: this.index,
          summary_index: 0,
          delta: text,
        }),
      )
    }
    if (signature) this.reasoningSignature.push(signature)
    if (end) chunks.push(...this.closeReasoning())
    return chunks.join('')
  }
  private closeReasoning(): string[] {
    if (!this.reasoningOpen) return []
    const text = this.reasoningBuffer.join(''),
      item = {
        id: this.reasoningId,
        type: 'reasoning',
        summary: text ? [{ type: 'summary_text', text }] : [],
        ...(this.reasoningSignature.length
          ? { encrypted_content: this.reasoningSignature.join('') }
          : {}),
      }
    this.output.push(item)
    const chunks = [
      this.event('response.reasoning_summary_text.done', {
        item_id: item.id,
        output_index: this.index,
        summary_index: 0,
        text,
      }),
      this.event('response.reasoning_summary_part.done', {
        item_id: item.id,
        output_index: this.index,
        summary_index: 0,
        part: { type: 'summary_text', text },
      }),
      this.event('response.output_item.done', {
        output_index: this.index,
        item,
      }),
    ]
    this.reasoningOpen = false
    this.reasoningBuffer = []
    this.reasoningSignature = []
    this.index++
    return chunks
  }
  private openText(): string[] {
    const chunks = [...this.closeReasoning(), ...this.closeRefusal()]
    if (this.textOpen) return chunks
    const item = {
      id: 'msg_coati',
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [outputText('')],
    }
    chunks.push(
      this.event('response.output_item.added', {
        output_index: this.index,
        item,
      }),
      this.event('response.content_part.added', {
        item_id: item.id,
        output_index: this.index,
        content_index: 0,
        part: outputText(''),
      }),
    )
    this.textOpen = true
    return chunks
  }
  private closeText(): string[] {
    if (!this.textOpen) return []
    const text = this.textBuffer.join(''),
      item = {
        id: 'msg_coati',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [outputText(text)],
      }
    this.output.push(item)
    const chunks = [
      this.event('response.output_text.done', {
        item_id: item.id,
        output_index: this.index,
        content_index: 0,
        text,
        logprobs: [],
      }),
      this.event('response.content_part.done', {
        item_id: item.id,
        output_index: this.index,
        content_index: 0,
        part: outputText(text),
      }),
      this.event('response.output_item.done', {
        output_index: this.index,
        item,
      }),
    ]
    this.textOpen = false
    this.index++
    return chunks
  }
  private openRefusal(): string[] {
    const chunks = [...this.closeReasoning(), ...this.closeText()]
    if (this.refusalOpen) return chunks
    const item = {
      id: 'msg_coati',
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [{ type: 'refusal', refusal: '' }],
    }
    chunks.push(
      this.event('response.output_item.added', {
        output_index: this.index,
        item,
      }),
      this.event('response.content_part.added', {
        item_id: item.id,
        output_index: this.index,
        content_index: 0,
        part: { type: 'refusal', refusal: '' },
      }),
    )
    this.refusalOpen = true
    return chunks
  }
  private closeRefusal(): string[] {
    if (!this.refusalOpen) return []
    const refusal = this.refusalBuffer.join(''),
      item = {
        id: 'msg_coati',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'refusal', refusal }],
      }
    this.output.push(item)
    const chunks = [
      this.event('response.refusal.done', {
        item_id: item.id,
        output_index: this.index,
        content_index: 0,
        refusal,
      }),
      this.event('response.content_part.done', {
        item_id: item.id,
        output_index: this.index,
        content_index: 0,
        part: { type: 'refusal', refusal },
      }),
      this.event('response.output_item.done', {
        output_index: this.index,
        item,
      }),
    ]
    this.refusalOpen = false
    this.refusalBuffer = []
    this.index++
    return chunks
  }
  feed(value: unknown): string {
    if (!isObject(value) || this.finished) return ''
    const obj = value
    if (obj.id) this.id = obj.id
    const out = this.started ? [] : [this.start()],
      choice = object(array(obj.choices)[0]),
      delta = object(choice.delta)
    if (truthy(delta.reasoning_content)) {
      out.push(...this.openReasoning())
      this.reasoningBuffer.push(String(delta.reasoning_content))
      out.push(
        this.event('response.reasoning_summary_text.delta', {
          item_id: this.reasoningId,
          output_index: this.index,
          summary_index: 0,
          delta: String(delta.reasoning_content),
        }),
      )
    }
    if (truthy(delta.refusal)) {
      out.push(...this.openRefusal())
      this.refusalBuffer.push(String(delta.refusal))
      out.push(
        this.event('response.refusal.delta', {
          item_id: 'msg_coati',
          output_index: this.index,
          content_index: 0,
          delta: String(delta.refusal),
        }),
      )
    }
    if (truthy(delta.content)) {
      const content =
        typeof delta.content === 'string' ? delta.content : text(delta.content)
      out.push(...this.openText())
      this.textBuffer.push(content)
      out.push(
        this.event('response.output_text.delta', {
          item_id: 'msg_coati',
          output_index: this.index,
          content_index: 0,
          delta: content,
          logprobs: [],
        }),
      )
    }
    for (const call of array(delta.tool_calls)) {
      if (!isObject(call)) continue
      out.push(
        ...this.closeReasoning(),
        ...this.closeText(),
        ...this.closeRefusal(),
      )
      const index = Number(get(call, 'index', 0)),
        fn = object(call.function)
      let item = this.tools.get(index)
      if (!item) {
        const id = call.id || `fc_${index}`
        item = {
          id,
          type: 'function_call',
          call_id: id,
          name: fn.name || '',
          arguments: '',
        }
        this.tools.set(index, item)
        this.toolIndexes.set(index, this.index++)
        out.push(
          this.event('response.output_item.added', {
            output_index: this.toolIndexes.get(index),
            item,
          }),
        )
      }
      if (fn.name) item.name = fn.name
      if (truthy(fn.arguments)) {
        const args =
          typeof fn.arguments === 'string'
            ? fn.arguments
            : pythonJson(fn.arguments)
        item.arguments = String(item.arguments) + args
        out.push(
          this.event('response.function_call_arguments.delta', {
            item_id: item.id,
            output_index: this.toolIndexes.get(index),
            delta: args,
          }),
        )
      }
    }
    if (truthy(choice.finish_reason) || (truthy(obj.usage) && !truthy(delta)))
      out.push(...this.finish(choice.finish_reason, obj.usage))
    return out.join('')
  }
  finish(reason?: unknown, usage?: unknown): string[] {
    if (this.finished) return []
    this.finished = true
    const chunks = this.started ? [] : [this.start()]
    chunks.push(
      ...this.closeReasoning(),
      ...this.closeText(),
      ...this.closeRefusal(),
    )
    for (const index of [...this.tools.keys()].sort((a, b) => a - b)) {
      const item = this.tools.get(index)!
      this.output.push(item)
      chunks.push(
        this.event('response.function_call_arguments.done', {
          item_id: item.id,
          output_index: this.toolIndexes.get(index),
          name: item.name || '',
          arguments: item.arguments || '',
        }),
        this.event('response.output_item.done', {
          output_index: this.toolIndexes.get(index),
          item,
        }),
      )
    }
    this.tools.clear()
    this.toolIndexes.clear()
    const response = responseEnvelope(
      this.id,
      this.model,
      [...this.output],
      usage,
      reason === 'length',
      this.created,
    )
    chunks.push(
      this.event(
        reason === 'length' ? 'response.incomplete' : 'response.completed',
        { response },
      ),
    )
    return chunks
  }
}
