import { isIP } from 'node:net'
import { z } from 'zod'
import {
  GatewayTransport,
  privateAddress,
  readBounded,
  validateBase,
} from './transport'
import { GatewayError } from './schema'
import { upstreamTimeout } from './upstream-failure'

export type SearchSource = {
  url: string
  title: string
  snippet?: string
  publishedAt?: string
}
/** Legacy filters accept a host plus optional path; path matching is segment-bound. */
export const domainFilter = z.string().trim().min(1).max(2048).transform((raw, ctx) => {
  try {
    const value = raw.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '')
    const url = new URL('https://' + value)
    const host = url.hostname.replace(/^www\./, '').replace(/\.$/, '')
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host)) throw new Error('domain')
    const path = url.pathname.replace(/\/+$/, '')
    return host + path
  } catch {
    ctx.addIssue({code:'custom',message:'域名过滤条件无效'})
    return z.NEVER
  }
})
const filters = {
  allowed_domains: z.array(domainFilter).max(100).default([]),
  blocked_domains: z.array(domainFilter).max(100).default([]),
}
const searchInput = z.object({
  query: z.string().trim().min(1).max(800),
  limit: z.number().int().min(1).max(20).default(5),
  ...filters,
})
const fetchInput = z.object({
  url: z.string().trim().min(1).max(2048),
  max_characters: z.number().int().min(1).max(200000).default(50000),
  ...filters,
})
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
export function webpage(raw: string): URL | null {
  try {
    const url = new URL(raw),
      host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      (!host.includes('.') && !isIP(host)) ||
      (isIP(host) && privateAddress(host))
    )
      return null
    return url
  } catch {
    return null
  }
}
export function permitted(url: URL, allowed: string[], blocked: string[]) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  const path = url.pathname.toLowerCase().replace(/\/+$/, '')
  const match = (entry: string) => {
    const parsed = domainFilter.safeParse(entry)
    if (!parsed.success) return false
    const [domain, ...segments] = parsed.data.split('/')
    const prefix = segments.length ? '/' + segments.join('/') : ''
    return (host === domain || host.endsWith('.' + domain)) &&
      (!prefix || path === prefix || path.startsWith(prefix + '/'))
  }
  return !blocked.some(match) && (!allowed.length || allowed.some(match))
}
export interface SearchProviderOptions {
  apiKey: string
  timeoutMs?: number
  proxyUrl?: string | null
  /** Deployment-owned endpoint override for isolated tests/self-hosted compatible services. Never a request field. */
  baseUrl?: string
}
/** Python Tavily contract. Fetch targets are payloads sent to the provider, never gateway destinations. */
export class TavilySearchProvider {
  private readonly base: string
  private readonly timeout: number
  constructor(
    readonly transport: GatewayTransport,
    private readonly options: SearchProviderOptions,
  ) {
    if (!options.apiKey.trim())
      throw new GatewayError(
        503,
        '搜索服务未配置 API Key',
        'search_unconfigured',
      )
    this.base = validateBase(
      options.baseUrl ?? 'https://api.tavily.com',
      transport.allowPrivate,
    )
    this.timeout = z
      .number()
      .int()
      .min(3000)
      .max(60000)
      .parse(options.timeoutMs ?? 15000)
  }
  private async post(path: string, body: unknown, signal: AbortSignal) {
    const combined = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.timeout),
    ])
    try {
      combined.throwIfAborted()
      const response = await this.transport.send(
        this.base + path,
        body,
        {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        combined,
        this.timeout,
        this.options.proxyUrl,
        true,
      )
      const raw = await readBounded(response, 2 * 1024 * 1024)
      if (response.status === 401 || response.status === 403)
        throw new GatewayError(
          502,
          '搜索服务鉴权失败，请检查 API Key',
          'search_auth_failed',
        )
      if (response.status === 429)
        throw new GatewayError(429, '搜索服务触发限流', 'search_rate_limited')
      if (!response.ok)
        throw new GatewayError(
          502,
          `搜索服务返回 HTTP ${response.status}`,
          'search_upstream_error',
        )
      try {
        return obj(JSON.parse(raw))
      } catch {
        throw new GatewayError(
          502,
          '搜索服务返回非 JSON',
          'search_invalid_response',
        )
      }
    } catch (error) {
      if (signal.aborted)
        throw new GatewayError(499, '搜索或抓取已取消', 'search_cancelled')
      if (combined.aborted || upstreamTimeout(error))
        throw new GatewayError(504, '搜索或抓取超时', 'search_timeout')
      if (error instanceof GatewayError) throw error
      // Raw transport/provider diagnostics may contain authorization or proxy credentials.
      throw new GatewayError(
        502,
        '搜索服务连接失败，请检查服务端网络和代理',
        'search_connection_failed',
      )
    }
  }
  async search(raw: unknown, signal: AbortSignal): Promise<SearchSource[]> {
    const input = searchInput.parse(raw)
    const body = await this.post(
      '/search',
      {
        query: input.query,
        max_results: input.limit,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
        ...(input.allowed_domains.length
          ? { include_domains: [...new Set(input.allowed_domains.map(entry => entry.split('/')[0]))] }
          : {}),
        ...(input.blocked_domains.some(entry => !entry.includes('/'))
          ? { exclude_domains: input.blocked_domains.filter(entry => !entry.includes('/')) }
          : {}),
      },
      signal,
    )
    if (!Array.isArray(body.results))
      throw new GatewayError(
        502,
        '搜索服务返回结构无法解析',
        'search_invalid_response',
      )
    const sources: SearchSource[] = [],
      seen = new Set<string>()
    for (const rawItem of body.results) {
      const item = obj(rawItem),
        url = webpage(text(item.url))
      if (
        !url ||
        !permitted(url, input.allowed_domains, input.blocked_domains) ||
        seen.has(url.href)
      )
        continue
      seen.add(url.href)
      const snippet = text(item.content).slice(0, 20000),
        published = text(item.published_date).slice(0, 100)
      sources.push({
        url: url.href,
        title: (text(item.title) || url.href).slice(0, 1000),
        ...(snippet ? { snippet } : {}),
        ...(published ? { publishedAt: published } : {}),
      })
      if (sources.length >= input.limit) break
    }
    return sources
  }
  async fetch(raw: unknown, signal: AbortSignal) {
    const input = fetchInput.parse(raw),
      target = webpage(input.url)
    if (
      !target ||
      !permitted(target, input.allowed_domains, input.blocked_domains)
    )
      throw new GatewayError(
        422,
        '网页地址不符合访问范围',
        'fetch_url_not_allowed',
      )
    const body = await this.post(
      '/extract',
      { urls: target.href, format: 'markdown', extract_depth: 'basic' },
      signal,
    )
    if (!Array.isArray(body.results))
      throw new GatewayError(
        502,
        '抓取服务返回结构无法解析',
        'fetch_invalid_response',
      )
    for (const rawItem of body.results) {
      const item = obj(rawItem),
        content = text(item.raw_content)
      if (!content) continue
      const finalUrl = webpage(text(item.url) || target.href)
      if (
        !finalUrl ||
        !permitted(finalUrl, input.allowed_domains, input.blocked_domains)
      )
        throw new GatewayError(
          422,
          '抓取结果跳转到了不允许的域名',
          'fetch_url_not_allowed',
        )
      return {
        url: finalUrl.href,
        title: text(item.title).slice(0, 1000) || null,
        text: content.slice(0, input.max_characters),
        retrieved_at: null,
        truncated: content.length > input.max_characters,
      }
    }
    throw new GatewayError(502, '搜索服务未能抓取该页面', 'fetch_empty_result')
  }
}
