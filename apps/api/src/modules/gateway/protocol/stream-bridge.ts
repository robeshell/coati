import { assertResponseContent } from './response-controls'
import {
  assertAnthropicOpaqueContent,
  assertChatReasoning,
  type BridgeOptions,
} from './opaque-content'
import { orderReasoningFrames, orderThinkingFrames } from './reasoning-order'
import { GatewayError, type Protocol } from '../schema'
import { UsageMeter, nativeStream } from '../stream'
import { usageForProtocol } from '../usage'
import { type Obj, object, isObject, array, truthy } from './compat-helpers'
import {
  AnthropicToOpenAIStream,
  ResponsesToOpenAIStream,
  chatChunk,
  done,
} from './stream-source'
import {
  OpenAIToAnthropicStream,
  OpenAIToResponsesStream,
  type TargetStream,
} from './stream-target'
/** Stateful adaptation is bounded independently of individual upstream SSE event limits. */
const MAX_BRIDGE_BYTES = 16 * 1024 * 1024
function payload(raw: string): unknown {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return undefined
  if (data === '[DONE]') return data
  return JSON.parse(data)
}
function finalChatUsage(
  meter: UsageMeter,
  upstream: Protocol,
): Obj | undefined {
  if (!Object.keys(meter.rawUsage).length) return undefined
  return usageForProtocol(meter.rawUsage, upstream, 'openai')
}
/** Do not flush adapters at transport EOF: nativeStream must validate the actual source terminal first. */
export async function* bridgeStream(
  body: AsyncIterable<Uint8Array>,
  upstream: Protocol,
  inbound: Protocol,
  model: string,
  meter: UsageMeter,
  options: BridgeOptions = {},
): AsyncGenerator<string> {
  if (upstream === inbound) {
    yield* nativeStream(body, upstream, model, meter)
    return
  }
  const source =
    upstream === 'anthropic'
      ? new AnthropicToOpenAIStream(model)
      : upstream === 'responses'
        ? new ResponsesToOpenAIStream(model)
        : null
  const target: TargetStream | null =
    inbound === 'anthropic'
      ? new OpenAIToAnthropicStream(model)
      : inbound === 'responses'
        ? new OpenAIToResponsesStream(model)
        : null
  const signedThinking = new Set<unknown>()
  const pendingReasoning = new Set<unknown>()
  const completedReasoning = new Map<
    unknown,
    { text: string; signature: string }
  >()
  const reasoningAliases = new Map<unknown, unknown>()
  const reasoningConflict = () =>
    new GatewayError(502, '上游推理完成数据不一致', 'invalid_response')
  let bytes = 0,
    finishReason: unknown = null,
    id: unknown = 'chatcmpl_coati',
    sawDone = false
  const convertChat = (value: unknown): string => {
    if (value === '[DONE]') {
      sawDone = true
      return ''
    }
    if (!isObject(value)) return ''
    if (value.id) id = value.id
    const choices = array(value.choices)
    if (choices.length > 1)
      throw new GatewayError(
        502,
        '协议转换不支持多候选流式响应',
        'unsupported_feature',
      )
    const choice = object(choices[0]),
      delta = object(choice.delta)
    if (choice.finish_reason) finishReason = choice.finish_reason
    // Preserve content now, but defer all finish and usage emission until the source
    // terminal is validated. Chat usage commonly arrives AFTER finish_reason.
    const clean = {
      ...value,
      model,
      choices: choices.map((c) => ({ ...object(c), finish_reason: null })),
    }
    delete (clean as Obj).usage
    if (!truthy(delta)) return ''
    if (!target) return chatChunk(id, model, delta)
    // The legacy target starts Anthropic streams with fabricated zero usage.
    // Only expose counters already reported by the source at this point.
    return target
      .feed(clean)
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => {
        const event = payload(frame)
        if (!isObject(event) || event.type !== 'message_start')
          return frame + '\n\n'
        const message = object(event.message)
        message.usage = usageForProtocol(meter.rawUsage, upstream, inbound)
        return (
          frame
            .split('\n')
            .filter((line) => !line.startsWith('data:'))
            .join('\n') +
          '\ndata: ' +
          JSON.stringify(event) +
          '\n\n'
        )
      })
      .join('')
  }
  const reasoningKey = (item: Obj, event: Obj) => {
    const id = item.id ?? event.item_id
    if (event.output_index !== undefined && id !== undefined) {
      const known = reasoningAliases.get(event.output_index)
      if (known !== undefined && known !== id) throw reasoningConflict()
      reasoningAliases.set(event.output_index, id)
    }
    return id ?? reasoningAliases.get(event.output_index) ?? event.output_index
  }
  const completeReasoning = (item: Obj, event: Obj): string => {
    const key = reasoningKey(item, event)
    pendingReasoning.delete(key)
    if (!(target instanceof OpenAIToAnthropicStream)) return ''
    const text = array(item.summary ?? item.content)
      .map((part) => String(object(part).text || ''))
      .join('')
    const signature =
      typeof item.encrypted_content === 'string' ? item.encrypted_content : ''
    const previous = completedReasoning.get(key)
    if (previous) {
      if (previous.text !== text || previous.signature !== signature)
        throw reasoningConflict()
      return ''
    }
    completedReasoning.set(key, { text, signature })
    // Start through the ordinary path so unknown usage is never fabricated as zero.
    return (
      convertChat({ choices: [{ delta: { role: 'assistant' } }] }) +
      target.completeReasoning(text, signature)
    )
  }
  const native = nativeStream(body, upstream, model, meter)
  const needsResponseOrdering =
    upstream === 'responses' && inbound === 'anthropic'
  const needsThinkingOrdering =
    upstream === 'anthropic' && inbound === 'responses'
  const needsOrdering = needsResponseOrdering || needsThinkingOrdering
  const ordered = needsResponseOrdering
    ? orderReasoningFrames(native, MAX_BRIDGE_BYTES)
    : needsThinkingOrdering
      ? orderThinkingFrames(native, MAX_BRIDGE_BYTES)
      : native
  for await (const raw of ordered) {
    // The ordering layer counts original frames before buffering; do not count its
    // synthesized item completions as additional supplier bytes.
    if (!needsOrdering) {
      bytes += Buffer.byteLength(raw)
      if (bytes > MAX_BRIDGE_BYTES)
        throw new GatewayError(502, '协议转换流超过缓冲上限', 'stream_limit')
    }
    const value = payload(raw)
    if (value === undefined) continue
    if (options.compatibilityPolicy === 'strict') assertResponseContent(value, upstream, inbound)
    if (upstream === 'anthropic') assertAnthropicOpaqueContent(value)
    if (inbound === 'openai') assertChatReasoning(value, upstream, options)
    if (
      upstream === 'responses' &&
      target instanceof OpenAIToAnthropicStream &&
      isObject(value)
    ) {
      const item = object(value.item)
      if (
        value.type === 'response.output_item.added' &&
        item.type === 'reasoning'
      )
        pendingReasoning.add(reasoningKey(item, value))
      if (String(value.type).startsWith('response.reasoning_')) {
        pendingReasoning.add(reasoningKey({}, value))
        continue
      }
      if (
        value.type === 'response.output_item.done' &&
        item.type === 'reasoning'
      ) {
        yield completeReasoning(item, value)
        continue
      }
      if (
        ['response.completed', 'response.incomplete', 'response.done'].includes(
          String(value.type),
        )
      ) {
        for (const [index, output] of array(
          object(value.response).output,
        ).entries()) {
          const item = object(output)
          if (item.type === 'reasoning')
            yield completeReasoning(item, { output_index: index })
        }
        if (pendingReasoning.size)
          throw new GatewayError(
            502,
            '协议转换缺少上游结束事件',
            'truncated_stream',
          )
      }
    }
    if (
      upstream === 'anthropic' &&
      target instanceof OpenAIToResponsesStream &&
      isObject(value)
    ) {
      const block = object(value.content_block),
        delta = object(value.delta)
      if (value.type === 'content_block_start' && block.type === 'thinking') {
        signedThinking.add(value.index)
        yield target.feedSignedReasoning(
          String(block.thinking || ''),
          String(block.signature || ''),
        )
        continue
      }
      if (signedThinking.has(value.index)) {
        if (value.type === 'content_block_delta') {
          if (delta.type === 'thinking_delta')
            yield target.feedSignedReasoning(String(delta.thinking || ''))
          if (delta.type === 'signature_delta')
            yield target.feedSignedReasoning('', String(delta.signature || ''))
          continue
        }
        if (value.type === 'content_block_stop') {
          yield target.feedSignedReasoning('', '', true)
          signedThinking.delete(value.index)
          continue
        }
      }
    }
    if (!source) {
      const out = convertChat(value)
      if (out) yield out
    } else {
      const event = raw
        .split(/\r?\n/)
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim()
      const intermediate = value === '[DONE]' ? '' : source.feed(value, event)
      for (const frame of intermediate.split(/\n\n/)) {
        if (!frame.trim()) continue
        const out = convertChat(payload(frame))
        if (out) yield out
      }
    }
  }
  if (
    signedThinking.size ||
    pendingReasoning.size ||
    !meter.finished ||
    !sawDone
  )
    throw new GatewayError(502, '协议转换缺少上游结束事件', 'truncated_stream')
  const usage = finalChatUsage(meter, upstream)
  if (target) {
    const terminal = target.feed({
      id,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason || 'stop' }],
      ...(usage ? { usage } : {}),
    })
    const details = usageForProtocol(meter.rawUsage, upstream, inbound)
    yield terminal
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => {
        const value = payload(frame)
        if (!isObject(value)) return frame + '\n\n'
        if (value.type === 'message_delta') value.usage = details
        if (
          value.type === 'response.completed' ||
          value.type === 'response.incomplete'
        ) {
          const response = object(value.response)
          response.usage = details
        }
        return (
          frame
            .split('\n')
            .filter((line) => !line.startsWith('data:'))
            .join('\n') +
          '\ndata: ' +
          JSON.stringify(value) +
          '\n\n'
        )
      })
      .join('')
  } else {
    yield chatChunk(id, model, {}, finishReason || 'stop', usage)
    yield done()
  }
}
