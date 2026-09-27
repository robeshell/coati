/** Python parse_upstream_error_body: JSON, SSE data, then at most two message wrappers. */
export function parseUpstreamErrorBody(raw: string): unknown {
  const text = raw.trim()
  if (!text) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    const data = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n').trim()
    if (!data || data === '[DONE]') return undefined
    try { parsed = JSON.parse(data) } catch { return undefined }
  }
  for (let depth = 0; depth < 2; depth++) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) break
    const message = (parsed as Record<string, unknown>).message
    if (typeof message !== 'string') break
    let inner = message.trim()
    if (inner.startsWith('data:')) inner = inner.slice(5).trim()
    if (!inner.startsWith('{')) break
    try {
      const unwrapped = JSON.parse(inner)
      if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) break
      parsed = unwrapped.error && typeof unwrapped.error === 'object' && !Array.isArray(unwrapped.error) ? unwrapped.error : unwrapped
    } catch { break }
  }
  return parsed ?? undefined
}
