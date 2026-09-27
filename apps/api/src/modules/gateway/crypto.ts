import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
export const hashToken = (value: string) =>
  createHash('sha256').update(value).digest('hex')
export const mintToken = () => `coati_${randomBytes(32).toString('base64url')}`
export function parsePreviousKeys(raw = '[]'): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.length > 4 || value.some(key => typeof key !== 'string' || !key)) throw new Error()
    return value as string[]
  } catch {
    throw new Error('Historical encryption keys must be a JSON array of at most four nonempty strings')
  }
}
export class CredentialVault {
  private key: Buffer
  private readKeys: Buffer[]
  constructor(secret: string, previous: string[] = []) {
    if (!secret) throw new Error('GATEWAY_ENCRYPTION_KEY is required')
    if (
      !Array.isArray(previous) ||
      previous.length > 4 ||
      previous.some((key) => typeof key !== 'string' || !key)
    )
      throw new Error('Invalid previous encryption keys')
    this.key = createHash('sha256').update(secret).digest()
    this.readKeys = [
      this.key,
      ...previous.map((key) => createHash('sha256').update(key).digest()),
    ]
  }
  encrypt(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ])
    return [
      'v2',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.')
  }
  decrypt(value: string) {
    const [version, iv, tag, ciphertext] = value.split('.')
    if (version !== 'v2' || !iv || !tag || !ciphertext)
      throw new Error(
        'Unsupported credential format; legacy credentials require explicit migration',
      )
    for (const key of this.readKeys) {
      try {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          Buffer.from(iv, 'base64url'),
        )
        decipher.setAuthTag(Buffer.from(tag, 'base64url'))
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, 'base64url')),
          decipher.final(),
        ]).toString('utf8')
      } catch {
        /* Try the bounded read-only key ring. */
      }
    }
    throw new Error('Unable to decrypt gateway credential with configured keys')
  }
}
export function redact(value: string, secrets: string[] = []) {
  let result = value
  for (const s of secrets) if (s) result = result.split(s).join('[redacted]')
  return result
    .replace(/Bearer\s+\S+|(?:sk-|coati_)[a-zA-Z0-9_-]+/gi, '[redacted]')
    .slice(0, 1000)
}
