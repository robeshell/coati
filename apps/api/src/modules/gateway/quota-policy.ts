export function defaultDailyQuota(value = process.env.AGENT_DAILY_TOKEN_QUOTA) {
  if (!value) return 0
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0 || number > 1e12)
    throw new Error('AGENT_DAILY_TOKEN_QUOTA must be an integer between 0 and 1000000000000')
  return number
}

/** Match Python's reservation lifetime (independent of provider socket deadlines). */
export function reservationTtlSeconds(value = process.env.AGENT_QUOTA_RESERVATION_TTL_SECONDS) {
  const parsed = Number(value || 3600)
  if (!Number.isSafeInteger(parsed)) throw new Error('AGENT_QUOTA_RESERVATION_TTL_SECONDS must be an integer')
  return Math.max(300, parsed || 3600)
}
