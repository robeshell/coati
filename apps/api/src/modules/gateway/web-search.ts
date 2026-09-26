import { delegatedSearch } from './delegated-search'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { GatewayService } from './service'
import { SearchSettingsService } from './search-settings'
import { GatewayError } from './schema'
import type { SearchSource } from './search-provider'
import { requestContext } from './request-context'
import { reservationTtlSeconds } from './quota-policy'
import { utcNowIso } from '@/common/serialize'

const input = z
  .object({
    query: z.string().trim().min(1).max(400),
    max_results: z.preprocess(value => {
      if (value == null) return 5
      const numeric = typeof value === 'string'
        ? (/^[+-]?\d+$/.test(value.trim()) ? Number(value) : NaN)
        : typeof value === 'number' || typeof value === 'boolean' ? Number(value) : NaN
      return Number.isFinite(numeric) ? Math.min(8, Math.max(1, Math.trunc(numeric))) : NaN
    }, z.number().int().min(1).max(8)),
  })
  .strict()
const estimate = (value: unknown) =>
  Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 3)
export class WebSearchService {
  constructor(
    private readonly gateway: GatewayService,
    private readonly settings = new SearchSettingsService(gateway),
  ) {}
  async run(
    key: Awaited<ReturnType<GatewayService['authenticate']>>,
    raw: unknown,
    clientSignal: AbortSignal,
    headers: Record<string, unknown> = {},
  ) {
    if (!key.scopes.includes('chat'))
      throw new GatewayError(403, '令牌缺少 chat 权限', 'insufficient_scope')
    if (!key.models.includes('*') && !key.models.includes('web-search'))
      throw new GatewayError(
        403,
        '令牌未授权 web-search 能力',
        'model_forbidden',
      )
    const body = input.parse(raw)
    const id = randomUUID(),
      started = Date.now(),
      prompt = estimate(body.query)
    const values = {
      id,
      model: 'web-search',
      protocol: 'web-search',
      reserved_tokens: prompt + 4096,
      request_context: requestContext(
        { messages: [{ role: 'user', content: body.query }] },
        headers,
        this.gateway.options.traceKey ?? this.gateway.options.encryptionKey,
      ),
      expires_at: utcNowIso(new Date(Date.now() + (this.gateway.options.reservationTtlSeconds ?? reservationTtlSeconds()) * 1000)) + 'Z',
    }
    const denied = await this.gateway.repo.reserve(key.id, values)
    if (denied) {
      const status =
        denied === 'unauthorized'
          ? 401
          : ['insufficient_scope', 'model_not_allowed'].includes(denied)
            ? 403
            : 429
      const error = new GatewayError(status, denied, denied)
      error.requestId = id
      if (status === 429)
        await this.gateway.repo.recordRejected({
          ...values,
          key_id: key.id,
          reserved_tokens: 0,
          status: 'quota_exceeded',
          http_status: status,
          error: denied,
          duration_ms: Date.now() - started,
        })
      throw error
    }
    const settle = async (values: Parameters<typeof this.gateway.repo.finish>[1]) => {
      try {
        const rows = await this.gateway.repo.finish(id, values)
        if (rows.length !== 1) throw new Error('Search settlement did not update reservation')
      } catch {
        const error = new GatewayError(500, '用量结算失败，请使用请求 ID 联系管理员', 'settlement_failed')
        error.requestId = id
        throw error
      }
    }
    let result: { query: string; sources: SearchSource[]; truncated: boolean }
    let attempted = false
    const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(65000)])
    try {
      if (signal.aborted) throw new GatewayError(499, '请求已取消', 'cancelled')
      const provider = await this.settings.provider()
      if (!provider)
        throw new GatewayError(
          503,
          '未配置可用的搜索服务',
          'search_unconfigured',
        )
      if (signal.aborted)
        throw new GatewayError(
          clientSignal.aborted ? 499 : 504,
          clientSignal.aborted ? '请求已取消' : '搜索超时',
          clientSignal.aborted ? 'cancelled' : 'search_timeout',
        )
      attempted = true
      const sources = await provider.search(
        { query: body.query, limit: body.max_results },
        signal,
      )
      let truncated = false
      // Keep the response estimate within the atomic reservation; never invent provider token usage.
      while (estimate(sources) > 4096) {
        const longest = sources.reduce(
          (best, item) =>
            (item.snippet?.length ?? 0) > (best?.snippet?.length ?? 0)
              ? item
              : best,
          sources[0],
        )
        if (longest?.snippet)
          longest.snippet = longest.snippet.slice(
            0,
            Math.floor(longest.snippet.length / 2),
          )
        else sources.pop()
        truncated = true
      }
      result = { query: body.query, sources, truncated }
    } catch (cause) {
      const error =
        cause instanceof GatewayError
          ? cause
          : new GatewayError(502, '搜索服务不可用', 'search_failed')
      error.requestId = id
      await settle({
        status: error.status === 499 ? 'cancelled' : 'upstream_error',
        http_status: error.status,
        error: error.message,
        duration_ms: Date.now() - started,
        input_tokens: 0,
        output_tokens: 0,
        usage_source: 'estimated',
        raw_usage: {
          provider: attempted ? 'tavily' : null,
          search_requests: attempted ? 1 : 0,
        },
      })
      if (!signal.aborted && error.status !== 499 && error.status !== 504) {
        try {
          return await delegatedSearch(
            this.gateway,
            key,
            body.query,
            body.max_results,
            signal,
            headers,
            id,
          )
        } catch (fallback) {
          if (
            fallback instanceof GatewayError &&
            fallback.code === 'search_unconfigured'
          )
            throw error
          throw fallback
        }
      }
      throw error
    }
    await settle({
      status: 'ok',
      http_status: 200,
      duration_ms: Date.now() - started,
      input_tokens: prompt,
      output_tokens: estimate(result.sources),
      usage_source: 'estimated',
      raw_usage: {
        provider: 'tavily',
        search_requests: 1,
        result_count: result.sources.length,
      },
    })
    return { id, json: result }
  }
}
