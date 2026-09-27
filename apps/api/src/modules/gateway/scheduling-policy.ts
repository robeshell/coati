export type SchedulingPolicy = {
  selectionPoolSize: number
  unhealthyRetrySeconds: number
  softRetrySeconds: number
  failureThreshold: number
  cooldownSeconds: number
}
export function schedulingPolicy(env: Record<string, string | undefined> = process.env): SchedulingPolicy {
  const integer = (key: string, fallback: number, zeroFallback = false) => {
    const raw = env[key]
    const value = raw === undefined || raw === '' ? fallback : Number(raw)
    if (!Number.isSafeInteger(value)) throw new Error(`${key} must be an integer`)
    return zeroFallback && value === 0 ? fallback : value
  }
  // Python's candidate-window parser deliberately falls back for malformed values.
  const pool = Number(env.AGENT_GATEWAY_SELECTION_POOL_SIZE || 7)
  return {
    selectionPoolSize: Math.min(50, Math.max(1, Number.isSafeInteger(pool) && pool !== 0 ? pool : 7)),
    unhealthyRetrySeconds: Math.max(0, integer('AGENT_CREDENTIAL_UNHEALTHY_RETRY_SECONDS', 300, true)),
    softRetrySeconds: Math.max(0, integer('AGENT_CREDENTIAL_SOFT_RETRY_SECONDS', 10)),
    failureThreshold: Math.max(1, integer('AGENT_CREDENTIAL_FAILURE_THRESHOLD', 3)),
    cooldownSeconds: Math.max(1, integer('AGENT_CREDENTIAL_COOLDOWN_SECONDS', 60, true)),
  }
}
type Health = { health_status: string | null; last_error_at: string | null }
export function inHealthPenalty(account: Health, policy: SchedulingPolicy, now = Date.now()) {
  if (account.health_status === 'unhealthy') {
    if (policy.unhealthyRetrySeconds <= 0) return false
    return account.last_error_at === null || Date.parse(account.last_error_at) + policy.unhealthyRetrySeconds * 1000 > now
  }
  if (account.health_status === 'cooldown' || account.last_error_at === null || policy.softRetrySeconds <= 0) return false
  return Date.parse(account.last_error_at) + policy.softRetrySeconds * 1000 > now
}
/** Personal channels and explicitly bound primary accounts do not use pool penalties. */
export function preferredHealthy<T extends { upstream: Health }>(candidates: T[], policy: SchedulingPolicy, now = Date.now()) {
  const preferred = candidates.filter(c => !inHealthPenalty(c.upstream, policy, now))
  return preferred.length ? preferred : candidates
}
