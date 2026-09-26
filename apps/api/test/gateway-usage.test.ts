import { test, expect } from 'vitest'
import {
  normalizeUsage,
  mergeUsage,
  usageForProtocol,
} from '../src/modules/gateway/usage'
import type { Protocol } from '../src/modules/gateway/schema'
const raw = {
  input_tokens: 7,
  output_tokens: 5,
  cache_read_input_tokens: 2,
  cache_creation_input_tokens: 3,
  cache_creation: {
    ephemeral_5m_input_tokens: 1,
    ephemeral_1h_input_tokens: 2,
  },
  reasoning_tokens: 4,
}
for (const target of ['openai', 'anthropic', 'responses'] as Protocol[]) {
  test(`usage details survive anthropic -> ${target} without counting cache or reasoning twice`, () => {
    expect(
      normalizeUsage(usageForProtocol(raw, 'anthropic', target), target),
    ).toEqual({
      input: 12,
      output: 5,
      cache_read_tokens: 2,
      cache_miss_tokens: 7,
      cache_miss_source: 'derived',
      cache_write_tokens: 3,
      cache_write_5m_tokens: 1,
      cache_write_1h_tokens: 2,
      reasoning_tokens: 4,
    })
  })
}
test('unknown, zero and invalid counters remain distinct', () => {
  expect(normalizeUsage({}, 'openai')).toMatchObject({
    input: null,
    output: null,
    cache_read_tokens: null,
    reasoning_tokens: null,
  })
  expect(
    normalizeUsage(
      {
        prompt_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens: 0,
      },
      'openai',
    ),
  ).toMatchObject({ input: 0, output: 0, cache_read_tokens: 0 })
  expect(
    normalizeUsage(
      {
        prompt_tokens: -1,
        completion_tokens: 1.5,
        cache_read_input_tokens: '2',
      },
      'openai',
    ),
  ).toMatchObject({ input: null, output: null, cache_read_tokens: null })
})
test('partial cumulative usage merges without losing fields or adding snapshots', () => {
  const first = {
    input_tokens: 12,
    output_tokens: 0,
    input_tokens_details: { cached_tokens: 2 },
  }
  const next = mergeUsage(first, {
    output_tokens: 5,
    input_tokens_details: {},
  })
  expect(mergeUsage(next, { output_tokens: 5, input_tokens: null })).toEqual({
    ...first,
    output_tokens: 5,
  })
  expect(first.output_tokens).toBe(0)
})
test('cache write TTL totals are used only when both are reported, explicit aggregate wins', () => {
  expect(
    normalizeUsage({ cache_creation: raw.cache_creation }, 'anthropic')
      .cache_write_tokens,
  ).toBe(3)
  expect(
    normalizeUsage(
      { cache_creation: { ephemeral_5m_input_tokens: 1 } },
      'anthropic',
    ).cache_write_tokens,
  ).toBeNull()
  expect(
    normalizeUsage(
      { cache_creation: raw.cache_creation, cache_creation_input_tokens: 9 },
      'anthropic',
    ).cache_write_tokens,
  ).toBe(9)
})

test('cache misses distinguish explicit zero, derived values, absent dimensions and contradictions', () => {
  expect(normalizeUsage({ prompt_tokens: 10 }, 'openai')).toMatchObject({
    cache_miss_tokens: null,
    cache_miss_source: null,
  })
  expect(
    normalizeUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 2 }, 'openai'),
  ).toMatchObject({ cache_miss_tokens: 8, cache_miss_source: 'derived' })
  expect(
    normalizeUsage(
      { prompt_tokens: 10, prompt_cache_hit_tokens: 12 },
      'openai',
    ),
  ).toMatchObject({ cache_miss_tokens: null, cache_miss_source: null })
  expect(
    normalizeUsage(
      {
        prompt_tokens: 10,
        prompt_cache_hit_tokens: 2,
        prompt_cache_miss_tokens: 0,
      },
      'openai',
    ),
  ).toMatchObject({ cache_miss_tokens: 0, cache_miss_source: 'reported' })
  expect(
    normalizeUsage(
      { input_tokens: 7, cache_read_input_tokens: 2 },
      'anthropic',
    ),
  ).toMatchObject({
    input: 9,
    cache_miss_tokens: 7,
    cache_miss_source: 'derived',
  })
})
for (const source of ['openai', 'responses', 'anthropic'] as Protocol[]) {
  for (const target of ['openai', 'responses', 'anthropic'] as Protocol[]) {
    test(`reported cache misses survive ${source} -> ${target} without changing totals`, () => {
      const usage = { ...raw, prompt_cache_miss_tokens: 0 }
      expect(
        normalizeUsage(usageForProtocol(usage, source, target), target),
      ).toMatchObject({ cache_miss_tokens: 0, cache_miss_source: 'reported' })
    })
  }
}
test('streaming snapshots recompute derived misses but preserve reported misses', () => {
  const initial = { prompt_tokens: 10, prompt_cache_hit_tokens: 2 }
  expect(
    normalizeUsage(mergeUsage(initial, { prompt_tokens: 15 }), 'openai')
      .cache_miss_tokens,
  ).toBe(13)
  expect(
    normalizeUsage(
      mergeUsage(
        { ...initial, prompt_cache_miss_tokens: 4 },
        { prompt_tokens: 15 },
      ),
      'openai',
    ),
  ).toMatchObject({ cache_miss_tokens: 4, cache_miss_source: 'reported' })
})
