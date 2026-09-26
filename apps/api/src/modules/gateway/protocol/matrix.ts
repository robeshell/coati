import type { Protocol } from './contracts'
export const protocols: readonly Protocol[] = [
  'openai',
  'responses',
  'anthropic',
]
/** Routing pairs. Capability-specific acceptance remains separate from basic JSON/SSE support. */
export const matrix = protocols.flatMap((inbound) =>
  protocols.map((upstream) => ({
    inbound,
    upstream,
    path: inbound === upstream ? ('native' as const) : ('bridge' as const),
  })),
)
export const acceptanceScenarios = [
  'text',
  'tool-roundtrip',
  'parallel-tools',
  'image',
  'reasoning',
  'usage-cache',
  'unsupported-field',
  'upstream-error',
  'cancel',
  'truncated-stream',
  'slow-client',
  'settlement-failure',
] as const
