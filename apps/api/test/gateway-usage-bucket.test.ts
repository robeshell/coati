import { expect, test } from 'vitest'
import { usageBucketIso } from '../src/modules/gateway/usage-bucket'
test.each([
  ['2026-09-26T00:00:00', 'Asia/Shanghai', '+08:00'],
  ['2025-11-02T01:00:00', 'America/New_York', '-04:00'],
  ['2025-11-02T02:00:00', 'America/New_York', '-05:00'],
  ['2026-03-08T02:00:00', 'America/New_York', '-05:00'],
  ['2026-04-05T01:30:00', 'Australia/Lord_Howe', '+11:00'],
  ['2026-09-26T00:00:00', 'Asia/Kathmandu', '+05:45'],
])(
  'local bucket %s in %s preserves Python fold=0 offset',
  (local, zone, offset) => {
    expect(usageBucketIso(local, zone)).toBe(local + offset)
  },
)
