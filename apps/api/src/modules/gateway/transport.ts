import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, Pool, ProxyAgent, fetch } from 'undici'
import { proxyUrlSchema } from './account-proxy'
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
      normalized.startsWith('2002:') ||
      /^2001:2:(?:0:|:)/.test(normalized)
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

// Fake-IP is trusted only as a DNS answer for an administrator-configured hostname.
// Never exempt literal addresses, loopback, RFC1918 or metadata-service ranges.
export function permittedResolution(
  host: string,
  address: string,
  platform = false,
): boolean {
  if (!privateAddress(address)) return true
  if (!platform || isIP(host.replace(/^\[|\]$/g, ''))) return false
  return /^198\.(18|19)\./.test(address) || /^2001:2:(?:0:|:)/i.test(address)
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
// A route may change a path, never the origin receiving its account credential.
export function routeBase(
  accountBase: string,
  override: string | null | undefined,
  allowPrivate: boolean,
) {
  const base = validateBase(accountBase, allowPrivate)
  if (!override) return base
  let target: string
  try {
    target = validateBase(override, allowPrivate)
  } catch (error) {
    if (error instanceof GatewayError) throw error
    throw new GatewayError(400, '无效的路由上游地址')
  }
  if (new URL(target).origin !== new URL(base).origin)
    throw new GatewayError(422, '路由覆盖地址必须与绑定账号同源')
  return target
}
export class GatewayTransport {
  private readonly proxyAgents = new Set<ProxyAgent>()
  readonly agent: Agent
  private readonly platformAgent: Agent
  constructor(
    readonly allowPrivate = false,
    readonly trustedProxyUrl?: string,
  ) {
    if (trustedProxyUrl) proxyUrlSchema.parse(trustedProxyUrl)
    this.agent = this.createAgent(false)
    this.platformAgent = this.createAgent(true)
  }
  private createAgent(platform: boolean) {
    const allowPrivate = this.allowPrivate
    return new Agent({
      connections: 100,
      pipelining: 1,
      connect: {
        timeout: 10000,
        lookup: (host, opts, callback) => {
          lookup(host, { ...opts, all: true }, (error, addresses) => {
            if (error) return callback(error, [], undefined)
            if (
              !allowPrivate &&
              addresses.some(
                (x) => !permittedResolution(host, x.address, platform),
              )
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
  private async request(
    url: string,
    method: 'POST' | 'GET',
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal,
    timeoutMs: number,
    proxyUrl?: string | null,
    platform = false,
  ) {
    const endpoint = new URL(url)
    validateBase(endpoint.origin, this.allowPrivate)
    if (endpoint.username || endpoint.password || endpoint.hash)
      throw new GatewayError(400, '上游请求地址不能包含凭证或片段')
    proxyUrl = proxyUrl || (platform ? this.trustedProxyUrl : undefined)
    const waiting = new AbortController()
    const timer = setTimeout(
      () =>
        waiting.abort(
          Object.assign(new Error('Upstream response headers timeout'), {
            code: 'UND_ERR_HEADERS_TIMEOUT',
          }),
        ),
      timeoutMs,
    )
    timer.unref()
    const combinedSignal = AbortSignal.any([signal, waiting.signal])
    let proxy: ProxyAgent | undefined
    let requestUrl = url
    let proxyTargetHost: string | undefined
    const destroyProxy = () => {
      void proxy?.destroy().catch(() => {})
    }
    try {
      if (proxyUrl && platform) {
        // Admin-configured proxy is the egress trust boundary. Preserve the target
        // hostname for proxy-side DNS and TLS identity instead of resolving locally.
        proxy = new ProxyAgent({
          uri: proxyUrlSchema.parse(proxyUrl)!,
          proxyTunnel: false,
          connections: 1,
          connectTimeout: 10000,
        })
        this.proxyAgents.add(proxy)
        combinedSignal.addEventListener('abort', destroyProxy, { once: true })
      } else if (proxyUrl) {
        const parsed = new URL(proxyUrlSchema.parse(proxyUrl)!)
        const target = new URL(url)
        validateBase(target.origin, this.allowPrivate)
        if (
          !this.allowPrivate &&
          privateAddress(parsed.hostname.replace(/^\[|\]$/g, '')) &&
          isIP(parsed.hostname.replace(/^\[|\]$/g, ''))
        )
          throw new Error('Private proxy address is not allowed')
        const resolve = (hostname: string) =>
          new Promise<string>((resolve, reject) => {
            const aborted = () => reject(combinedSignal.reason)
            combinedSignal.addEventListener('abort', aborted, { once: true })
            if (combinedSignal.aborted) {
              aborted()
              return
            }
            lookup(
              hostname.replace(/^\[|\]$/g, ''),
              { all: true },
              (error, addresses) => {
                combinedSignal.removeEventListener('abort', aborted)
                if (error) return reject(error)
                if (
                  !addresses.length ||
                  (!this.allowPrivate &&
                    addresses.some((x) => privateAddress(x.address)))
                )
                  return reject(
                    new Error(
                      'Private upstream or proxy address is not allowed',
                    ),
                  )
                resolve(addresses[0]!.address)
              },
            )
          })
        const [targetIp, proxyIp] = await Promise.all([
          resolve(target.hostname),
          resolve(parsed.hostname),
        ])
        combinedSignal.throwIfAborted()
        if (target.protocol === 'http:') {
          const pinned = new URL(url)
          pinned.hostname = isIP(targetIp) === 6 ? `[${targetIp}]` : targetIp
          requestUrl = pinned.toString()
          proxyTargetHost = target.host
        }

        const destination = `${isIP(targetIp) === 6 ? `[${targetIp}]` : targetIp}:${target.port || (target.protocol === 'https:' ? 443 : 80)}`
        proxy = new ProxyAgent({
          uri: parsed.toString(),
          proxyTunnel: false,
          connections: 1,
          connectTimeout: 10000,
          proxyTls: {
            lookup: (_host, opts, callback) => {
              if (opts.all)
                callback(null, [{ address: proxyIp, family: isIP(proxyIp) }])
              else callback(null, proxyIp, isIP(proxyIp))
            },
          },
          clientFactory: (origin, opts) =>
            new Pool(origin, opts).compose(
              (dispatch) => (options, handler) =>
                dispatch(
                  {
                    ...options,
                    path:
                      options.method === 'CONNECT' ? destination : options.path,
                  },
                  handler,
                ),
            ),
        })
        this.proxyAgents.add(proxy)
        combinedSignal.addEventListener('abort', destroyProxy, { once: true })
      }
      // Timeout settings belong to this dispatch, not an origin pool.
      const dispatcher = (
        proxy ?? (platform ? this.platformAgent : this.agent)
      ).compose((dispatch) => (options, handler) => {
        let outgoingHeaders = options.headers
        if (proxyTargetHost) {
          // Fetch owns Host, so set the preserved identity at dispatch time.
          if (Array.isArray(outgoingHeaders)) {
            const filtered: string[] = []
            for (let index = 0; index < outgoingHeaders.length; index += 2)
              if (outgoingHeaders[index]!.toLowerCase() !== 'host')
                filtered.push(
                  outgoingHeaders[index]!,
                  outgoingHeaders[index + 1]!,
                )
            outgoingHeaders = [...filtered, 'host', proxyTargetHost]
          } else outgoingHeaders = { ...outgoingHeaders, host: proxyTargetHost }
        }
        return dispatch(
          {
            ...options,
            headers: outgoingHeaders,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
          },
          handler,
        )
      })
      return await fetch(requestUrl, {
        method,
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        headers,
        signal: combinedSignal,
        dispatcher,
        redirect: 'manual',
      })
    } finally {
      clearTimeout(timer)
      if (proxy) {
        const closing = proxy
        // close waits for consumption/cancellation of the active response body.
        void closing
          .close()
          .catch(() => closing.destroy().catch(() => {}))
          .finally(() => {
            combinedSignal.removeEventListener('abort', destroyProxy)
            this.proxyAgents.delete(closing)
          })
      }
    }
  }
  send(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal,
    timeoutMs = 120000,
    proxyUrl?: string | null,
    platform = false,
  ) {
    return this.request(
      url,
      'POST',
      body,
      headers,
      signal,
      timeoutMs,
      proxyUrl,
      platform,
    )
  }
  discover(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    timeoutMs = 30000,
    proxyUrl?: string | null,
    platform = false,
  ) {
    return this.request(
      url,
      'GET',
      undefined,
      headers,
      signal,
      timeoutMs,
      proxyUrl,
      platform,
    )
  }
  close() {
    return Promise.all([
      this.agent.close(),
      this.platformAgent.close(),
      ...[...this.proxyAgents].map((agent) =>
        agent.close().catch(() => agent.destroy().catch(() => {})),
      ),
    ])
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
