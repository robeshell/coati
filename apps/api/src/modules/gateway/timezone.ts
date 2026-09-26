/** Match the legacy business-day default and invalid-zone fallback. */
export function gatewayTimezone(value = process.env.AGENT_TIMEZONE) {
  const name = value || 'Asia/Shanghai'
  try {
    if (!/^[A-Za-z]/.test(name)) return 'Asia/Shanghai'
    new Intl.DateTimeFormat('en', { timeZone: name }).format(0)
    return name
  } catch {
    return 'Asia/Shanghai'
  }
}
