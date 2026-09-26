import { GatewayError } from '../schema'
import { array, object, type Obj } from './compat-helpers'
import { sse } from './stream-source'

/** Holds later content behind an announced reasoning item until its signature is known. */
export async function* orderReasoningFrames(
  source: AsyncIterable<string>,
  limit = 16 * 1024 * 1024,
): AsyncGenerator<string> {
  const queue: { raw: string; value: Obj }[] = []
  const completed = new Map<unknown, string>()
  const emitted = new Set<unknown>()
  let cursor = 0,
    bytes = 0
  const key = (value: Obj) =>
    value.output_index ?? object(value.item).id ?? value.item_id
  for await (const raw of source) {
    bytes += Buffer.byteLength(raw)
    if (bytes > limit)
      throw new GatewayError(502, '协议转换流超过缓冲上限', 'stream_limit')
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    const value = object(data && data !== '[DONE]' ? JSON.parse(data) : {})
    queue.push({ raw, value })
    if (
      value.type === 'response.output_item.done' &&
      object(value.item).type === 'reasoning' &&
      !completed.has(key(value))
    )
      completed.set(key(value), raw)
    if (
      ['response.completed', 'response.incomplete', 'response.done'].includes(
        String(value.type),
      )
    ) {
      for (const [index, item] of array(
        object(value.response).output,
      ).entries()) {
        if (object(item).type === 'reasoning' && !completed.has(index))
          completed.set(
            index,
            sse('response.output_item.done', {
              type: 'response.output_item.done',
              output_index: index,
              item,
            }),
          )
      }
    }
    while (cursor < queue.length) {
      const frame = queue[cursor]!,
        id = key(frame.value)
      if (
        frame.value.type === 'response.output_item.added' &&
        object(frame.value.item).type === 'reasoning'
      ) {
        const done = completed.get(id)
        if (!done) break
        yield frame.raw
        yield done
        emitted.add(id)
      } else if (
        !(
          String(frame.value.type).startsWith('response.reasoning_') &&
          emitted.has(id)
        )
      )
        yield frame.raw
      cursor++
    }
    // Drop consumed frames; only blocked content and completed reasoning snapshots remain.
    if (cursor) {
      queue.splice(0, cursor)
      cursor = 0
    }
  }
  if (queue.length)
    throw new GatewayError(502, '协议转换缺少上游结束事件', 'truncated_stream')
}

/** Keep each Messages thinking block contiguous without delaying its own deltas. */
export async function* orderThinkingFrames(
  source: AsyncIterable<string>,
  limit = 16 * 1024 * 1024,
): AsyncGenerator<string> {
  const queue: { raw: string; value: Obj }[] = []
  const thinking = new Map<unknown, 'open' | 'closed'>()
  let active: unknown = undefined,
    bytes = 0
  const invalid = () =>
    new GatewayError(502, '上游推理块序列无效', 'invalid_response')
  for await (const raw of source) {
    bytes += Buffer.byteLength(raw)
    if (bytes > limit)
      throw new GatewayError(502, '协议转换流超过缓冲上限', 'stream_limit')
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    const value = object(data && data !== '[DONE]' ? JSON.parse(data) : {})
    if (value.type === 'content_block_start') {
      if (thinking.has(value.index)) throw invalid()
      if (object(value.content_block).type === 'thinking') {
        if (!Number.isInteger(value.index) || Number(value.index) < 0)
          throw invalid()
        thinking.set(value.index, 'open')
      }
    }
    if (
      value.type === 'content_block_delta' &&
      ['thinking_delta', 'signature_delta'].includes(
        String(object(value.delta).type),
      ) &&
      thinking.get(value.index) !== 'open'
    )
      throw invalid()
    if (value.type === 'content_block_stop' && thinking.has(value.index)) {
      if (thinking.get(value.index) !== 'open') throw invalid()
      thinking.set(value.index, 'closed')
    }
    queue.push({ raw, value })
    while (queue.length) {
      const at =
        active === undefined
          ? 0
          : queue.findIndex(
              (frame) =>
                frame.value.index === active &&
                ['content_block_delta', 'content_block_stop'].includes(
                  String(frame.value.type),
                ),
            )
      if (at < 0) break
      const [frame] = queue.splice(at, 1)
      if (
        frame!.value.type === 'content_block_start' &&
        object(frame!.value.content_block).type === 'thinking'
      )
        active = frame!.value.index
      yield frame!.raw
      if (
        frame!.value.type === 'content_block_stop' &&
        frame!.value.index === active
      )
        active = undefined
    }
  }
  if (active !== undefined || queue.length)
    throw new GatewayError(502, '协议转换缺少上游结束事件', 'truncated_stream')
}
