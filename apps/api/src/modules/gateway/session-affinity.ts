import { createHmac } from 'node:crypto'
const headers = [
  'x-coati-session-id',
  'x-claude-code-session-id',
  'session-id',
  'session_id',
  'x-session-id',
  'x-session-affinity',
  'x-amp-thread-id',
]
/** Only explicit session identifiers create bindings; identical prompts are not a session. */
export function sessionScope(
  owner: number,
  model: string,
  body: Record<string, unknown>,
  values: Record<string, unknown>,
  secret: string,
): string | undefined {
  const session = explicitSessionId(body, values, secret)
  return session
    ? createHmac('sha256', secret)
        .update(JSON.stringify([owner, model, session]))
        .digest('hex')
    : undefined
}

/** Read identifiers without persisting the raw value. */
export function explicitSessionId(body: Record<string, unknown>, values: Record<string, unknown>, secret = 'coati-session-fingerprint'): string | undefined {
  const scalar = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? (typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value)).trim()
      : ''
  const fromHeader = headers.map((name) => scalar(values[name])).find(Boolean)
  const conversation = body.conversation
  const fromBody = [
    body.session_id,
    body.sessionId,
    body.prompt_cache_key,
    body.conversation_id,
    typeof conversation === 'object' && conversation
      ? (conversation as Record<string, unknown>).id
      : conversation,
  ]
    .map(scalar)
    .find(Boolean)
  const value = fromHeader || fromBody
  if (!value) return undefined
  return Array.from(value).length <= 64 ? value
    : `id_${createHmac('sha256', secret).update(value).digest('hex').slice(0, 61)}`
}

export function affinityModelKey(routeId: number | undefined, requested: string, effective: string): string {
  return Array.from(`${routeId === undefined ? 'pool' : `route:${routeId}`}:${requested || 'default'}:${effective || 'default'}`).slice(0, 255).join('')
}
