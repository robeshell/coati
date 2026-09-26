import { hashToken } from './crypto'
import { utcNowIso } from '@/common/serialize'
import type { UpstreamRow } from './repository'
export function credentialMetadata(secret: string) {
  const characters = [...secret]
  return {
    api_key_hint:
      characters.length <= 8
        ? '****'
        : `${characters.slice(0, 4).join('')}…${characters.slice(-4).join('')}`,
    key_fingerprint: hashToken(secret),
  }
}
const stamp = (value: string | null) =>
  value ? utcNowIso(new Date(value)) + 'Z' : null
export function accountMetadata(row: UpstreamRow) {
  return {
    api_key_masked: row.api_key_hint || '****',
    key_fingerprint: row.key_fingerprint,
    updated_at: stamp(row.updated_at),
    last_used_at: stamp(row.last_used_at),
    last_checked_at: stamp(row.last_checked_at),
    last_success_at: stamp(row.last_success_at),
    last_error_at: stamp(row.last_error_at),
    last_latency_ms: row.last_latency_ms,
    cooldown_active: Boolean(
      row.cooldown_until && Date.parse(row.cooldown_until) > Date.now(),
    ),
  }
}

export function accountSummary(
  rows: Pick<
    UpstreamRow,
    'enabled' | 'health_status' | 'cooldown_until' | 'last_used_at'
  >[],
  now = Date.now(),
) {
  const enabled = rows.filter((row) => row.enabled)
  const healthy = enabled.filter(
    (row) => row.health_status === 'healthy',
  ).length
  const unhealthy = enabled.filter(
    (row) => row.health_status === 'unhealthy',
  ).length
  const cooling = enabled.filter(
    (row) =>
      row.health_status === 'cooldown' &&
      row.cooldown_until &&
      Date.parse(row.cooldown_until) > now,
  ).length
  const recovering = enabled.filter(
    (row) =>
      row.health_status === 'cooldown' &&
      (!row.cooldown_until || Date.parse(row.cooldown_until) <= now),
  ).length
  return {
    total: rows.length,
    enabled: enabled.length,
    disabled: rows.length - enabled.length,
    used: rows.filter((row) => row.last_used_at !== null).length,
    healthy,
    unhealthy: unhealthy + cooling,
    cooling,
    recovering,
    unknown: Math.max(
      0,
      enabled.length - healthy - unhealthy - cooling - recovering,
    ),
  }
}
