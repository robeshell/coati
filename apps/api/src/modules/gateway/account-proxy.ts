import { z } from 'zod'

export const proxyUrlSchema = z.preprocess(
  (value) => (value === null || value === '' ? null : value),
  z
    .string()
    .max(512)
    .refine((value) => {
      try {
        const url = new URL(value)
        decodeURIComponent(url.username)
        decodeURIComponent(url.password)
        return (
          !/[\r\n]/.test(value) &&
          ['http:', 'https:'].includes(url.protocol) &&
          Boolean(url.hostname) &&
          !url.hash &&
          url.port !== '0'
        )
      } catch {
        return false
      }
    }, '出站代理必须是有效的 HTTP(S) 地址')
    .transform((value) => value.trim())
    .nullable(),
)
export function proxyHint(value: string | null) {
  if (!value) return null
  return new URL(value).origin
}
export function proxySecrets(value: string | null): string[] {
  if (!value) return []
  const url = new URL(value)
  const username = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  return [
    value,
    url.username,
    url.password,
    username,
    password,
    username ? Buffer.from(`${username}:${password}`).toString('base64') : '',
  ].filter(Boolean)
}
