import { normalizeUsage, mergeUsage } from './usage'
import { GatewayError, type Protocol } from './schema'
type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
export class UsageMeter {
  rawUsage: JsonObject = {}
  sourceProtocol: Protocol = 'openai'
  input: number | null = null
  output: number | null = null
  outputCharacters = 0
  finished = false
  observe(value: JsonObject, protocol: Protocol) {
    const response = object(value.response),
      message = object(value.message)
    if (
      value.error ||
      value.type === 'error' ||
      value.type === 'response.failed' ||
      value.type === 'response.error' ||
      response.status === 'failed' ||
      value.status === 'failed'
    ) {
      throw new GatewayError(
        502,
        String(
          object(value.error).message ||
            object(response.error).message ||
            '上游流式响应失败',
        ),
      )
    }
    const usage = object(value.usage || response.usage || message.usage)
    this.sourceProtocol = protocol
    this.rawUsage = mergeUsage(this.rawUsage, usage)
    const normalized = normalizeUsage(this.rawUsage, protocol)
    this.input = normalized.input
    this.output = normalized.output
    const choice = object(
      Array.isArray(value.choices) ? value.choices[0] : undefined,
    )
    const delta = object(value.delta),
      chatDelta = object(choice.delta)
    const content =
      chatDelta.content ||
      delta.text ||
      delta.partial_json ||
      (typeof value.delta === 'string' ? value.delta : '')
    this.outputCharacters += typeof content === 'string' ? content.length : 0
    if (Array.isArray(chatDelta.tool_calls))
      this.outputCharacters += JSON.stringify(chatDelta.tool_calls).length
    if (
      [
        'message_stop',
        'response.completed',
        'response.incomplete',
        'response.done',
      ].includes(String(value.type))
    )
      this.finished = true
  }
  details() {
    const {
      input: _input,
      output: _output,
      ...details
    } = normalizeUsage(this.rawUsage, this.sourceProtocol)
    return {
      ...details,
      upstream_protocol: this.sourceProtocol,
      raw_usage: structuredClone(this.rawUsage),
    }
  }
  result(promptEstimate: number) {
    return {
      input_tokens: this.input ?? promptEstimate,
      output_tokens: this.output ?? Math.ceil(this.outputCharacters / 3),
      usage_source:
        this.input !== null && this.output !== null ? 'upstream' : 'estimated',
    }
  }
}
export function rewriteModel(value: JsonObject, model: string) {
  if (typeof value.model === 'string') value.model = model
  for (const key of ['response', 'message']) {
    const nested = object(value[key])
    if (typeof nested.model === 'string') nested.model = model
  }
  return value
}
/** Parse SSE by events, preserving non-data fields and arbitrary transport chunk boundaries. */
export async function* nativeStream(
  body: AsyncIterable<Uint8Array>,
  protocol: Protocol,
  model: string,
  meter: UsageMeter,
) {
  const decoder = new TextDecoder()
  let buffer = ''
  function event(raw: string) {
    const lines = raw.split(/\r?\n/)
    const data = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n')
    if (!data) return raw + '\n\n'
    if (data === '[DONE]' && protocol === 'openai') {
      meter.finished = true
      return raw + '\n\n'
    }
    let value: JsonObject
    try {
      const parsed: unknown = JSON.parse(data)
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      )
        throw new Error('Expected object')
      value = parsed as JsonObject
    } catch {
      throw new GatewayError(502, '上游发送了无效 SSE JSON')
    }
    meter.observe(value, protocol)
    rewriteModel(value, model)
    return (
      [
        ...lines.filter((l) => !l.startsWith('data:')),
        `data: ${JSON.stringify(value)}`,
      ].join('\n') + '\n\n'
    )
  }
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    let match: RegExpExecArray | null
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const raw = buffer.slice(0, match.index)
      if (Buffer.byteLength(raw) > 1024 * 1024)
        throw new GatewayError(502, '上游 SSE 事件超过大小限制')
      buffer = buffer.slice(match.index + match[0].length)
      yield event(raw)
    }
    if (Buffer.byteLength(buffer) > 1024 * 1024)
      throw new GatewayError(502, '上游 SSE 事件超过大小限制')
  }
  buffer += decoder.decode()
  if (buffer.trim()) throw new GatewayError(502, '上游 SSE 事件不完整')
  if (!meter.finished) throw new GatewayError(502, '上游流式响应缺少结束事件')
}
export function streamError(
  protocol: Protocol,
  message: string,
  id: string,
  code = 'stream_error',
) {
  const error = {
    message,
    type: 'gateway_error',
    code,
    request_id: id,
  }
  if (protocol === 'anthropic')
    return `event: error\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`
  if (protocol === 'responses')
    return `event: error\ndata: ${JSON.stringify({ ...error, type: 'error' })}\n\n`
  return `data: ${JSON.stringify({ error })}\n\n`
}
