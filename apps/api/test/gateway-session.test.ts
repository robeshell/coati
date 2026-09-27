import { createHmac } from 'node:crypto'
import { test, expect } from 'vitest'
import { sessionScope, explicitSessionId, affinityModelKey } from '../src/modules/gateway/session-affinity'
test('explicit headers take precedence; prompt similarity never creates affinity', () => {
  const scope = sessionScope(
    1,
    'model',
    { session_id: 'body' },
    { 'x-coati-session-id': 'header' },
    'secret',
  )
  expect(scope).toBe(
    sessionScope(1, 'model', { session_id: 'header' }, {}, 'secret'),
  )
  expect(scope).not.toContain('header')
  expect(
    sessionScope(
      1,
      'model',
      { messages: [{ role: 'user', content: 'same' }] },
      {},
      'secret',
    ),
  ).toBeUndefined()
})
test('binding scope isolates users/models and accepts legacy body aliases', () => {
  const a = sessionScope(1, 'model', { prompt_cache_key: 'a' }, {}, 'secret')
  expect(a).toBe(
    sessionScope(1, 'model', { conversation: { id: 'a' } }, {}, 'secret'),
  )
  expect(a).not.toBe(
    sessionScope(2, 'model', { session_id: 'a' }, {}, 'secret'),
  )
  expect(a).not.toBe(
    sessionScope(1, 'other', { session_id: 'a' }, {}, 'secret'),
  )
})

test('long identifiers follow Python HMAC normalization and mappings isolate bindings', () => {
  const long = 'a'.repeat(65)
  expect(explicitSessionId({ session_id: long }, {}, 'secret')).toBe('id_' + createHmac('sha256', 'secret').update(long).digest('hex').slice(0, 61))
  expect(explicitSessionId({ session_id: '🐾'.repeat(64) }, {}, 'secret')).toBe('🐾'.repeat(64))
  const first = affinityModelKey(7, 'public', 'actual-a')
  expect(first).toBe('route:7:public:actual-a')
  expect(sessionScope(1, first, { session_id: long }, {}, 'secret')).not.toBe(
    sessionScope(1, affinityModelKey(7, 'public', 'actual-b'), { session_id: long }, {}, 'secret'))
})
