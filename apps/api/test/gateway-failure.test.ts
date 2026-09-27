import { test, expect } from 'vitest'
import {
  classifyUpstreamHttp,
  transientConnectionFailure,
} from '../src/modules/gateway/upstream-failure'
test('429 quota wording is retryable but never an immediate fatal cooldown', () => {
  for (const body of [
    'insufficient_quota',
    'exceeded your current quota',
    'Insufficient balance',
  ])
    expect(classifyUpstreamHttp(429, body)).toEqual({
      retryable: true,
      immediate: false,
    })
})
test('authentication and explicit billing failures are immediate, generic client errors are not', () => {
  for (const code of [401, 402, 403])
    expect(classifyUpstreamHttp(code)).toEqual({
      retryable: true,
      immediate: true,
    })
  expect(classifyUpstreamHttp(400, 'EXCEEDED_CURRENT_QUOTA')).toEqual({
    retryable: true,
    immediate: true,
  })
  expect(classifyUpstreamHttp(400, 'invalid messages')).toEqual({
    retryable: false,
    immediate: false,
  })
})

test('connection classifier follows fetch causes and stops cycles and aborts', () => {
  expect(
    transientConnectionFailure(
      new TypeError('fetch failed', { cause: { code: 'EAI_AGAIN' } }),
    ),
  ).toBe(true)
  expect(
    transientConnectionFailure({
      name: 'AbortError',
      cause: { code: 'ECONNRESET' },
    }),
  ).toBe(false)
  expect(transientConnectionFailure({ code: 'CERT_HAS_EXPIRED' })).toBe(false)
  const cycle: { cause?: unknown } = {}
  cycle.cause = cycle
  expect(transientConnectionFailure(cycle)).toBe(false)
})
