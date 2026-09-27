import { streamErrorMessage } from '../src/modules/gateway/protocol/compat-helpers'
import {
  bridgeRequest,
  bridgeResponse,
} from '../src/modules/gateway/protocol/bridge'
import type { Protocol } from '../src/modules/gateway/schema'
import {
  chatToAnthropicRequest,
  chatToAnthropicResponse,
} from '../src/modules/gateway/protocol/chat-anthropic'
import {
  chatToResponsesRequest,
  chatToResponsesResponse,
} from '../src/modules/gateway/protocol/chat-responses'
import {
  responsesToChatRequest,
  responsesToChatResponse,
} from '../src/modules/gateway/protocol/responses-chat'
import {
  anthropicToResponsesRequest,
  anthropicToResponsesResponse,
} from '../src/modules/gateway/protocol/anthropic-responses'
import {
  responsesToAnthropicRequest,
  responsesToAnthropicResponse,
} from '../src/modules/gateway/protocol/responses-anthropic'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  anthropicToChatRequest,
  anthropicToChatResponse,
} from '../src/modules/gateway/protocol/anthropic-chat'
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(1700000000000))
})
afterEach(() => vi.useRealTimers())
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/protocol/python-golden.json', import.meta.url),
    'utf8',
  ),
)
const protocol = (value: string): Protocol =>
  ({
    'openai-chat': 'openai',
    'anthropic-messages': 'anthropic',
    'openai-responses': 'responses',
  })[value] as Protocol
const converters: Record<string, (...args: any[]) => unknown> = {
  openai_to_anthropic_body: chatToAnthropicRequest,
  openai_to_anthropic_message: chatToAnthropicResponse,
  openai_to_responses_body: chatToResponsesRequest,
  openai_to_responses_message: chatToResponsesResponse,
  responses_to_openai_body: responsesToChatRequest,
  responses_to_openai_message: responsesToChatResponse,
  anthropic_to_responses_body: anthropicToResponsesRequest,
  anthropic_to_responses_message: anthropicToResponsesResponse,
  responses_to_anthropic_body: responsesToAnthropicRequest,
  responses_to_anthropic_message: responsesToAnthropicResponse,
  stream_error_message: streamErrorMessage,
  bridge_request_body: (body, inbound, upstream) =>
    bridgeRequest(body, inbound, protocol(upstream)),
  bridge_response_body: (body, upstream, inbound, model) =>
    bridgeResponse(body, protocol(upstream), inbound, model),
  anthropic_to_openai_body: anthropicToChatRequest,
  anthropic_to_openai_message: anthropicToChatResponse,
}
test('golden source is the unchanged Python bridge and original tests', () => {
  for (const [path, sha] of [
    ['portal/backend/app/agent/service/protocol_bridge.py', fixture.sha256],
    ['portal/backend/tests/test_protocol_bridge.py', fixture.testSha256],
  ]) {
    const source = readFileSync(new URL(`../../../${path}`, import.meta.url))
    expect(createHash('sha256').update(source).digest('hex')).toBe(sha)
  }
})
for (const [i, c] of fixture.cases.entries()) {
  const convert = converters[c.function]
  const title = `Python fixture ${i}: ${c.function} / ${c.test}`
  if (!convert) {
    test.todo(title)
    continue
  }
  test(title, () => {
    const original = structuredClone(c.args)
    const args = structuredClone(c.args)
    if (c.kwargs.client_model !== undefined) args.push(c.kwargs.client_model)
    if (c.error) expect(() => convert(...args)).toThrow(c.error)
    else expect(convert(...args)).toEqual(c.expected)
    expect(args.slice(0, c.args.length)).toEqual(original)
  })
}
