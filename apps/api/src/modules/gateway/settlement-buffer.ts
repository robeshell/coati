import { GatewayError, type Protocol } from './schema'

// These close a content block, not the whole response. They may be delivered
// before accounting commits; the response-level completion must remain held.
const contentEnds = new Set([
  'response.output_text.done',
  'response.content_part.done',
  'response.output_item.done',
  'response.function_call_arguments.done',
  'response.reasoning_summary_text.done',
  'response.reasoning_summary_part.done',
  'response.refusal.done',
])

export class SettlementBuffer {
  private pending: string[] = []
  private bytes = 0
  constructor(private limit = 1024 * 1024) {}

  *accept(chunk: string, protocol: Protocol): Generator<string> {
    for (const raw of chunk.split(/\r?\n\r?\n/)) {
      if (!raw.trim()) continue
      const frame = raw + '\n\n'
      const size = Buffer.byteLength(frame)
      if (size > this.limit)
        throw new GatewayError(502, '上游 SSE 事件超过大小限制')
      let type: unknown
      if (protocol === 'responses' && this.pending.length === 0) {
        const data = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        try {
          type = JSON.parse(data).type
        } catch {
          /* Keep unrecognized frames behind settlement. */
        }
      }
      if (typeof type === 'string' && contentEnds.has(type)) yield frame
      else {
        if (this.bytes + size > this.limit)
          throw new GatewayError(502, '上游 SSE 事件超过大小限制')
        this.pending.push(frame)
        this.bytes += size
      }
    }
  }

  release(): string {
    const result = this.pending.join('')
    this.pending = []
    this.bytes = 0
    return result
  }
}
