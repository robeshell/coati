import { assertResponseContent } from './response-controls'
import { assertRequestControls, preserveReasoningControl } from './request-controls'
import { preserveParallelTools, preserveStrictTools } from './tool-controls'
import {
  assertAnthropicOpaqueContent,
  assertChatReasoning,
  type BridgeOptions,
} from './opaque-content'
import type { Protocol } from '../schema'
import { object, type Obj, ProtocolBridgeError } from './compat-helpers'
import {
  anthropicToChatRequest,
  anthropicToChatResponse,
} from './anthropic-chat'
import {
  chatToAnthropicRequest,
  chatToAnthropicResponse,
} from './chat-anthropic'
import {
  chatToResponsesRequest,
  chatToResponsesResponse,
} from './chat-responses'
import {
  responsesToChatRequest,
  responsesToChatResponse,
} from './responses-chat'
import {
  anthropicToResponsesRequest,
  anthropicToResponsesResponse,
} from './anthropic-responses'
import {
  responsesToAnthropicRequest,
  responsesToAnthropicResponse,
} from './responses-anthropic'
const requests: Record<string, (body: unknown) => Obj> = {
  'anthropic:openai': anthropicToChatRequest,
  'openai:anthropic': chatToAnthropicRequest,
  'openai:responses': chatToResponsesRequest,
  'responses:openai': responsesToChatRequest,
  'anthropic:responses': anthropicToResponsesRequest,
  'responses:anthropic': responsesToAnthropicRequest,
}
const responses: Record<string, (body: unknown, model?: string) => Obj> = {
  'anthropic:openai': anthropicToChatResponse,
  'openai:anthropic': chatToAnthropicResponse,
  'openai:responses': chatToResponsesResponse,
  'responses:openai': responsesToChatResponse,
  'anthropic:responses': anthropicToResponsesResponse,
  'responses:anthropic': responsesToAnthropicResponse,
}
export function bridgeRequest(
  body: unknown,
  inbound: Protocol,
  upstream: Protocol,
  options: BridgeOptions = {},
): Obj {
  if (inbound === upstream) return { ...object(body) }
  const request = object(body)
  const strict = options.compatibilityPolicy === 'strict'
  if (strict) assertRequestControls(request, inbound, upstream)
  // These controls have no representation in the current cross-protocol path.
  // Native paths above retain the original provider contract unchanged.
  const unsupported = (
    inbound === 'openai'
      ? [
          'logit_bias', 'seed', 'frequency_penalty', 'presence_penalty',
          'logprobs', 'top_logprobs', 'prediction', 'audio', 'modalities',
        ]
      : inbound === 'anthropic'
        ? ['container', 'top_k']
        : []
  ).filter((key) => request[key] != null)
  if (strict && unsupported.length)
    throw new ProtocolBridgeError(
      `当前协议转换无法保留参数 ${unsupported.join(', ')}，请使用相同协议的上游路由`,
    )
  const stopField = inbound === 'anthropic' ? 'stop_sequences' : 'stop'
  if (strict && upstream === 'responses' && request[stopField] != null)
    throw new ProtocolBridgeError(
      '当前 Responses 转换无法保留停止序列，请使用 Chat 或 Messages 路由',
    )
  const format = object(object(request.text).format)
  if (
    strict && inbound === 'responses' &&
    upstream === 'anthropic' &&
    format.type &&
    format.type !== 'text'
  )
    throw new ProtocolBridgeError(
      '当前 Messages 转换无法保留结构化输出格式，请使用 Chat 或 Responses 路由',
    )
  if (inbound === 'anthropic') assertAnthropicOpaqueContent(body)
  if (upstream === 'openai') assertChatReasoning(body, inbound, options)
  const convert = requests[`${inbound}:${upstream}`]
  if (!convert)
    throw new ProtocolBridgeError(
      `Unsupported request conversion: ${inbound} -> ${upstream}`,
    )
  return preserveStrictTools(
    request,
    preserveParallelTools(request, preserveReasoningControl(request, convert(body), inbound, upstream), inbound, upstream),
    inbound,
    upstream,
  )
}
export function bridgeResponse(
  body: unknown,
  upstream: Protocol,
  inbound: Protocol,
  clientModel?: string,
  options: BridgeOptions = {},
): Obj {
  if (inbound === upstream) return object(body)
  if (options.compatibilityPolicy === 'strict') assertResponseContent(body, upstream, inbound)
  if (upstream === 'anthropic') assertAnthropicOpaqueContent(body)
  if (inbound === 'openai') assertChatReasoning(body, upstream, options)
  const convert = responses[`${upstream}:${inbound}`]
  if (!convert)
    throw new ProtocolBridgeError(
      `Unsupported response conversion: ${upstream} -> ${inbound}`,
    )
  return convert(body, clientModel)
}
