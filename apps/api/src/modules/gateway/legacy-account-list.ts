import { z } from 'zod'
import { utcNowIso } from '@/common/serialize'
import { supportedModels } from './account-models'
import { accountSummary } from './account-metadata'
import type { GatewayRepository, UpstreamRow } from './repository'

const pageNumber = (fallback: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      const parsed =
        value && /^[+-]?\d+$/.test(value.trim()) ? Number(value) : fallback
      return Math.max(1, Math.min(max, parsed))
    })
const querySchema = z.object({
  page: pageNumber(1, Math.floor(Number.MAX_SAFE_INTEGER / 100)),
  per_page: pageNumber(20, 100),
  search: z.string().trim().optional(),
  upstream_protocol: z.string().trim().optional(),
  provider: z.string().trim().optional(),
  health_status: z.string().trim().optional(),
  enabled: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value === ''
        ? undefined
        : !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase()),
    ),
})
const protocols: Record<string, string> = {
  openai: 'openai-chat',
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
}
const date = (value: string | null) => {
  if (!value) return null
  const parsed =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      value,
    )
  if (parsed) {
    let offset = parsed[4] || 'Z'
    if (/^[+-]\d{2}$/.test(offset)) offset += ':00'
    const base = utcNowIso(new Date(`${parsed[1]}T${parsed[2]}${offset}`))
    const fraction =
      parsed[3] && Number(parsed[3]) ? '.' + parsed[3].padEnd(6, '0') : ''
    return `${base}${fraction}Z`
  }
  return utcNowIso(new Date(value)) + 'Z'
}
// Explicit allowlist: never serialize credential ciphertext or probe claims.
export function legacyAccountRecord(row: UpstreamRow, now = Date.now()) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    upstream_protocol: protocols[row.protocol] || row.protocol,
    base_url: row.base_url,
    api_key_masked: row.api_key_hint || '****',
    key_fingerprint: row.key_fingerprint,
    supported_models: supportedModels(row),
    default_model: row.default_model,
    model_prefix: row.model_prefix || '',
    extra_headers: row.extra_headers,
    proxy_enabled: Boolean(row.proxy_secret),
    proxy_hint: row.proxy_hint || '',
    priority: row.priority,
    weight: row.weight,
    request_timeout_seconds: row.request_timeout_seconds,
    enabled: row.enabled,
    note: row.note,
    health_status: row.health_status,
    consecutive_failures: row.consecutive_failures,
    last_checked_at: date(row.last_checked_at),
    last_success_at: date(row.last_success_at),
    last_error_at: date(row.last_error_at),
    last_error: row.last_error,
    last_latency_ms: row.last_latency_ms,
    cooldown_until: date(row.cooldown_until),
    cooldown_active: Boolean(
      row.cooldown_until && Date.parse(row.cooldown_until) > now,
    ),
    last_used_at: date(row.last_used_at),
    scope: row.scope,
    owner_user_id: row.owner_user_id,
    created_at: date(row.created_at),
    updated_at: date(row.updated_at),
  }
}
export async function listLegacyAccounts(
  repo: GatewayRepository,
  input: unknown,
  owner?: number,
) {
  const query = querySchema.parse(input)
  const result = await repo.legacyAccountPage(query, owner)
  const now = Date.now()
  return {
    items: result.rows.map((row) => legacyAccountRecord(row, now)),
    total: result.total,
    page: query.page,
    per_page: query.per_page,
    summary: accountSummary(result.all, now),
  }
}
