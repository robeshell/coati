import { expect, test } from 'vitest'
import { requestContext } from '../src/modules/gateway/request-context'
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
test('context counts UTF-8 bytes, nested images and tool results without storing bodies', () => {
  const tool = {
    role: 'tool',
    content: [{ type: 'tool_result', content: 'private工具' }],
  }
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'private-image' } },
          { type: 'text', text: '秘密' },
        ],
      },
      tool,
    ],
    tools: [{ type: 'function' }],
  }
  const result = requestContext(body, {}, 'fixture-secret')
  expect(result).toMatchObject({
    context_bytes: size(body),
    message_count: 2,
    tool_count: 1,
    image_count: 1,
    tool_result_bytes: size(tool),
    largest_message_bytes: Math.max(...body.messages.map(size)),
    session_source: 'fingerprint',
  })
  expect(result.session_id).toMatch(/^msg_[a-f0-9]{60}$/)
  expect(JSON.stringify(result)).not.toContain('private')
  expect(JSON.stringify(result)).not.toContain('秘密')
})
test('trace precedence, normalization and bounded indices match legacy headers', () => {
  const result = requestContext(
    { session_id: 'body' },
    {
      'x-coati-session-id': ' header ',
      'x-coati-step': '-2',
      'x-agent-retry': '101',
      'x-client-request-id': 'x'.repeat(140),
    },
    'secret',
  )
  expect(result).toMatchObject({
    session_id: 'header',
    session_source: 'header',
    step_index: 0,
    retry_index: 100,
    client_request_id: 'x'.repeat(128),
  })
  expect(
    requestContext({ conversation: { id: 'body' } }, {}, 'secret'),
  ).toMatchObject({ session_id: 'body', session_source: 'body' })
  expect(
    requestContext(
      {},
      { 'x-coati-session-id': 'x'.repeat(100), 'x-coati-step': '1.5' },
      'secret',
    ),
  ).toMatchObject({
    session_id: expect.stringMatching(/^id_[a-f0-9]{61}$/),
    step_index: null,
  })
})
test('fingerprints are stable across followups and vary with secret/system; Responses tool output counted once', () => {
  const first = { input: [{ role: 'user', content: 'hello' }] }
  const initial = requestContext(first, {}, 'secret')
  expect(
    requestContext(
      { input: [...first.input, { role: 'assistant', content: 'reply' }] },
      {},
      'secret',
    ).session_id,
  ).toBe(initial.session_id)
  expect(requestContext(first, {}, 'other').session_id).not.toBe(
    initial.session_id,
  )
  expect(
    requestContext({ ...first, instructions: 'different' }, {}, 'secret')
      .session_id,
  ).not.toBe(initial.session_id)
  const output = { type: 'function_call_output', output: 'secret result' }
  expect(requestContext({ input: [output] }, {}, 'secret')).toMatchObject({
    tool_result_bytes: size(output),
    session_id: null,
  })
})
