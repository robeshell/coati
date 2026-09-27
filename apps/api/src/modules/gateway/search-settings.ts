import { z } from 'zod'
import type { GatewayService } from './service'
import { SearchSettingsRepository } from './search-settings-repository'
import { proxyHint, proxyUrlSchema } from './account-proxy'
import { TavilySearchProvider } from './search-provider'
import { GatewayError } from './schema'
const input = z
  .object({
    provider: z.enum(['', 'tavily']),
    api_key: z.string().trim().max(8192).optional(),
    clear_api_key: z.boolean().default(false),
    proxy_url: proxyUrlSchema.optional(),
    clear_proxy: z.boolean().default(false),
    timeout_seconds: z.coerce.number().int().min(3).max(60).default(15),
  })
  .strict()
export class SearchSettingsService {
  readonly repo: SearchSettingsRepository
  constructor(
    private readonly gateway: GatewayService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly providerBase?: string,
  ) {
    this.repo = new SearchSettingsRepository(gateway.repo.db)
  }
  private async effective() {
    const stored = await this.repo.read()
    const decrypt = (field: 'api_key' | 'proxy_url', fallback: string) =>
      Object.hasOwn(stored, field)
        ? stored[field]
          ? this.gateway.vault.decrypt(stored[field]!)
          : ''
        : fallback
    const provider =
      stored.provider ??
      (this.env.AGENT_WEBSEARCH_PROVIDER ?? '').trim().toLowerCase()
    const envTimeout = Number(this.env.AGENT_WEBSEARCH_TIMEOUT_SECONDS || 15)
    return {
      provider,
      api_key: decrypt('api_key', this.env.AGENT_WEBSEARCH_API_KEY ?? ''),
      proxy_url: decrypt('proxy_url', this.env.AGENT_WEBSEARCH_PROXY_URL ?? ''),
      timeout_seconds:
        stored.timeout_seconds ??
        (Number.isInteger(envTimeout) && envTimeout >= 3 && envTimeout <= 60
          ? envTimeout
          : 15),
      source: Object.fromEntries(
        ['provider', 'api_key', 'proxy_url', 'timeout_seconds'].map((key) => [
          key,
          Object.hasOwn(stored, key) ? 'database' : 'environment',
        ]),
      ),
    }
  }
  async view() {
    const config = await this.effective()
    let proxy_hint: string | null = null
    try {
      proxy_hint = proxyHint(config.proxy_url || null)
    } catch {
      proxy_hint = '代理地址无效'
    }
    return {
      provider: config.provider,
      has_api_key: Boolean(config.api_key),
      has_proxy: Boolean(config.proxy_url),
      proxy_hint,
      timeout_seconds: config.timeout_seconds,
      source: config.source,
      configured: config.provider === 'tavily' && Boolean(config.api_key),
    }
  }
  async save(raw: unknown) {
    const data = input.parse(raw)
    if (data.clear_api_key && data.api_key)
      throw new GatewayError(400, '不能同时替换和清除 API Key')
    if (data.clear_proxy && data.proxy_url)
      throw new GatewayError(400, '不能同时替换和清除代理')
    await this.repo.update((current) => ({
      ...current,
      provider: data.provider,
      timeout_seconds: data.timeout_seconds,
      ...(data.clear_api_key
        ? { api_key: '' }
        : data.api_key
          ? { api_key: this.gateway.vault.encrypt(data.api_key) }
          : {}),
      ...(data.clear_proxy
        ? { proxy_url: '' }
        : data.proxy_url
          ? { proxy_url: this.gateway.vault.encrypt(data.proxy_url) }
          : {}),
    }))
    return this.view()
  }
  async reset() {
    await this.repo.update(() => ({}))
    return this.view()
  }
  async provider() {
    const config = await this.effective()
    if (!config.provider) return null
    if (config.provider !== 'tavily')
      throw new GatewayError(
        503,
        '搜索服务配置了不支持的供应商',
        'search_unconfigured',
      )
    if (!config.api_key) return null
    return new TavilySearchProvider(this.gateway.transport, {
      apiKey: config.api_key,
      proxyUrl: proxyUrlSchema.parse(config.proxy_url || null),
      timeoutMs: config.timeout_seconds * 1000,
      baseUrl: this.providerBase,
    })
  }
  async test(signal: AbortSignal) {
    const provider = await this.provider()
    if (!provider) throw new GatewayError(400, '尚未配置搜索后端或 API Key')
    const sources = await provider.search(
      { query: 'coati coding agent gateway', limit: 3 },
      signal,
    )
    return {
      ok: true,
      provider: 'tavily',
      result_count: sources.length,
      sample: sources.map((source) => source.url),
    }
  }
}
