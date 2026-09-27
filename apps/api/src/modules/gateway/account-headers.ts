import { z } from 'zod'

const blocked = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'cookie',
])
export const accountHeadersSchema = z.preprocess(
  (value) => {
    if (
      value === null ||
      value === '' ||
      (Array.isArray(value) && !value.length)
    )
      return {}
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    }
    return value
  },
  z
    .record(
      z.string(),
      z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
    )
    .transform((value, ctx) => {
      const entries = Object.entries(value)
      const invalid = (message: string) => {
        ctx.addIssue({ code: 'custom', message })
        return z.NEVER
      }
      if (entries.length > 20) return invalid('自定义请求头最多 20 项')
      const result: Record<string, string> = {}
      for (const [key, raw] of entries) {
        const name = key.trim()
        if (name.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
          return invalid('自定义请求头名称不合法')
        if (blocked.has(name.toLowerCase()))
          return invalid('不允许覆盖认证或连接请求头')
        const text =
          raw === null
            ? ''
            : typeof raw === 'boolean'
              ? raw
                ? 'True'
                : 'False'
              : String(raw).trim()
        if (/[\r\n]/.test(text) || text.length > 512)
          return invalid('自定义请求头值不合法')
        result[name] = text
      }
      return result
    }),
)

export function withAccountHeaders(
  base: Record<string, string>,
  extra: unknown,
) {
  const headers = Object.fromEntries(
    Object.entries(base).map(([key, value]) => [key.toLowerCase(), value]),
  )
  for (const [key, value] of Object.entries(
    accountHeadersSchema.parse(extra ?? {}),
  ))
    headers[key.toLowerCase()] = value
  return headers
}
