import type { Protocol } from './schema'
export type UsageObject = Record<string, unknown>
const obj = (value: unknown): UsageObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UsageObject)
    : {}
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
const first = (...values: unknown[]): number | null => {
  for (const value of values) {
    const result = count(value)
    if (result !== null) return result
  }
  return null
}
/** Sum reported tool-round counters without treating missing observations as zero. */
export function aggregateToolUsage(rounds: UsageObject[]): UsageObject {
  const totals: UsageObject = {}
  const observed = new Map<string, number>()
  const add = (target: UsageObject, incoming: UsageObject, prefix = '') => {
    for (const [field, value] of Object.entries(incoming)) {
      const path = prefix + field
      if (count(value) !== null) {
        const sum = Number(target[field] ?? 0) + Number(value)
        if (!Number.isSafeInteger(sum)) throw new Error('Tool usage counter overflow')
        target[field] = sum
        observed.set(path, (observed.get(path) ?? 0) + 1)
      } else if (Object.keys(obj(value)).length && field !== 'coati_usage') {
        target[field] ??= {}
        add(obj(target[field]), obj(value), path + '.')
      }
    }
  }
  for (const usage of rounds) add(totals, usage)
  const partial = [...observed].filter(([, n]) => n < rounds.length).map(([field]) => field).sort()
  // Paths are in canonical Messages usage, independent of the client's protocol.
  totals.coati_usage = { aggregation: 'sum_reported', rounds: rounds.length, partial_fields: partial }
  return totals
}
/** All normalized input counts include cache; output includes reasoning. Null means unreported. */
export function normalizeUsage(raw: UsageObject, protocol: Protocol) {
  const inputDetails = obj(raw.input_tokens_details),
    promptDetails = obj(raw.prompt_tokens_details)
  const outputDetails = obj(raw.output_tokens_details),
    completionDetails = obj(raw.completion_tokens_details),
    creation = obj(raw.cache_creation)
  const cacheRead = first(
    raw.cache_read_input_tokens,
    inputDetails.cached_tokens,
    promptDetails.cached_tokens,
    raw.prompt_cache_hit_tokens,
  )
  const write5m = first(creation.ephemeral_5m_input_tokens),
    write1h = first(creation.ephemeral_1h_input_tokens)
  const cacheWrite = first(
    raw.cache_creation_input_tokens,
    inputDetails.cache_write_tokens,
    inputDetails.cache_creation_input_tokens,
    promptDetails.cache_write_tokens,
    write5m !== null && write1h !== null ? write5m + write1h : null,
  )
  const base = first(raw.prompt_tokens, raw.input_tokens)
  const total =
    base === null
      ? null
      : base +
        (protocol === 'anthropic' ? (cacheRead ?? 0) + (cacheWrite ?? 0) : 0)
  const reportedMiss = first(
    raw.cache_miss_tokens,
    raw.prompt_cache_miss_tokens,
    raw.cache_miss_input_tokens,
    raw.uncached_tokens,
    raw.uncached_input_tokens,
    raw.input_uncached_tokens,
    inputDetails.uncached_tokens,
    promptDetails.uncached_tokens,
  )
  let cacheMiss = reportedMiss
  let missSource: 'reported' | 'derived' | null =
    reportedMiss === null ? null : 'reported'
  if (reportedMiss !== null && raw.cache_miss_source === 'derived')
    missSource = 'derived'
  if (
    cacheMiss === null &&
    base !== null &&
    (cacheRead !== null || cacheWrite !== null)
  ) {
    const derived =
      protocol === 'anthropic'
        ? base
        : base - (cacheRead ?? 0) - (cacheWrite ?? 0)
    if (Number.isSafeInteger(derived) && derived >= 0) {
      cacheMiss = derived
      missSource = 'derived'
    }
  }
  return {
    cache_miss_tokens: cacheMiss,
    cache_miss_source: missSource,
    input: total !== null && Number.isSafeInteger(total) ? total : null,
    output: first(raw.completion_tokens, raw.output_tokens),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cache_write_5m_tokens: write5m,
    cache_write_1h_tokens: write1h,
    reasoning_tokens: first(
      outputDetails.reasoning_tokens,
      completionDetails.reasoning_tokens,
      raw.reasoning_tokens,
    ),
  }
}
/** Partial usage snapshots merge recursively, never add repeated counters. */
export function mergeUsage(
  previous: UsageObject,
  incoming: UsageObject,
): UsageObject {
  const result = { ...previous }
  for (const [key, value] of Object.entries(incoming)) {
    if (value == null) continue
    result[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? mergeUsage(obj(previous[key]), obj(value))
        : value
  }
  return result
}
/** Convert known details without silently replacing unreported counters with genuine zeros. */
export function usageForProtocol(
  raw: UsageObject,
  source: Protocol,
  target: Protocol,
): UsageObject {
  if (source === target) return structuredClone(raw)
  const n = normalizeUsage(raw, source),
    result: UsageObject = {}
  if (raw.coati_usage !== undefined) result.coati_usage = structuredClone(raw.coati_usage)
  if (n.cache_miss_tokens !== null) {
    result.cache_miss_tokens = n.cache_miss_tokens
    result.cache_miss_source = n.cache_miss_source
  }
  if (target === 'anthropic') {
    if (n.input !== null)
      result.input_tokens = Math.max(
        0,
        n.input - (n.cache_read_tokens ?? 0) - (n.cache_write_tokens ?? 0),
      )
    if (n.output !== null) result.output_tokens = n.output
    if (n.cache_read_tokens !== null)
      result.cache_read_input_tokens = n.cache_read_tokens
    if (n.cache_write_tokens !== null)
      result.cache_creation_input_tokens = n.cache_write_tokens
    const creation: UsageObject = {}
    if (n.cache_write_5m_tokens !== null)
      creation.ephemeral_5m_input_tokens = n.cache_write_5m_tokens
    if (n.cache_write_1h_tokens !== null)
      creation.ephemeral_1h_input_tokens = n.cache_write_1h_tokens
    if (Object.keys(creation).length) result.cache_creation = creation
    if (n.reasoning_tokens !== null)
      result.reasoning_tokens = n.reasoning_tokens
  } else {
    if (n.input !== null)
      result[target === 'openai' ? 'prompt_tokens' : 'input_tokens'] = n.input
    if (n.output !== null)
      result[target === 'openai' ? 'completion_tokens' : 'output_tokens'] =
        n.output
    const details: UsageObject = {}
    if (n.cache_read_tokens !== null)
      details.cached_tokens = n.cache_read_tokens
    if (n.cache_write_tokens !== null) {
      details.cache_write_tokens = n.cache_write_tokens
      result.cache_creation_input_tokens = n.cache_write_tokens
    }
    if (Object.keys(details).length)
      result[
        target === 'openai' ? 'prompt_tokens_details' : 'input_tokens_details'
      ] = details
    if (n.reasoning_tokens !== null)
      result[
        target === 'openai'
          ? 'completion_tokens_details'
          : 'output_tokens_details'
      ] = { reasoning_tokens: n.reasoning_tokens }
    if (n.input !== null && n.output !== null)
      result.total_tokens = n.input + n.output
    if (raw.cache_creation !== undefined)
      result.cache_creation = structuredClone(raw.cache_creation)
  }
  return result
}
