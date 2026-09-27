export interface DeviceStartPolicy {
  startsPerMinute: number
  maxActive: number
  retentionHours: number
}
export function deviceStartPolicy(env = process.env): DeviceStartPolicy {
  const positive = (value: string | undefined, fallback: number) => {
    const n = Number(value)
    return Number.isSafeInteger(n) && n > 0 ? n : fallback
  }
  return {
    startsPerMinute: positive(env.AGENT_DEVICE_STARTS_PER_MINUTE, 60),
    maxActive: positive(env.AGENT_DEVICE_MAX_ACTIVE, 5000),
    retentionHours: positive(env.AGENT_DEVICE_RETENTION_HOURS, 24),
  }
}

export function deviceFlowPolicy(env: NodeJS.ProcessEnv = process.env) {
  const integer = (value: string | undefined, fallback: number) => {
    const parsed = Number(value)
    return value && Number.isSafeInteger(parsed) ? parsed : fallback
  }
  return {
    ttlSeconds: integer(env.AGENT_DEVICE_TTL_SECONDS, 600),
    intervalSeconds: integer(env.AGENT_DEVICE_INTERVAL_SECONDS, 5),
    verificationPath: env.AGENT_DEVICE_VERIFY_PATH || '/agent/device-confirm',
  }
}
