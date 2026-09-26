import { createHash } from 'node:crypto'
import { publicRouteSchema } from './schema'
import { routeBase } from './transport'
import { supportedModels, supportsModel } from './account-models'
import type { gw_routes, gw_public_routes } from '@/db/schema/gateway'
import type { RouteMigrationAccount } from './repository'

type SourceRoute = typeof gw_routes.$inferSelect
export type RouteMigrationSnapshot = {
  routes: SourceRoute[]
  accounts: RouteMigrationAccount[]
  publicRoutes: (typeof gw_public_routes.$inferSelect)[]
}
export function routeMigrationPreflight(
  snapshot: RouteMigrationSnapshot,
  allowPrivate: boolean,
) {
  const accounts = [...snapshot.accounts].sort((a, b) => a.id - b.id)
  const groups = new Map<string, SourceRoute[]>()
  for (const row of [...snapshot.routes].sort((a, b) => a.id - b.id)) {
    const list = groups.get(row.model) || []
    list.push(row)
    groups.set(row.model, list)
  }
  const items = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, sources]) => {
      const reasons: { code: string; message: string }[] = []
      let blocked = false
      const add = (code: string, message: string, blocking = true) => {
        if (!reasons.some((reason) => reason.code === code))
          reasons.push({ code, message })
        if (blocking) blocked = true
      }
      const publicConflict = snapshot.publicRoutes.find(
        (row) => row.model === model,
      )
      if (publicConflict)
        add('alias_conflict', '已存在同名公开路由，不能覆盖。')
      const candidates = sources.map((row) => {
        const account = accounts.find(
          (account) => account.id === row.upstream_id,
        )
        const parsed = publicRouteSchema.safeParse({
          ...row,
          fallback_enabled: false,
        })
        if (!parsed.success)
          add('invalid_public_shape', '旧配置字段超出公开路由约束，需先修正。')
        if (!account) add('missing_account', '绑定账号不存在。')
        else {
          if (row.enabled && !account.enabled)
            add(
              'disabled_binding',
              '生效路由绑定了停用账号，需先处理启停状态。',
            )
          if (
            [row.upstream_model, row.vision_model].some(
              (target) => target && !supportsModel(account, target),
            )
          )
            add('unsupported_target', '账号未声明支持实际模型或含图模型。')
          if (row.upstream_base) {
            try {
              routeBase(account.base_url, row.upstream_base, allowPrivate)
            } catch {
              add('invalid_override', '覆盖地址不符合当前账号同源或网络策略。')
            }
          }
        }
        return {
          source_id: row.id,
          account_id: row.upstream_id,
          account_name: account?.name ?? null,
          enabled: row.enabled,
          priority: row.priority,
          upstream_model: row.upstream_model,
          vision_model: row.vision_model,
          has_base_override: Boolean(row.upstream_base),
        }
      })
      const sourceAccounts = new Set(sources.map((row) => row.upstream_id))
      const targets = [
        ...new Set(
          sources.flatMap((row) =>
            [row.upstream_model, row.vision_model].filter(
              (value): value is string => Boolean(value),
            ),
          ),
        ),
      ].sort()
      const additionalAccounts = accounts
        .filter(
          (account) =>
            account.enabled &&
            !sourceAccounts.has(account.id) &&
            targets.some((target) => supportsModel(account, target)),
        )
        .map((account) => ({
          id: account.id,
          name: account.name,
          priority: account.priority,
        }))
      if (sources.length > 1) {
        add(
          'multiple_candidates',
          '多个候选不能直接等同于绑定账号加自动回退，选择顺序和重试行为可能变化。',
          false,
        )
        if (
          new Set(
            sources.map((row) =>
              JSON.stringify([row.upstream_model, row.vision_model]),
            ),
          ).size > 1
        )
          add(
            'different_targets',
            '候选使用不同实际模型或含图模型，不能合并为一个目标。',
            false,
          )
        if (sources.some((row) => row.upstream_base))
          add(
            'candidate_overrides',
            '候选含独立覆盖地址；公开路由仅对绑定主账号应用覆盖地址。',
            false,
          )
        if (additionalAccounts.length)
          add('expanded_pool', '启用自动回退可能纳入旧候选之外的账号。', false)
      }
      const status = blocked
        ? 'blocked'
        : sources.length === 1
          ? 'ready_for_review'
          : 'manual_review'
      const source = sources[0]!
      const proposal =
        status === 'ready_for_review'
          ? publicRouteSchema.parse({ ...source, fallback_enabled: false })
          : null
      // No credential bytes, health counters or transient cooldowns enter this version.
      const version = createHash('sha256')
        .update(
          JSON.stringify({
            schema: 1,
            allowPrivate,
            sources,
            accounts: accounts.map((account) => ({
              ...account,
              supported_models: [...supportedModels(account)].sort(),
            })),
            publicConflict: publicConflict ?? null,
          }),
        )
        .digest('hex')
      return {
        model,
        status,
        version,
        source_ids: sources.map((row) => row.id),
        candidates,
        reasons,
        additional_accounts: additionalAccounts,
        proposal,
      }
    })
  return {
    schema_version: 1,
    read_only: true,
    items,
    summary: {
      total: items.length,
      ready_for_review: items.filter((row) => row.status === 'ready_for_review')
        .length,
      manual_review: items.filter((row) => row.status === 'manual_review')
        .length,
      blocked: items.filter((row) => row.status === 'blocked').length,
    },
  }
}
