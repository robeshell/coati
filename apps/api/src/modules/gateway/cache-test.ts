import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CacheTestRepository } from './cache-test-repository'
import { GatewayError } from './schema'
import type { GatewayService } from './service'
import type { gw_requests } from '@/db/schema/gateway'
export const cacheTestInput = z.object({
  name: z.string().trim().min(1).max(100),
  key_id: z.coerce.number().int().positive().nullish(),
  model: z.string().trim().min(1).max(200),
  prompt: z.string().min(1).max(200000),
  rounds: z.coerce.number().int().min(1).max(5).default(3),
  max_tokens: z.coerce.number().int().min(1).max(512).default(32),
})
export const cacheTestQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
})
type Usage = typeof gw_requests.$inferSelect
function roundUsage(row: Usage | undefined) {
  const read = row?.cache_read_tokens ?? null,
    write = row?.cache_write_tokens ?? null,
    miss = row?.cache_miss_tokens ?? null
  const known = read !== null || write !== null || miss !== null
  const observed = known ? (read ?? 0) + (write ?? 0) + (miss ?? 0) : null
  const complete = read !== null && miss !== null
  return {
    request_id: row?.id ?? null,
    input_tokens: row?.input_tokens ?? null,
    output_tokens: row?.output_tokens ?? null,
    usage_source: row?.usage_source ?? null,
    cache_read_tokens: read,
    cache_write_tokens: write,
    cache_miss_tokens: miss,
    cache_miss_source: row?.cache_miss_source ?? null,
    cache_observed_tokens: observed,
    cache_status: complete ? 'complete' : known ? 'partial' : 'unreported',
    hit_ratio: complete ? (observed! > 0 ? read / observed! : 0) : null,
    upstream_id: row?.execution?.upstream_id ?? null,
    upstream_name: row?.execution?.upstream_name ?? null,
    upstream_model: row?.execution?.upstream_model ?? null,
    upstream_protocol: row?.upstream_protocol ?? null,
  }
}
type Round = ReturnType<typeof roundUsage> & {
  round: number
  status: string
  latency_ms: number
  http_status: number | null
  error: string | null
}
function summarize(rounds: Round[]) {
  const successful = rounds.filter((row) => row.status === 'ok')
  const identities = new Set(
    successful
      .filter((row) => row.upstream_id !== null)
      .map((row) => JSON.stringify([row.upstream_id, row.upstream_model])),
  )
  const complete =
    successful.length > 0 &&
    successful.every((row) => row.cache_status === 'complete')
  const observed = successful.reduce(
    (sum, row) => sum + (row.cache_observed_tokens ?? 0),
    0,
  )
  const cacheRead = successful.some((row) => row.cache_read_tokens !== null)
    ? successful.reduce((sum, row) => sum + (row.cache_read_tokens ?? 0), 0)
    : null
  return {
    completed_rounds: successful.length,
    attempted_rounds: rounds.length,
    account_consistent:
      successful.length > 0 &&
      successful.every((row) => row.upstream_id !== null)
        ? identities.size === 1
        : null,
    cache_read_tokens: cacheRead,
    cache_write_tokens: successful.some(
      (row) => row.cache_write_tokens !== null,
    )
      ? successful.reduce((sum, row) => sum + (row.cache_write_tokens ?? 0), 0)
      : null,
    cache_miss_tokens: successful.some((row) => row.cache_miss_tokens !== null)
      ? successful.reduce((sum, row) => sum + (row.cache_miss_tokens ?? 0), 0)
      : null,
    cache_status: complete
      ? 'complete'
      : successful.some((row) => row.cache_status !== 'unreported')
        ? 'partial'
        : 'unreported',
    hit_ratio: complete ? (observed > 0 ? cacheRead! / observed : 0) : null,
    total_latency_ms: rounds.reduce((sum, row) => sum + row.latency_ms, 0),
    warning:
      identities.size > 1
        ? '测试期间切换了账号或上游模型，命中率不代表同一缓存池'
        : !complete
          ? '上游缓存用量未完整上报，无法计算完整命中率'
          : null,
  }
}
export class CacheTestService {
  readonly repo: CacheTestRepository
  constructor(readonly gateway: GatewayService) {
    this.repo = new CacheTestRepository(gateway.repo.db)
  }
  async keys(owner: number) {
    return (await this.gateway.keys(owner))
      .filter(
        (row) =>
          !row.revoked &&
          (!row.expires_at || Date.parse(row.expires_at) > Date.now()) &&
          row.scopes.includes('chat'),
      )
      .map((row) => ({ id: row.id, name: row.name, prefix: row.prefix }))
  }
  async models(owner: number, id?: number) {
    return this.gateway.models(
      id ? await this.gateway.authenticateOwnedKey(owner, id) : { owner_id: owner, scopes: ['chat'], models: ['*'] },
    )
  }
  async run(owner: number, raw: unknown, signal: AbortSignal) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(900000)])
    const input = cacheTestInput.parse(raw)
    // Validate before calling or creating a result. Each round rechecks key lifetime;
    // reservation rechecks scopes/model/quotas under the normal gateway locks.
    const identity = () => input.key_id
      ? this.gateway.authenticateOwnedKey(owner, input.key_id)
      : this.gateway.repo.cacheIdentity(owner)
    await identity()
    const session = `cachetest-${randomUUID()}`
    const body = {
      model: input.model,
      messages: [{ role: 'user', content: input.prompt }],
      max_tokens: input.max_tokens,
      stream: false,
    }
    const rounds: Round[] = []
    const { key_id: _key, ...fields } = input
    const record = await this.repo.create({
      ...fields,
      user_id: owner,
      status: 'running',
      summary: summarize(rounds),
      results: [],
    })
    for (let i = 0; i < input.rounds; i++) {
      const start = Date.now()
      try {
        if (signal.aborted) throw new GatewayError(499, '缓存验证已取消')
        const key = await identity()
        const response = await this.gateway.execute(
          key,
          body,
          'openai',
          signal,
          { 'x-coati-session-id': session },
        )
        const usage = await this.repo.usage(owner, response.id)
        rounds.push({
          ...roundUsage(usage),
          request_id: response.id,
          round: i + 1,
          status: 'ok',
          latency_ms: Date.now() - start,
          http_status: usage?.http_status ?? 200,
          error: null,
        })
      } catch (error) {
        const known = error instanceof GatewayError
        const usage =
          known && error.requestId
            ? await this.repo.usage(owner, error.requestId)
            : undefined
        rounds.push({
          ...roundUsage(usage),
          request_id: usage?.id ?? (known ? error.requestId : null) ?? null,
          round: i + 1,
          status: 'failed',
          latency_ms: Date.now() - start,
          http_status: known ? error.status : 500,
          error: known
            ? error.message.slice(0, 500)
            : '缓存验证执行失败，请查看服务日志',
        })
        if (!known) this.gateway.report(error)
      }
      await this.repo.checkpoint(owner, record.id, {
        status: 'running',
        summary: summarize(rounds),
        results: [...rounds],
        error_summary: rounds.find((row) => row.error)?.error ?? null,
      })
      if (rounds.at(-1)?.status === 'failed') break
    }
    const success = rounds.filter((row) => row.status === 'ok').length
    return this.repo.checkpoint(owner, record.id, {
      status: success === input.rounds ? 'ok' : success ? 'partial' : 'failed',
      summary: summarize(rounds),
      results: rounds,
      error_summary: rounds.find((row) => row.error)?.error ?? null,
    })
  }
}
