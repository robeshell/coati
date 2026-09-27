import { z } from 'zod'
import { utcNowIso } from '@/common/serialize'
import { poolRoute } from './pool-route'
import type { UpstreamRow } from './repository'
import { supportsModel } from './account-models'
import type { GatewayRepository } from './repository'
const boolean = (value: string) =>
  Boolean(value) &&
  !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase())
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
  provider: z.string().trim().optional(),
  credential_id: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().safe().optional(),
  ),
  enabled: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value === '' ? undefined : boolean(value),
    ),
  include_summary: z
    .string()
    .optional()
    .transform((value) => Boolean(value && boolean(value))),
})
type Entry = Awaited<
  ReturnType<GatewayRepository['publicRouteAdminPage']>
>['rows'][number]
const protocols: Record<string, string> = {
  openai: 'openai-chat',
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
}
const date = (value: string | null) => {
  if (!value) return null
  const utc =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00(?::00)?)$/.exec(
      value,
    )
  if (utc)
    return `${utc[1]}T${utc[2]}${utc[3] ? '.' + utc[3].padEnd(6, '0') : ''}Z`
  return utcNowIso(new Date(value)) + 'Z'
}

export function legacyRouteRecord(route: Entry['route']) {
  return {
    id: route.id,
    model_name: route.model,
    upstream_base: route.upstream_base,
    upstream_model: route.upstream_model,
    vision_model: route.vision_model,
    credential_id: route.upstream_id,
    description: route.description,
    fallback_enabled: route.fallback_enabled,
    enabled: route.enabled,
    created_at: date(route.created_at),
    updated_at: date(route.updated_at),
  }
}
function serialize({ route, account }: Entry, accounts: UpstreamRow[]) {
  const effective = route.upstream_model || route.model
  const warnings: string[] = []
  if (route.upstream_id !== null && !account) warnings.push('绑定的模型账号不存在')
  if (route.enabled && route.upstream_id === null && !accounts.some(candidate => poolRoute(route, candidate))) warnings.push('没有启用且支持目标模型的候选账号')
  if (account) {
    if (!account.enabled) warnings.push('绑定的 Key 已停用')
    if (['unhealthy', 'cooldown'].includes(account.health_status))
      warnings.push(`绑定的 Key 当前${account.health_status}`)
    if (!supportsModel(account, effective))
      warnings.push('上游模型不在该 Key 已发现的模型列表中')
    if (route.vision_model && !supportsModel(account, route.vision_model))
      warnings.push('含图时模型不在该 Key 已发现的模型列表中')
  }
  return {
    ...legacyRouteRecord(route),
    credential: account
      ? {
          id: account.id,
          name: account.name,
          provider: account.provider,
          upstream_protocol: protocols[account.protocol] || account.protocol,
          health_status: account.health_status,
          enabled: account.enabled,
        }
      : null,
    effective_model: effective,
    effective_base: route.upstream_base || account?.base_url || null,
    selection_mode: account ? 'bound' : 'automatic',
    readiness: warnings.length ? 'attention' : 'ready',
    warnings,
  }
}
export async function listLegacyRoutes(
  repo: GatewayRepository,
  input: unknown,
) {
  const query = querySchema.parse(input)
  const [result, accounts] = await Promise.all([repo.publicRouteAdminPage(query), repo.upstreams()])
  const usage = new Map(result.usage.map((row) => [row.model, row]))
  const items = result.rows.map((row) => {
    const stats = usage.get(row.route.model)
    return {
      ...serialize(row, accounts),
      usage_7d: {
        requests: stats?.requests || 0,
        tokens: stats?.tokens || 0,
        last_used_at: date(stats?.last_used_at || null),
      },
    }
  })
  return {
    items,
    total: result.total,
    page: query.page,
    per_page: query.per_page,
    ...(query.include_summary
      ? {
          summary: {
            total: result.all.length,
            enabled: result.all.filter((row) => row.route.enabled).length,
            disabled: result.all.filter((row) => !row.route.enabled).length,
            attention: result.all.filter(
              (row) => row.route.enabled && serialize(row, accounts).readiness === 'attention',
            ).length,
          },
        }
      : {}),
  }
}
