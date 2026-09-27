import { object } from './protocol/compat-helpers'
import { z } from 'zod'
import { GatewayError } from './schema'
import { utcNowIso } from '@/common/serialize'
import { hashToken, mintToken } from './crypto'
import type { GatewayService } from './service'
import type { KeyRow } from './repository'

export function legacyPat(row: Omit<KeyRow, 'digest'>) {
  const now = Date.now()
  const status = row.revoked
    ? 'revoked'
    : row.expires_at && Date.parse(row.expires_at) <= now
      ? 'expired'
      : 'active'
  const iso = (value: string | null) =>
    value ? utcNowIso(new Date(value)) + 'Z' : null
  return {
    id: row.id,
    user_id: row.owner_id,
    name: row.name,
    token_type: row.kind,
    scopes: row.scopes,
    note: row.note,
    token_prefix: row.prefix,
    status,
    expires_in_days:
      row.expires_at && status === 'active'
        ? Math.max(0, Math.floor((Date.parse(row.expires_at) - now) / 86400000))
        : null,
    expires_at: iso(row.expires_at),
    revoked_at: iso(row.revoked_at),
    last_used_at: iso(row.last_used_at),
    created_at: iso(row.created_at),
  }
}
const createSchema = z.object({
  name: z
    .string()
    .trim()
    .max(100)
    .default('default')
    .transform((value) => value || 'default'),
  token_type: z.literal('personal').default('personal'),
  scopes: z.preprocess(
    (value) => (value === null ? undefined : value),
    z
      .array(z.enum(['chat', 'profile']))
      .min(1)
      .default(['chat', 'profile'])
      .transform((value) => [...new Set(value)]),
  ),
  note: z.string().trim().max(255).nullable().optional(),
  expires_days: z.preprocess(
    (value) => (value === '' || value == null ? null : value),
    z.coerce.number().int().min(1).max(3650).nullable(),
  ),
})
export function legacyUsageFilters(query: unknown, keyId?: number) {
  const pageNumber = (fallback: number, maximum: number) =>
    z.preprocess(
      (value) =>
        typeof value === 'string' &&
        /^[+-]?\d+$/.test(value.trim()) &&
        Number.isSafeInteger(Number(value))
          ? Math.min(maximum, Math.max(1, Number(value)))
          : fallback,
      z.number(),
    )
  return (
    z
      .object({
        pat_id: z.preprocess(
          (value) => (value === '' || value == null ? undefined : value),
          z.coerce.number().int().positive().safe().optional(),
        ),
        page: pageNumber(1, Number.MAX_SAFE_INTEGER),
        per_page: pageNumber(20, 100),
        days: z.preprocess(
          (value) => (value === '' || value == null ? 7 : value),
          z.coerce.number().int().min(1).max(365),
        ),
        model: z.string().trim().max(128).optional(),
        status: z.preprocess(
          (value) => (value === '' ? undefined : value),
          z
            .enum([
              'ok',
              'upstream_error',
              'stream_error',
              'client_error',
              'routing_error',
              'protocol_error',
              'quota_exceeded',
              'reserved',
              'interrupted',
            ])
            .optional(),
        ),
      })
      // A PAT-specific path is authoritative over any query-supplied PAT id.
      .parse(
        keyId === undefined
          ? query
          : { ...(query as object), pat_id: undefined },
      )
  )
}
export function legacyUsageItem({
  row,
  legacy_status,
  attempt_count,
  pat_name,
  pat_token_type,
}: Awaited<
  ReturnType<GatewayService['repo']['legacyMineUsage']>
>['rows'][number]) {
  const iso = (value: string) => utcNowIso(new Date(value)) + 'Z'
  const context = row.request_context
  const purpose = [
    ['model', '模型请求'],
    ['compaction', '上下文压缩'],
    ['title', '会话标题'],
  ].find(([code]) => context?.client_request_id?.includes(`:${code}:`))
  return {
    id: row.id,
    request_id: row.id,
    parent_request_id: (typeof object(context).parent_request_id === 'string' ? object(context).parent_request_id : null) ?? (typeof row.raw_usage?.parent_request_id === 'string' ? row.raw_usage.parent_request_id : null),
    session_id: context?.session_id ?? null,
    client_request_id: context?.client_request_id ?? null,
    step_index: context?.step_index ?? null,
    retry_index: context?.retry_index ?? null,
    model: row.model,
    inbound_protocol: row.protocol,
    upstream_protocol: row.upstream_protocol
      ? ((
          {
            openai: 'openai-chat',
            responses: 'openai-responses',
            anthropic: 'anthropic-messages',
          } as Record<string, string>
        )[row.upstream_protocol] ?? row.upstream_protocol)
      : null,
    prompt_tokens: row.input_tokens,
    completion_tokens: row.output_tokens,
    total_tokens: row.input_tokens + row.output_tokens,
    context_tokens_estimate: context?.context_tokens_estimate ?? null,
    context_bytes: context?.context_bytes ?? null,
    message_count: context?.message_count ?? null,
    tool_count: context?.tool_count ?? null,
    image_count: context?.image_count ?? null,
    tool_result_bytes: context?.tool_result_bytes ?? null,
    largest_message_bytes: context?.largest_message_bytes ?? null,
    cache_read_tokens: row.cache_read_tokens,
    cache_write_tokens: row.cache_write_tokens,
    cache_miss_tokens: row.cache_miss_tokens,
    cache_miss_source: row.cache_miss_source,
    usage_source: row.usage_source,
    latency_ms: row.duration_ms,
    status: legacy_status,
    http_status: row.http_status,
    // Match the Python personal-view redaction of internal fallback traces.
    error_summary:
      attempt_count > 1 && row.error?.includes('账号调用链：')
        ? '请求过程中已自动切换备用账号'
        : row.error || '',
    attempt_count,
    fallback_used: attempt_count > 1,
    pat_name,
    pat_token_type,
    request_purpose: purpose ? { code: purpose[0], label: purpose[1] } : null,
    created_at: iso(row.created_at),
  }
}
export class LegacyPatService {
  constructor(readonly gateway: GatewayService) {}
  async usage(
    owner: number,
    keyId: number | undefined,
    query: unknown,
    options?: { limit: number; ids?: string[] },
  ) {
    const filters = legacyUsageFilters(query, keyId)
    const result =
      keyId === undefined
        ? await this.gateway.repo.legacyMineUsage(
            owner,
            options
              ? {
                  ...filters,
                  page: 1,
                  per_page: options.limit,
                  ids: options.ids,
                }
              : filters,
            filters.pat_id,
          )
        : await this.gateway.repo.legacyPatUsage(owner, keyId, filters)
    if (!result) throw new GatewayError(404, '令牌不存在')
    const items = result.rows.map(legacyUsageItem)
    return {
      items,
      total: result.total,
      page: filters.page,
      per_page: filters.per_page,
    }
  }
  async create(owner: number, body: unknown) {
    const value = createSchema.parse(body || {})
    const token = mintToken()
    const row = await this.gateway.repo.createKey({
      owner_id: owner,
      name: value.name,
      kind: 'personal',
      scopes: value.scopes,
      note: value.note || null,
      models: ['*'],
      daily_limit: 0,
      concurrency_limit: 0,
      rpm_limit: 0,
      digest: hashToken(token),
      prefix: token.slice(0, 12),
      expires_at: value.expires_days
        ? utcNowIso(new Date(Date.now() + value.expires_days * 86400000)) + 'Z'
        : null,
    })
    return { ...legacyPat(row), token }
  }
  async list(owner: number, query: unknown) {
    const value = z
      .object({
        page: z.string().optional(),
        per_page: z.string().optional(),
        search: z.string().optional(),
        status: z.string().optional(),
        token_type: z.string().optional(),
      })
      .parse(query)
    const integer = (value: string | undefined, fallback: number) =>
      value &&
      /^[-+]?\d+$/.test(value.trim()) &&
      Number.isSafeInteger(Number(value))
        ? Number(value)
        : fallback
    const page = Math.max(1, integer(value.page, 1)),
      perPage = Math.min(100, Math.max(1, integer(value.per_page, 20)))
    const result = await this.gateway.repo.legacyKeyPage(
      owner,
      page,
      perPage,
      value.search?.trim(),
      value.status?.trim(),
      value.token_type?.trim(),
    )
    return {
      items: result.items.map((row) => ({
        ...legacyPat(row),
        requests_7d:
          result.usage.find((stat) => stat.key_id === row.id)?.requests_7d || 0,
        tokens_7d:
          result.usage.find((stat) => stat.key_id === row.id)?.tokens_7d || 0,
      })),
      total: result.total,
      page,
      per_page: perPage,
    }
  }
}
