export type Obj = Record<string, unknown>
export const isObject = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
export const object = (v: unknown): Obj => (isObject(v) ? v : {})
export const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const truthy = (v: unknown): boolean =>
  !!v &&
  (!Array.isArray(v) || v.length > 0) &&
  (!isObject(v) || Object.keys(v).length > 0)
export const fallback = (v: unknown, other: unknown) => (truthy(v) ? v : other)
// Python json.dumps uses spaces after separators. Tool argument strings are observable wire values.
export function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(pythonJson).join(', ') + ']'
  if (isObject(value))
    return (
      '{' +
      Object.entries(value)
        .map(([k, v]) => JSON.stringify(k) + ': ' + pythonJson(v))
        .join(', ') +
      '}'
    )
  return JSON.stringify(value) ?? 'null'
}
export function text(value: unknown): string {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return String(value)
  return value
    .map((part) =>
      typeof part === 'string'
        ? part
        : isObject(part) &&
            [
              'text',
              'input_text',
              'output_text',
              'summary_text',
              'refusal',
            ].includes(String(part.type))
          ? part.text || part.refusal || ''
          : '',
    )
    .join('')
}
export function image(part: Obj): Obj | undefined {
  const source = object(part.source)
  if (source.type === 'url' && source.url)
    return { type: 'image_url', image_url: { url: source.url } }
  if (source.type === 'base64' && source.data)
    return {
      type: 'image_url',
      image_url: {
        url: `data:${source.media_type || 'image/png'};base64,${source.data}`,
      },
    }
}

export class ProtocolBridgeError extends Error {}
export const userId = (body: Obj): string =>
  String(body.user || '').trim() ||
  String(object(body.metadata).user_id || '').trim()
export const schemaDefault = () => ({ type: 'object', properties: {} })
export const get = (body: Obj, key: string, defaultValue: unknown): unknown =>
  key in body ? body[key] : defaultValue
export function jsonObject(value: unknown, message: string): Obj {
  if (isObject(value)) return value
  if (value == null || value === '') return {}
  try {
    const parsed: unknown =
      typeof value === 'string' ? JSON.parse(value) : value
    if (isObject(parsed)) return parsed
  } catch {
    /* Normalize malformed arguments below. */
  }
  throw new ProtocolBridgeError(message)
}
export function checkCandidates(
  body: Obj,
  target: 'anthropic' | 'responses',
): void {
  const value = fallback(body.n, 1)
  const n =
    typeof value === 'number'
      ? Math.trunc(value)
      : typeof value === 'boolean'
        ? Number(value)
        : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())
          ? Number(value)
          : NaN
  if (!Number.isFinite(n))
    throw new ProtocolBridgeError('OpenAI 的 n 参数必须是整数')
  if (n !== 1)
    throw new ProtocolBridgeError(
      target === 'anthropic'
        ? 'Anthropic Messages 不支持 OpenAI 的多候选 n 参数，请将 n 设置为 1'
        : 'Responses 不支持 OpenAI Chat 的多候选 n 参数，请将 n 设置为 1',
    )
}
export function mergeAnthropic(messages: Obj[]): Obj[] {
  const result: Obj[] = []
  for (const message of messages) {
    const role = message.role || 'user',
      raw = fallback(message.content, [])
    const content = Array.isArray(raw)
      ? [...raw]
      : [{ type: 'text', text: String(raw) }]
    const last = result.at(-1)
    if (last?.role === role) (last.content as unknown[]).push(...content)
    else result.push({ role, content })
  }
  return result
}
export function streamErrorMessage(payload: unknown): string | null {
  if (!isObject(payload)) return null
  const kind = String(payload.type || ''),
    response = object(payload.response),
    status = String(response.status || payload.status || '')
  if (
    !['error', 'response.error', 'response.failed'].includes(kind) &&
    status !== 'failed'
  )
    return null
  const error = isObject(payload.error) ? payload.error : object(response.error)
  const message = error.message || payload.message || response.message,
    errorType = error.type || kind || 'stream_error'
  return String(message || `上游流式响应失败（${errorType}）`)
}
