import { createHmac } from 'node:crypto'
type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {}
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '')
const scalar = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : ''
const header = (values: ObjectValue, names: string[]) =>
  names.map((name) => scalar(values[name])).find(Boolean) || null
const bounded = (value: string | null, max: number) =>
  value && /^[+-]?\d+$/.test(value)
    ? Math.max(0, Math.min(max, Number(value)))
    : null
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, sorted(item)]),
        )
      : value
/** Only sizes, counts and explicit identifiers are persisted; never message/tool bodies. */
export function requestContext(
  body: ObjectValue,
  headers: ObjectValue,
  secret: string,
) {
  const items: unknown[] = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : body.input != null && body.input !== ''
        ? [body.input]
        : []
  const digest = (prefix: string, value: string) =>
    `${prefix}_${createHmac('sha256', secret)
      .update(value)
      .digest('hex')
      .slice(0, 63 - prefix.length)}`
  const normalize = (value: unknown) => {
    const text = scalar(value)
    return text ? (Array.from(text).length <= 64 ? text : digest('id', text)) : null
  }
  let session = normalize(
    header(headers, [
      'x-coati-session-id',
      'x-claude-code-session-id',
      'session-id',
      'session_id',
      'x-session-id',
      'x-session-affinity',
      'x-amp-thread-id',
    ]),
  )
  let source: string | null = session ? 'header' : null
  if (!session) {
    session =
      [
        body.session_id,
        body.sessionId,
        body.prompt_cache_key,
        body.conversation_id,
        typeof body.conversation === 'object'
          ? object(body.conversation).id
          : body.conversation,
      ]
        .map(normalize)
        .find(Boolean) || null
    if (session) source = 'body'
  }
  if (!session) {
    let system: unknown = body.instructions || body.system || null
    let user: unknown = typeof body.input === 'string' ? body.input : null
    for (const item of items) {
      const entry = object(item),
        role = scalar(entry.role).toLowerCase()
      if (
        (system == null || system === '') &&
        ['system', 'developer'].includes(role)
      )
        system = entry.content
      if (role === 'user') {
        user = entry.content
        break
      }
    }
    if (
      user != null &&
      user !== '' &&
      (!Array.isArray(user) || user.length > 0) &&
      (typeof user !== 'object' || Object.keys(user).length > 0)
    ) {
      session = digest('msg', JSON.stringify(sorted({ system, user })))
      source = 'fingerprint'
    }
  }
  const images = (value: unknown): number =>
    Array.isArray(value)
      ? value.reduce((sum, item) => sum + images(item), 0)
      : value !== null && typeof value === 'object'
        ? Number(
            ['image', 'image_url', 'input_image'].includes(
              String(object(value).type),
            ),
          ) +
          Object.values(value).reduce<number>(
            (sum, item) => sum + images(item),
            0,
          )
        : 0
  const toolBytes = (value: unknown): number => {
    if (Array.isArray(value))
      return value.reduce((sum, item) => sum + toolBytes(item), 0)
    const item = object(value)
    if (
      ['tool', 'toolresult', 'tool_result'].includes(
        scalar(item.role).toLowerCase(),
      ) ||
      [
        'tool_result',
        'function_call_output',
        'web_search_tool_result',
        'web_fetch_tool_result',
      ].includes(scalar(item.type).toLowerCase())
    )
      return size(value)
    return item.content != null ? toolBytes(item.content) : 0
  }
  const estimate: ObjectValue = {
    messages: body.messages ?? null,
    tools: body.tools ?? null,
    response_format: body.response_format ?? null,
  }
  for (const key of ['input', 'instructions', 'system'])
    if (body[key] != null) estimate[key] = body[key]
  return {
    session_id: session,
    session_source: source,
    client_request_id:
      header(headers, ['x-coati-request-id', 'x-client-request-id'])?.slice(
        0,
        128,
      ) || null,
    step_index: bounded(
      header(headers, ['x-coati-step', 'x-agent-step']),
      1_000_000,
    ),
    retry_index: bounded(
      header(headers, ['x-coati-retry', 'x-agent-retry']),
      100,
    ),
    context_tokens_estimate: Math.max(1, Math.ceil(size(estimate) / 4)),
    context_bytes: size(body),
    message_count: items.length,
    tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
    image_count: images(items),
    tool_result_bytes: toolBytes(items),
    largest_message_bytes: items.reduce<number>(
      (max, item) => Math.max(max, size(item)),
      0,
    ),
  }
}

export type RequestContext = ReturnType<typeof requestContext>
