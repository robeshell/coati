/** Python gateway HTTP classification, including its deliberate 429 billing exception. */
export function classifyUpstreamHttp(status: number, body = '') {
  const billing = [
    'insufficient balance',
    'exceeded your current quota',
    'exceeded_current_quota',
  ].some((marker) => body.toLowerCase().includes(marker))
  const immediate =
    [401, 402, 403].includes(status) || (billing && status !== 429)
  return {
    retryable: immediate || [408, 429].includes(status) || status >= 500,
    immediate,
  }
}

/** Node fetch wraps socket/DNS failures in cause; inspect a bounded chain, never retry policy errors. */
export function transientConnectionFailure(error: unknown): boolean {
  const codes = new Set([
    'ECONNRESET',
    'ECONNABORTED',
    'ECONNREFUSED',
    'EPIPE',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ])
  const seen = new Set<unknown>()
  let current = error
  for (
    let depth = 0;
    depth < 8 && current && typeof current === 'object' && !seen.has(current);
    depth++
  ) {
    seen.add(current)
    const value = current as { code?: unknown; name?: unknown; cause?: unknown }
    if (value.name === 'AbortError') return false
    if (typeof value.code === 'string' && codes.has(value.code)) return true
    current = value.cause
  }
  return false
}

export function upstreamTimeout(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current = error
  for (
    let depth = 0;
    depth < 8 && current && typeof current === 'object' && !seen.has(current);
    depth++
  ) {
    seen.add(current)
    const value = current as { code?: unknown; name?: unknown; cause?: unknown }
    if (
      value.name === 'TimeoutError' ||
      [
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
      ].includes(String(value.code))
    )
      return true
    current = value.cause
  }
  return false
}
