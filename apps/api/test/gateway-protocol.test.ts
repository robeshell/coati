import { expect, test } from 'vitest'
import { assertResponseContent } from '../src/modules/gateway/protocol/response-controls'
import { bridgeRequest as convertRequest } from '../src/modules/gateway/protocol/bridge'
const bridgeRequest: typeof convertRequest = (body, source, target, options = {}) => convertRequest(body, source, target, { compatibilityPolicy: 'strict', ...options })
import { EventGuard } from '../src/modules/gateway/protocol/event-guard'
import {
  matrix,
} from '../src/modules/gateway/protocol/matrix'
import type { Event } from '../src/modules/gateway/protocol/contracts'
const start: Event = { type: 'start', id: 'r1', publicModel: 'public-model' }
const finish: Event = { type: 'finish', reason: 'stop' }
function replay(events: Event[]) {
  const guard = new EventGuard()
  for (const event of events) guard.accept(event)
  guard.end()
}
test('interleaved tool argument streams preserve independent blocks', () => {
  replay([
    start,
    {
      type: 'block_start',
      index: 0,
      block: { type: 'tool_call', id: 'a', name: 'weather', arguments: '' },
    },
    { type: 'block_start', index: 1, block: { type: 'text', text: '' } },
    { type: 'delta', index: 0, kind: 'tool_arguments', value: '{"city":' },
    { type: 'delta', index: 1, kind: 'text', value: '你好' },
    { type: 'delta', index: 0, kind: 'tool_arguments', value: '"上海"}' },
    { type: 'block_end', index: 1 },
    { type: 'block_end', index: 0 },
    {
      type: 'usage',
      usage: {
        input: 12,
        output: 3,
        cacheRead: 4,
        cacheWrite: 2,
        source: 'upstream',
      },
    },
    { type: 'finish', reason: 'tool_calls' },
  ])
})
test.each([
  [finish],
  [start, start],
  [start],
  [start, finish, finish],
  [start, { type: 'delta', index: 0, kind: 'text', value: 'x' }],
  [
    start,
    { type: 'block_start', index: 0, block: { type: 'text', text: '' } },
    finish,
  ],
  [
    start,
    {
      type: 'usage',
      usage: { input: 2, output: 1, cacheRead: 3, source: 'upstream' },
    },
  ],
  [
    start,
    { type: 'usage', usage: { input: -1, output: 1, source: 'estimated' } },
  ],
] satisfies Event[][])('reject invalid lifecycle %#', (...events) => {
  expect(() => replay(events)).toThrow()
})
test('error terminates open blocks without manufacturing a successful finish', () => {
  replay([
    start,
    { type: 'block_start', index: 0, block: { type: 'text', text: '' } },
    {
      type: 'error',
      error: {
        code: 'cancelled',
        message: 'Cancelled',
        requestId: 'r1',
        retryable: false,
      },
    },
  ])
})
// Wire acceptance obligations are implemented in gateway-matrix.test.ts for all
// nine JSON/SSE pairs, including explicit extension-policy checks. Provider-specific
// capabilities outside this checked contract remain separate release evidence.

// Check each control independently so one rejected field cannot hide another loss.
test('nonportable request controls never disappear during bridging', () => {
  const controls = {
    openai: { seed: 0, frequency_penalty: 0.5, presence_penalty: -0.5, logprobs: false, top_logprobs: 2, prediction: { type: 'content', content: 'fixture' }, audio: { voice: 'fixture' }, modalities: ['text'] },
    anthropic: { top_k: 20 },
  }
  for (const inbound of ['openai', 'anthropic'] as const)
    for (const [field, value] of Object.entries(controls[inbound])) {
      const body = { model: 'fixture', messages: [{ role: 'user', content: 'hello' }], [field]: value }
      expect(bridgeRequest(body, inbound, inbound)).toEqual(body)
      for (const upstream of ['openai', 'responses', 'anthropic'] as const)
        if (upstream !== inbound)
          expect(() => bridgeRequest(body, inbound, upstream)).toThrow(field)
    }
})

test('reasoning effort maps between Chat and Responses without inventing a budget', () => {
  for (const effort of ['low', 'medium', 'high']) {
    expect(bridgeRequest({ model: 'm', messages: [], reasoning_effort: effort }, 'openai', 'responses').reasoning).toEqual({ effort })
    expect(bridgeRequest({ model: 'm', input: 'hello', reasoning: { effort } }, 'responses', 'openai').reasoning_effort).toBe(effort)
  }
})

test('unrepresentable nested controls fail explicitly and native requests remain intact', () => {
  const cases = [
    ['anthropic', { output_config: { effort: 'high' } }, 'output_config'],
    ['anthropic', { system: [{ type: 'text', text: 'PRIVATE', cache_control: { type: 'ephemeral' } }] }, 'cache_control'],
    ['anthropic', { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'image', source: { type: 'url', url: 'PRIVATE' } }] }] }] }, 'content.type'],
    ['openai', { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'PRIVATE' } }] }] }, 'content.type'],
    ['responses', { input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'PRIVATE' }] }] }, 'content.type'],
    ['responses', { reasoning: { effort: 'high', summary: 'auto' } }, 'reasoning'],
    ['responses', { text: { verbosity: 'low' } }, 'verbosity'],
  ] as const
  for (const [source, fields, field] of cases) {
    const body = { model: 'm', ...fields }
    expect(bridgeRequest(body, source, source)).toEqual(body)
    for (const target of ['openai', 'responses', 'anthropic'] as const) {
      if (target === source) continue
      expect(() => bridgeRequest(body, source, target)).toThrow(field)
      try { bridgeRequest(body, source, target) } catch (error) {
        expect(String(error)).not.toContain('PRIVATE')
      }
    }
  }
})

test('tool control validation never scans user schema properties', () => {
  const parameters = { type: 'object', properties: { cache_control: { type: 'string' }, thinking: { type: 'boolean' } } }
  const body = { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'fixture', parameters, strict: false } }] }
  const mapped = bridgeRequest(body, 'openai', 'anthropic')
  expect((mapped.tools as any[])[0]).toMatchObject({ input_schema: parameters, strict: false })
  for (const field of ['cache_control', 'defer_loading', 'allowed_callers', 'input_examples']) {
    const input = { ...body, tools: [{ type: 'function', function: { ...body.tools[0]!.function, [field]: false } }] }
    expect(() => bridgeRequest(input, 'openai', 'anthropic')).toThrow(field)
    expect(bridgeRequest(input, 'openai', 'openai')).toEqual(input)
  }
})

test('failed Messages tools retain an explicit error marker for Chat and Responses', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'denied' }] }] }
  const chat = bridgeRequest(body, 'anthropic', 'openai')
  const responses = bridgeRequest(body, 'anthropic', 'responses')
  expect(JSON.parse((chat.messages as any[])[0].content)).toEqual({ is_error: true, content: 'denied' })
  expect(JSON.parse((responses.input as any[])[0].output)).toEqual({ is_error: true, content: 'denied' })
})

test('image detail survives Chat/Responses conversion and refuses incompatible Messages control', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png', detail: 'high' } }] }] }
  const responses = bridgeRequest(body, 'openai', 'responses')
  expect((responses.input as any[])[0].content[0].detail).toBe('high')
  const chat = bridgeRequest(responses, 'responses', 'openai')
  expect((chat.messages as any[])[0].content[0].image_url.detail).toBe('high')
  expect(() => bridgeRequest(body, 'openai', 'anthropic')).toThrow('detail')
  expect(() => bridgeRequest(responses, 'responses', 'anthropic')).toThrow('detail')
})

test('unknown request extensions are refused only on cross-protocol paths', () => {
  for (const pair of matrix) {
    const body = { model: 'fixture', private_vendor_option: 'PRIVATE' }
    if (pair.inbound === pair.upstream) expect(bridgeRequest(body, pair.inbound, pair.upstream)).toEqual(body)
    else expect(() => bridgeRequest(body, pair.inbound, pair.upstream)).toThrow('unrecognized_request_field')
  }
})
test('unknown output blocks and citations are never silently discarded in JSON or event payloads', () => {
  const samples = {
    openai: [{ choices: [{ message: { audio: { data: 'PRIVATE' } } }] }, { choices: [{ delta: { annotations: [{ url: 'PRIVATE' }] } }] }],
    anthropic: [{ content: [{ type: 'future_block', data: 'PRIVATE' }] }, { type: 'content_block_start', content_block: { type: 'text', text: 'hello', citations: [{ url: 'PRIVATE' }] } }],
    responses: [{ output: [{ type: 'future_call', data: 'PRIVATE' }] }, { type: 'response.future.delta', delta: 'PRIVATE' }],
  }
  for (const pair of matrix) for (const body of samples[pair.upstream]) {
    if (pair.inbound === pair.upstream) expect(() => assertResponseContent(body, pair.upstream, pair.inbound)).not.toThrow()
    else {
      expect(() => assertResponseContent(body, pair.upstream, pair.inbound)).toThrow('无法保留')
      try { assertResponseContent(body, pair.upstream, pair.inbound) } catch(error) { expect(String(error)).not.toContain('PRIVATE') }
    }
  }
})

// DeepSeek Responses emits reasoning_text parts alongside reasoning_text deltas.
test('Responses reasoning text parts are accepted for bridge reasoning policy', () => {
  for (const type of ['response.content_part.added', 'response.content_part.done'])
    for (const target of ['openai', 'anthropic'] as const)
      expect(() => assertResponseContent({ type, part: { type: 'reasoning_text', text: 'Reasoning' } }, 'responses', target)).not.toThrow()
})

test('Messages thinking follows the Python medium approximation for Responses', () => {
  for (const type of ['enabled', 'adaptive']) {
    const body = { model: 'm', messages: [], thinking: { type, budget_tokens: 2048 } }
    expect(bridgeRequest(body, 'anthropic', 'responses').reasoning).toEqual({ effort: 'medium' })
    expect(() => bridgeRequest(body, 'anthropic', 'openai')).not.toThrow()
  }
})

test('default Python compatibility drops unknown controls while strict remains selectable', () => {
  const body = { model: 'm', messages: [], custom_vendor_option: true, seed: 7 }
  expect(convertRequest(body, 'openai', 'anthropic')).not.toHaveProperty('custom_vendor_option')
  expect(() => convertRequest(body, 'openai', 'anthropic', { compatibilityPolicy: 'strict' })).toThrow()
})
