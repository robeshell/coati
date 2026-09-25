import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
export const hashToken = (value: string) =>
  createHash('sha256').update(value).digest('hex')
export const mintToken = () => `coati_${randomBytes(32).toString('base64url')}`
export class CredentialVault {
  private key: Buffer
  constructor(secret: string) {
    if (!secret) throw new Error('GATEWAY_ENCRYPTION_KEY is required')
    this.key = createHash('sha256').update(secret).digest()
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
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(iv, 'base64url'),
    )
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  }
}
export function redact(value: string, secrets: string[] = []) {
  let result = value
  for (const s of secrets) if (s) result = result.split(s).join('[redacted]')
  return result
    .replace(/Bearer\s+\S+|(?:sk-|coati_)[a-zA-Z0-9_-]+/gi, '[redacted]')
    .slice(0, 1000)
}
