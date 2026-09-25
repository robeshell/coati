import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, fetch } from 'undici'
import { GatewayError } from './schema'
export function privateAddress(address: string): boolean {
  if (!isIP(address)) return true
  const a = address.toLowerCase()
  if (a.includes(':')) {
    const normalized = new URL(`http://[${a}]`).hostname.slice(1, -1)
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized)
    if (mapped) {
      const high = parseInt(mapped[1]!, 16),
        low = parseInt(mapped[2]!, 16)
      return privateAddress(
        `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
      )
    }
    // Allow global unicast only; exclude documentation, transition and special-purpose networks.
    return (
      !/^[23]/.test(normalized) ||
      /^2001:(?:db8:|0:|:)/.test(normalized) ||
      normalized.startsWith('2002:')
    )
  }
  const [x, y] = a.split('.').map(Number)
  return (
    x === 0 ||
    x === 10 ||
    x === 127 ||
    (x === 169 && y === 254) ||
    (x === 172 && y! >= 16 && y! <= 31) ||
    (x === 192 && (y === 168 || y === 0)) ||
    x! >= 224 ||
    (x === 100 && y! >= 64 && y! <= 127) ||
    (x === 198 && (y === 18 || y === 19))
  )
}

export function validateBase(raw: string, allowPrivate: boolean) {
  const url = new URL(raw)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new GatewayError(
      400,
      '上游地址必须是没有凭证、查询参数和片段的 HTTP(S) 地址',
    )
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (
    !allowPrivate &&
    (url.protocol !== 'https:' ||
      host === 'localhost' ||
      (isIP(host) && privateAddress(host)))
  )
    throw new GatewayError(
      400,
      '默认仅允许公网 HTTPS 上游；内网部署需显式启用 GATEWAY_ALLOW_PRIVATE_UPSTREAMS',
    )
  return url.toString().replace(/\/$/, '')
}
export class GatewayTransport {
  readonly agent: Agent
  constructor(readonly allowPrivate = false) {
    this.agent = new Agent({
      connections: 100,
      pipelining: 1,
      connect: {
        timeout: 10000,
        lookup: (host, opts, callback) => {
          lookup(host, { ...opts, all: true }, (error, addresses) => {
            if (error) return callback(error, [], undefined)
            if (
              !allowPrivate &&
              addresses.some((x) => privateAddress(x.address))
            )
              return callback(
                new Error('Private upstream address is not allowed'),
                [],
                undefined,
              )
            // Pin the validated DNS result to the actual socket connection.
            if (opts.all) callback(null, addresses)
            else callback(null, addresses[0]!.address, addresses[0]!.family)
          })
        },
      },
    })
  }
  send(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal,
  ) {
    return fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers,
      signal,
      dispatcher: this.agent,
      redirect: 'manual',
    })
  }
  close() {
    return this.agent.close()
  }
}
export async function readBounded(
  response: Awaited<ReturnType<GatewayTransport['send']>>,
  limit = 8 * 1024 * 1024,
) {
  const chunks: Uint8Array[] = []
  let size = 0
  if (response.body)
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > limit) {
        await response.body.cancel().catch(() => {})
        throw new GatewayError(502, '上游响应超过大小限制')
      }
      chunks.push(chunk)
    }
  return Buffer.concat(chunks).toString('utf8')
}
