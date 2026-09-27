import { array, object, ProtocolBridgeError } from './compat-helpers'

/** Only inspect protocol content blocks, never arbitrary tool arguments or schemas. */
export function assertAnthropicOpaqueContent(raw: unknown): void {
  const body = object(raw)
  const blocks = [
    ...array(body.content),
    ...array(body.messages).flatMap((message) =>
      array(object(message).content),
    ),
  ]
  if (body.type === 'message_start')
    blocks.push(...array(object(body.message).content))
  if (body.type === 'content_block_start') blocks.push(body.content_block)
  if (blocks.some((block) => object(block).type === 'redacted_thinking'))
    throw new ProtocolBridgeError(
      '跨协议转换不支持 redacted_thinking，请使用 Messages 原生路由',
    )
}

export type ReasoningPolicy = 'preserve' | 'text-only'
export interface BridgeOptions {
  compatibilityPolicy?: 'python' | 'strict'
  reasoningPolicy?: ReasoningPolicy
}
/** Chat has no portable opaque reasoning field; text-only is an explicit lossy choice. */
export function assertChatReasoning(
  raw: unknown,
  source: 'openai' | 'responses' | 'anthropic',
  options: BridgeOptions = {},
): void {
  if (source === 'openai' || options.reasoningPolicy === 'text-only') return
  const body = object(raw)
  const blocks = [
    ...array(body.content),
    ...array(object(body.message).content),
    ...array(body.messages).flatMap((message) =>
      array(object(message).content),
    ),
    body.content_block,
  ]
  const signedMessages =
    source === 'anthropic' &&
    (blocks.some(
      (block) =>
        object(block).type === 'thinking' && Boolean(object(block).signature),
    ) ||
      (object(body.delta).type === 'signature_delta' &&
        Boolean(object(body.delta).signature)))
  const items = [
    ...array(body.input),
    ...array(body.output),
    ...array(object(body.response).output),
    body.item,
  ]
  const signedResponses =
    source === 'responses' &&
    items.some(
      (item) =>
        object(item).type === 'reasoning' &&
        Boolean(object(item).encrypted_content),
    )
  if (signedMessages || signedResponses)
    throw new ProtocolBridgeError(
      'Chat 转换无法保留推理签名，请使用原生协议或显式选择 text-only 模式',
    )
}
