import { capabilityCandidate, type SearchCapability } from './capability-route'
import { schedulingPolicy as loadSchedulingPolicy, type SchedulingPolicy } from './scheduling-policy'
import { affinityModelKey } from './session-affinity'
import { personalRoute, personalModelNames } from './personal-route'
import { routeMigrationPreflight } from './route-preflight'
import { poolRoute, automaticRoute, type Candidate, type ResolvedRoute } from './pool-route'
import { GatewayError } from './schema'
import { supportsModel, supportedModels } from './account-models'
import type { UsageScope } from './usage-analytics-repository'
import { loadAdminsWithRolesByIds } from '@/common/auth'
import { deviceStartPolicy, type DeviceStartPolicy } from './device-policy'
import { defaultDailyQuota } from './quota-policy'
import { gatewayTimezone } from './timezone'
import { randomUUID } from 'node:crypto'
import { admin_users } from '@/db/schema/admin/rbac'
import { and, eq, asc, desc, sql, inArray, or, ilike } from 'drizzle-orm'
import type { Db } from '@/db/client'
import {
  gw_upstreams,
  gw_routes,
  gw_public_routes,
  gw_route_migrations,
  gw_keys,
  gw_requests,
  gw_attempts,
  gw_devices,
  gw_upstream_leases,
  gw_session_bindings,
  gw_user_limits,
} from '@/db/schema/gateway'
// Python bills completed output, including partial streams/client cancellation.
// Expired/interrupted workers retain an audit record, never a fabricated charge.
const platformAccount = () =>
  and(
    eq(gw_upstreams.scope, 'platform'),
    sql`${gw_upstreams.owner_user_id} IS NULL`,
  )
const billable = sql`${gw_requests.status} in ('ok','stream_error','client_error','cancelled')`
const billedTokens = sql`case when ${billable} then ${gw_requests.input_tokens}+${gw_requests.output_tokens} else 0 end`
export type UpstreamRow = typeof gw_upstreams.$inferSelect
export type RouteMigrationAccount = Pick<
  UpstreamRow,
  | 'id'
  | 'name'
  | 'base_url'
  | 'enabled'
  | 'protocol'
  | 'priority'
  | 'weight'
  | 'concurrency_limit'
  | 'supported_models'
  | 'default_model'
>
export type KeyRow = typeof gw_keys.$inferSelect
export type RequestRow = typeof gw_requests.$inferSelect
export class GatewayRepository {
  readonly quotaTimezone: string
  constructor(
    readonly db: Db,
    timezone?: string,
    readonly defaultQuota = defaultDailyQuota(),
    readonly schedulingPolicy: SchedulingPolicy = loadSchedulingPolicy(),
  ) {
    this.quotaTimezone = gatewayTimezone(timezone)
  }
  protected quotaClock() {
    return sql`clock_timestamp()`
  }
  async capabilityCandidates(capability: SearchCapability): Promise<Candidate[]> {
    // An explicit alias, including a disabled alias, wins over automatic capability discovery.
    const configured = await this.db.select({id:gw_public_routes.id}).from(gw_public_routes).where(eq(gw_public_routes.model, capability))
    if (configured.length || (await this.db.select({id:gw_routes.id}).from(gw_routes).where(eq(gw_routes.model, capability)).limit(1)).length) return []
    const accounts = await this.db.select().from(gw_upstreams).where(and(platformAccount(), eq(gw_upstreams.enabled, true),
      sql`(${gw_upstreams.cooldown_until} IS NULL OR ${gw_upstreams.cooldown_until} <= now())`))
    return accounts.flatMap(account => { const candidate = capabilityCandidate(account, capability); return candidate ? [candidate] : [] })
  }
  async selectedUpstream(requestId: string) {
    const [row] = await this.db.select({upstream:gw_upstreams}).from(gw_attempts)
      .innerJoin(gw_upstreams, eq(gw_attempts.upstream_id, gw_upstreams.id))
      .where(eq(gw_attempts.request_id, requestId)).orderBy(desc(gw_attempts.id)).limit(1)
    return row?.upstream
  }
  upstreams() {
    return this.db
      .select()
      .from(gw_upstreams)
      .where(platformAccount())
      .orderBy(asc(gw_upstreams.id))
  }
  async legacyAccountPage(
    query: {
      page: number
      per_page: number
      search?: string
      upstream_protocol?: string
      provider?: string
      health_status?: string
      enabled?: boolean
    },
    owner?: number,
  ) {
    const scope =
      owner === undefined
        ? platformAccount()
        : and(
            eq(gw_upstreams.scope, 'personal'),
            eq(gw_upstreams.owner_user_id, owner),
          )
    // Search must use the public Python protocol names, including their suffixes.
    const protocol = sql<string>`case ${gw_upstreams.protocol}
      when 'openai' then 'openai-chat'
      when 'responses' then 'openai-responses'
      when 'anthropic' then 'anthropic-messages'
      else ${gw_upstreams.protocol} end`
    const condition = and(
      scope,
      query.search
        ? or(
            ilike(gw_upstreams.name, `%${query.search}%`),
            ilike(protocol, `%${query.search}%`),
            ilike(gw_upstreams.default_model, `%${query.search}%`),
          )
        : undefined,
      query.enabled === undefined
        ? undefined
        : eq(gw_upstreams.enabled, query.enabled),
      query.upstream_protocol
        ? eq(protocol, query.upstream_protocol)
        : undefined,
      query.provider ? eq(gw_upstreams.provider, query.provider) : undefined,
      query.health_status
        ? eq(gw_upstreams.health_status, query.health_status)
        : undefined,
    )
    return this.db.transaction(
      async (tx) => {
        const rows = await tx
          .select()
          .from(gw_upstreams)
          .where(condition)
          .orderBy(desc(gw_upstreams.id))
          .limit(query.per_page)
          .offset((query.page - 1) * query.per_page)
        const [count] = await tx
          .select({ total: sql<number>`count(*)`.mapWith(Number) })
          .from(gw_upstreams)
          .where(condition)
        const all = await tx
          .select({
            enabled: gw_upstreams.enabled,
            health_status: gw_upstreams.health_status,
            cooldown_until: gw_upstreams.cooldown_until,
            last_used_at: gw_upstreams.last_used_at,
          })
          .from(gw_upstreams)
          .where(scope)
        return { rows, total: count?.total || 0, all }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
  async writePlatformAccount(
    build: (row: UpstreamRow | undefined) => typeof gw_upstreams.$inferInsert,
    id?: number,
  ) {
    return this.db.transaction(async (tx) => {
      const existing =
        id === undefined
          ? undefined
          : (
              await tx
                .select()
                .from(gw_upstreams)
                .where(and(eq(gw_upstreams.id, id), platformAccount()))
                .for('update')
            )[0]
      if (id !== undefined && !existing)
        throw new GatewayError(404, '凭证不存在')
      const values = {
        ...build(existing),
        scope: 'platform',
        owner_user_id: null,
        model_prefix: '',
      }
      const [row] = existing
        ? await tx
            .update(gw_upstreams)
            .set(values)
            .where(eq(gw_upstreams.id, existing.id))
            .returning()
        : await tx.insert(gw_upstreams).values(values).returning()
      return row!
    })
  }
  async copyPlatformAccount(id: number) {
    return this.db.transaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(gw_upstreams)
        .where(and(eq(gw_upstreams.id, id), platformAccount()))
        .for('share')
      if (!source) throw new GatewayError(404, '凭证不存在')
      const [row] = await tx
        .insert(gw_upstreams)
        .values({
          name: [...source.name].slice(0, 96).join('') + '（复制）',
          provider: source.provider,
          protocol: source.protocol,
          base_url: source.base_url,
          secret: source.secret,
          api_key_hint: source.api_key_hint,
          key_fingerprint: source.key_fingerprint,
          supported_models: source.supported_models,
          default_model: source.default_model,
          priority: source.priority,
          weight: source.weight,
          concurrency_limit: source.concurrency_limit,
          request_timeout_seconds: source.request_timeout_seconds,
          enabled: source.enabled,
          note: source.note,
          extra_headers: source.extra_headers,
          proxy_secret: source.proxy_secret,
          proxy_hint: source.proxy_hint,
          scope: 'platform',
          owner_user_id: null,
          model_prefix: '',
        })
        .returning()
      return row!
    })
  }
  async saveUpstream(values: typeof gw_upstreams.$inferInsert, id?: number) {
    const rows = id
      ? await this.db
          .update(gw_upstreams)
          .set({
            ...values,
            scope: 'platform',
            owner_user_id: null,
            model_prefix: '',
          })
          .where(and(eq(gw_upstreams.id, id), platformAccount()))
          .returning()
      : await this.db
          .insert(gw_upstreams)
          .values({
            ...values,
            scope: 'platform',
            owner_user_id: null,
            model_prefix: '',
          })
          .returning()
    return rows[0]
  }
  private async migrationSnapshot(tx: Pick<Db, 'select'>) {
    const routes = await tx.select().from(gw_routes).orderBy(asc(gw_routes.id))
    const accounts = await tx
      .select({
        id: gw_upstreams.id,
        name: gw_upstreams.name,
        base_url: gw_upstreams.base_url,
        enabled: gw_upstreams.enabled,
        protocol: gw_upstreams.protocol,
        priority: gw_upstreams.priority,
        weight: gw_upstreams.weight,
        concurrency_limit: gw_upstreams.concurrency_limit,
        supported_models: gw_upstreams.supported_models,
        default_model: gw_upstreams.default_model,
      })
      .from(gw_upstreams)
      .where(platformAccount())
      .orderBy(asc(gw_upstreams.id))
    const publicRoutes = await tx
      .select()
      .from(gw_public_routes)
      .orderBy(asc(gw_public_routes.id))
    return { routes, accounts, publicRoutes }
  }
  routeMigrationSnapshot() {
    return this.db.transaction((tx) => this.migrationSnapshot(tx), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    })
  }
  routeMigrations() {
    return this.db
      .select()
      .from(gw_route_migrations)
      .orderBy(desc(gw_route_migrations.created_at))
  }
  private samePublicRoute(
    current: typeof gw_public_routes.$inferSelect | undefined,
    saved: typeof gw_public_routes.$inferSelect,
  ) {
    return (
      current &&
      (Object.keys(saved) as (keyof typeof saved)[]).every(
        (key) => current[key] === saved[key],
      )
    )
  }
  async applyRouteMigration(
    model: string,
    version: string,
    actor: number,
    allowPrivate: boolean,
  ) {
    return this.db.transaction(async (tx) => {
      // Rare administrative transition: exclude config writes and lease row locks while
      // checking the entire snapshot. Never hold these locks during upstream I/O.
      await tx.execute(sql`set local lock_timeout = '2s'`)
      await tx.execute(
        sql`lock table gw_routes, gw_public_routes, gw_upstreams, gw_route_migrations in exclusive mode`,
      )
      const snapshot = await this.migrationSnapshot(tx)
      const previous = await tx
        .select()
        .from(gw_route_migrations)
        .where(
          and(
            eq(gw_route_migrations.model, model),
            eq(gw_route_migrations.version, version),
            sql`${gw_route_migrations.rolled_back_at} is null`,
          ),
        )
      if (previous[0]) {
        if (
          !this.samePublicRoute(
            snapshot.publicRoutes.find(
              (row) => row.id === previous[0]!.public_route.id,
            ),
            previous[0].public_route,
          )
        )
          throw new GatewayError(409, '迁移后配置已变化，请重新检查')
        return previous[0]
      }
      const item = routeMigrationPreflight(snapshot, allowPrivate).items.find(
        (row) => row.model === model,
      )
      if (!item || item.version !== version)
        throw new GatewayError(409, '配置已变化，请重新预检')
      if (item.status !== 'ready_for_review' || !item.proposal)
        throw new GatewayError(409, '该模型不能自动迁移，请先处理预检差异')
      const sources = snapshot.routes.filter((row) => row.model === model)
      const [created] = await tx
        .insert(gw_public_routes)
        .values(item.proposal)
        .returning()
      const [journal] = await tx
        .insert(gw_route_migrations)
        .values({
          model,
          version,
          actor_id: actor,
          source_routes: sources,
          public_route: created!,
        })
        .returning()
      await tx.delete(gw_routes).where(
        inArray(
          gw_routes.id,
          sources.map((row) => row.id),
        ),
      )
      return journal!
    })
  }
  async rollbackRouteMigration(id: string, actor: number) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '2s'`)
      await tx.execute(
        sql`lock table gw_routes, gw_public_routes, gw_upstreams, gw_route_migrations in exclusive mode`,
      )
      const [journal] = await tx
        .select()
        .from(gw_route_migrations)
        .where(eq(gw_route_migrations.id, id))
      if (!journal) throw new GatewayError(404, '迁移记录不存在')
      if (journal.rolled_back_at) return journal
      const snapshot = await this.migrationSnapshot(tx)
      if (
        !this.samePublicRoute(
          snapshot.publicRoutes.find(
            (row) => row.id === journal.public_route.id,
          ),
          journal.public_route,
        )
      )
        throw new GatewayError(409, '公开路由已修改或删除，不能覆盖回滚')
      if (
        snapshot.routes.some(
          (row) =>
            row.model === journal.model ||
            journal.source_routes.some((source) => source.id === row.id),
        )
      )
        throw new GatewayError(409, '旧路由名称或编号已被占用')
      if (
        journal.source_routes.some(
          (row) =>
            !snapshot.accounts.some(
              (account) => account.id === row.upstream_id,
            ),
        )
      )
        throw new GatewayError(409, '原账号不存在，不能回滚')
      await tx.insert(gw_routes).values(journal.source_routes)
      await tx
        .delete(gw_public_routes)
        .where(eq(gw_public_routes.id, journal.public_route.id))
      const [updated] = await tx
        .update(gw_route_migrations)
        .set({ rolled_back_at: sql`clock_timestamp()`, rolled_back_by: actor })
        .where(eq(gw_route_migrations.id, id))
        .returning()
      return updated!
    })
  }
  async publicRouteAdminPage(query: {
    page: number
    per_page: number
    search?: string
    provider?: string
    credential_id?: number
    enabled?: boolean
    include_summary: boolean
  }) {
    return this.db.transaction(
      async (tx) => {
        const selection = {
          route: gw_public_routes,
          account: {
            id: gw_upstreams.id,
            name: gw_upstreams.name,
            provider: gw_upstreams.provider,
            protocol: gw_upstreams.protocol,
            base_url: gw_upstreams.base_url,
            enabled: gw_upstreams.enabled,
            health_status: gw_upstreams.health_status,
            supported_models: gw_upstreams.supported_models,
            default_model: gw_upstreams.default_model,
          },
        }
        const condition = and(
          query.search
            ? or(
                ilike(gw_public_routes.model, `%${query.search}%`),
                ilike(gw_public_routes.upstream_model, `%${query.search}%`),
              )
            : undefined,
          query.enabled === undefined
            ? undefined
            : eq(gw_public_routes.enabled, query.enabled),
          query.credential_id
            ? eq(gw_public_routes.upstream_id, query.credential_id)
            : undefined,
          query.provider
            ? eq(gw_upstreams.provider, query.provider)
            : undefined,
        )
        const rows = await tx
          .select(selection)
          .from(gw_public_routes)
          .leftJoin(
            gw_upstreams,
            and(
              eq(gw_upstreams.id, gw_public_routes.upstream_id),
              platformAccount(),
            ),
          )
          .where(condition)
          .orderBy(asc(gw_public_routes.model))
          .limit(query.per_page)
          .offset((query.page - 1) * query.per_page)
        const [count] = await tx
          .select({ total: sql<number>`count(*)`.mapWith(Number) })
          .from(gw_public_routes)
          .leftJoin(
            gw_upstreams,
            and(
              eq(gw_upstreams.id, gw_public_routes.upstream_id),
              platformAccount(),
            ),
          )
          .where(condition)
        const all = query.include_summary
          ? await tx
              .select(selection)
              .from(gw_public_routes)
              .leftJoin(
                gw_upstreams,
                and(
                  eq(gw_upstreams.id, gw_public_routes.upstream_id),
                  platformAccount(),
                ),
              )
          : []
        const names = rows.map((row) => row.route.model)
        const usage = names.length
          ? await tx
              .select({
                model: gw_requests.model,
                requests: sql<number>`count(*)`.mapWith(Number),
                tokens: sql<number>`coalesce(sum(${billedTokens}),0)`.mapWith(
                  Number,
                ),
                last_used_at: sql<string>`max(${gw_requests.created_at})`,
              })
              .from(gw_requests)
              .where(
                and(
                  inArray(gw_requests.model, names),
                  sql`${gw_requests.created_at} >= now() - interval '7 days'`,
                  sql`${gw_requests.status} <> 'reserved'`,
                ),
              )
              .groupBy(gw_requests.model)
          : []
        return { rows, total: count?.total || 0, all, usage }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
  publicRoutes() {
    return this.db
      .select()
      .from(gw_public_routes)
      .orderBy(asc(gw_public_routes.model))
  }
  async savePublicRoute(
    values: typeof gw_public_routes.$inferInsert,
    id?: number,
  ) {
    return this.db.transaction(async (tx) => {
      if (values.upstream_id != null) {
        const [account] = await tx
          .select({ id: gw_upstreams.id })
          .from(gw_upstreams)
          .where(
            and(eq(gw_upstreams.id, values.upstream_id), platformAccount()),
          )
          .for('share')
        if (!account) throw new GatewayError(400, '平台路由只能绑定平台账号')
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${values.model}, 17))`,
      )
      if (
        (
          await tx
            .select()
            .from(gw_routes)
            .where(eq(gw_routes.model, values.model))
        ).length
      )
        throw new GatewayError(409, '该模型已有候选路由，请先迁移现有配置')
      const [existing] = await tx
        .select()
        .from(gw_public_routes)
        .where(eq(gw_public_routes.model, values.model))
      if (existing && existing.id !== id)
        throw new GatewayError(409, '公开模型路由已存在')
      return (
        id
          ? await tx
              .update(gw_public_routes)
              .set({ ...values, updated_at: sql`clock_timestamp()` })
              .where(eq(gw_public_routes.id, id))
              .returning()
          : await tx.insert(gw_public_routes).values(values).returning()
      )[0]
    })
  }
  async deletePublicRoute(id: number) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(gw_public_routes)
        .where(eq(gw_public_routes.id, id))
        .for('update')
      if (!row) throw new GatewayError(404, '公开路由不存在')
      if (row.enabled) throw new GatewayError(409, '请先停用公开路由')
      await tx.delete(gw_public_routes).where(eq(gw_public_routes.id, id))
      return { success: true }
    })
  }
  routes() {
    return this.db
      .select()
      .from(gw_routes)
      .orderBy(asc(gw_routes.priority), asc(gw_routes.id))
  }
  async saveRoute(values: typeof gw_routes.$inferInsert, id?: number) {
    return this.db.transaction(async (tx) => {
      if (values.upstream_id != null) {
        const [account] = await tx
          .select({ id: gw_upstreams.id })
          .from(gw_upstreams)
          .where(
            and(eq(gw_upstreams.id, values.upstream_id), platformAccount()),
          )
          .for('share')
        if (!account) throw new GatewayError(400, '平台路由只能绑定平台账号')
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${values.model}, 17))`,
      )
      if (
        (
          await tx
            .select()
            .from(gw_public_routes)
            .where(eq(gw_public_routes.model, values.model))
        ).length
      )
        throw new GatewayError(409, '该模型已配置公开路由')
      return (
        id
          ? await tx
              .update(gw_routes)
              .set(values)
              .where(eq(gw_routes.id, id))
              .returning()
          : await tx.insert(gw_routes).values(values).returning()
      )[0]
    })
  }
  async disable(resource: 'upstreams' | 'routes', id: number) {
    const table = resource === 'upstreams' ? gw_upstreams : gw_routes
    return (
      await this.db
        .update(table)
        .set({ enabled: false })
        .where(
          and(
            eq(table.id, id),
            resource === 'upstreams' ? platformAccount() : undefined,
          ),
        )
        .returning()
    )[0]
  }
  keys(ownerId?: number) {
    return this.db
      .select()
      .from(gw_keys)
      .where(and(ownerId ? eq(gw_keys.owner_id, ownerId) : undefined, sql`${gw_keys.kind} <> 'internal-cache'`))
      .orderBy(desc(gw_keys.id))
  }
  async key(digest: string) {
    return (
      await this.db.select().from(gw_keys).where(and(eq(gw_keys.digest, digest), sql`${gw_keys.kind} <> 'internal-cache'`))
    )[0]
  }
  /** Accounting identity only: never issued as a bearer token or exposed as a PAT. */
  async cacheIdentity(owner: number) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'cache-identity:' + owner}, 0))`)
      const [user] = await tx.select().from(admin_users).where(eq(admin_users.id, owner))
      if (!user) throw new GatewayError(403, '无权限')
      const [existing] = await tx.select().from(gw_keys).where(and(eq(gw_keys.owner_id, owner), eq(gw_keys.kind, 'internal-cache')))
      if (existing) return existing
      const [identity] = await tx.insert(gw_keys).values({
        owner_id: owner, name: '缓存验证', kind: 'internal-cache',
        digest: 'internal:' + randomUUID(), prefix: 'internal', scopes: ['chat'], models: ['*'],
        daily_limit: 0, concurrency_limit: 0, rpm_limit: 0,
      }).returning()
      return identity!
    })
  }
  async touchKey(id: number) {
    await this.db
      .update(gw_keys)
      .set({ last_used_at: sql`clock_timestamp()` })
      .where(and(eq(gw_keys.id, id), eq(gw_keys.revoked, false)))
  }
  async legacyPatUsage(
    owner: number,
    keyId: number,
    filters: {
      page: number
      per_page: number
      days: number
      model?: string
      status?: string
    },
  ) {
    const [key] = await this.db
      .select()
      .from(gw_keys)
      .where(and(eq(gw_keys.id, keyId), eq(gw_keys.owner_id, owner), sql`${gw_keys.kind} <> 'internal-cache'`))
    if (!key) return null
    return this.legacyMineUsage(owner, filters, keyId)
  }
  async legacyMineUsage(
    owner: number,
    filters: {
      page: number
      per_page: number
      days: number
      model?: string
      status?: string
      ids?: string[]
    },
    keyId?: number,
  ) {
    return this.legacyUsagePage({ kind: 'personal', owner }, filters, keyId)
  }
  async legacyUsagePage(
    scope: UsageScope,
    filters: {
      page: number
      per_page: number
      days: number
      model?: string
      status?: string
      ids?: string[]
    },
    keyId?: number,
  ) {
    const status = sql<string>`case when ${gw_requests.status}='error' then 'upstream_error' when ${gw_requests.status}='cancelled' then 'client_error' else ${gw_requests.status} end`
    const where = and(
      scope.owner === undefined
        ? undefined
        : sql`${gw_requests.key_id} in (select id from gw_keys where owner_id=${scope.owner})`,
      filters.ids ? inArray(gw_requests.id, filters.ids) : undefined,
      filters.ids || keyId === undefined
        ? undefined
        : eq(gw_requests.key_id, keyId),
      filters.ids
        ? undefined
        : sql`${gw_requests.created_at} >= now() - (${filters.days} * interval '1 day')`,
      filters.ids
        ? undefined
        : filters.status
          ? sql`${status}=${filters.status}`
          : sql`${gw_requests.status}<>'reserved'`,
      !filters.ids && filters.model
        ? eq(gw_requests.model, filters.model)
        : undefined,
    )
    const rows = await this.db
      .select({
        row: gw_requests,
        user_id: gw_keys.owner_id,
        username: admin_users.username,
        credential_id: sql<
          number | null
        >`(select upstream_id from gw_attempts where request_id=gw_requests.id order by id desc limit 1)`,
        pat_name: gw_keys.name,
        pat_token_type: gw_keys.kind,
        legacy_status: status,
        attempt_count: sql<number>`(select count(*)::int from gw_attempts where gw_attempts.request_id=gw_requests.id)`,
      })
      .from(gw_requests)
      .leftJoin(gw_keys, eq(gw_requests.key_id, gw_keys.id))
      .leftJoin(admin_users, eq(gw_keys.owner_id, admin_users.id))
      .where(where)
      .orderBy(desc(gw_requests.created_at), desc(gw_requests.id))
      .limit(filters.per_page)
      .offset((filters.page - 1) * filters.per_page)
    const [count] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(gw_requests)
      .where(where)
    return { rows, total: count!.total }
  }
  async legacyKeyPage(
    owner: number,
    page: number,
    perPage: number,
    search?: string,
    status?: string,
    kind?: string,
  ) {
    const where = and(
      eq(gw_keys.owner_id, owner),
      search
        ? or(
            ilike(gw_keys.name, `%${search}%`),
            ilike(gw_keys.prefix, `%${search}%`),
            ilike(gw_keys.note, `%${search}%`),
          )
        : undefined,
      sql`${gw_keys.kind} <> 'internal-cache'`,
      kind ? eq(gw_keys.kind, kind) : undefined,
      status === 'revoked'
        ? eq(gw_keys.revoked, true)
        : status === 'active'
          ? and(
              eq(gw_keys.revoked, false),
              sql`(${gw_keys.expires_at} IS NULL OR ${gw_keys.expires_at} > now())`,
            )
          : status === 'expired'
            ? and(
                eq(gw_keys.revoked, false),
                sql`${gw_keys.expires_at} <= now()`,
              )
            : undefined,
    )
    const items = await this.db
      .select()
      .from(gw_keys)
      .where(where)
      .orderBy(desc(gw_keys.id))
      .limit(perPage)
      .offset((page - 1) * perPage)
    const [count] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(gw_keys)
      .where(where)
    const usage = items.length
      ? await this.db
          .select({
            key_id: gw_requests.key_id,
            requests_7d: sql<number>`count(*)::int`,
            tokens_7d: sql<number>`coalesce(sum(${billedTokens}),0)::float8`,
          })
          .from(gw_requests)
          .where(
            and(
              inArray(
                gw_requests.key_id,
                items.map((item) => item.id),
              ),
              sql`${gw_requests.status} <> 'reserved'`,
              sql`${gw_requests.created_at} >= now()-interval '7 days'`,
            ),
          )
          .groupBy(gw_requests.key_id)
      : []
    return { items, total: count!.total, usage, page, per_page: perPage }
  }
  async createKey(values: typeof gw_keys.$inferInsert) {
    return (await this.db.insert(gw_keys).values(values).returning())[0]!
  }
  async updatePersonalKey(
    id: number,
    ownerId: number,
    name: string,
    expiresDays?: number | null,
  ) {
    return this.db.transaction(async (tx) => {
      const [key] = await tx
        .select()
        .from(gw_keys)
        .where(and(eq(gw_keys.id, id), eq(gw_keys.owner_id, ownerId), sql`${gw_keys.kind} <> 'internal-cache'`))
        .for('update')
      if (!key) return { error: 'not_found' as const }
      const clock = await tx.execute<{ valid: boolean }>(
        sql`SELECT ${key.expires_at}::timestamptz IS NULL OR ${key.expires_at}::timestamptz > clock_timestamp() AS valid`,
      )
      if (key.kind !== 'personal' || key.revoked || !clock.rows[0]!.valid)
        return { error: 'inactive' as const }
      const [row] = await tx
        .update(gw_keys)
        .set({
          name,
          expires_at:
            expiresDays == null
              ? null
              : sql`clock_timestamp() + (${expiresDays} * interval '1 day')`,
        })
        .where(eq(gw_keys.id, id))
        .returning()
      return { row: row! }
    })
  }
  async rotateKey(
    id: number,
    ownerId: number,
    credential: { digest: string; prefix: string },
  ) {
    return this.db.transaction(async (tx) => {
      const [old] = await tx
        .select()
        .from(gw_keys)
        .where(and(eq(gw_keys.id, id), eq(gw_keys.owner_id, ownerId), sql`${gw_keys.kind} <> 'internal-cache'`))
        .for('update')
      if (!old) return { error: 'not_found' as const }
      const clock = await tx.execute<{ valid: boolean }>(
        sql`SELECT ${old.expires_at}::timestamptz IS NULL OR ${old.expires_at}::timestamptz > clock_timestamp() AS valid`,
      )
      if (old.revoked || !clock.rows[0]!.valid)
        return { error: 'inactive' as const }
      const [replacement] = await tx
        .insert(gw_keys)
        .values({
          owner_id: old.owner_id,
          name: old.name,
          kind: old.kind,
          models: old.models,
          scopes: old.scopes,
          note: old.note,
          daily_limit: old.daily_limit,
          concurrency_limit: old.concurrency_limit,
          rpm_limit: old.rpm_limit,
          expires_at: old.expires_at,
          quota_group: old.quota_group,
          rotated_from_id: old.id,
          ...credential,
        })
        .returning()
      await tx
        .update(gw_keys)
        .set({
          revoked: true,
          revoked_at: sql`coalesce(${gw_keys.revoked_at}, clock_timestamp())`,
        })
        .where(eq(gw_keys.id, id))
      return { row: replacement! }
    })
  }
  async revoke(id: number, ownerId: number) {
    return (
      await this.db
        .update(gw_keys)
        .set({
          revoked: true,
          revoked_at: sql`coalesce(${gw_keys.revoked_at}, clock_timestamp())`,
        })
        .where(and(eq(gw_keys.id, id), eq(gw_keys.owner_id, ownerId), sql`${gw_keys.kind} <> 'internal-cache'`))
        .returning()
    )[0]
  }
  personalChannelRows(owner: number) {
    return this.db
      .select()
      .from(gw_upstreams)
      .where(
        and(
          eq(gw_upstreams.scope, 'personal'),
          eq(gw_upstreams.owner_user_id, owner),
        ),
      )
      .orderBy(asc(gw_upstreams.id))
  }
  async savePersonalChannel(
    owner: number,
    build: (row: UpstreamRow | undefined) => typeof gw_upstreams.$inferInsert,
    id?: number,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${owner}, 29)`)
      let existing: UpstreamRow | undefined
      if (id !== undefined) {
        ;[existing] = await tx
          .select()
          .from(gw_upstreams)
          .where(
            and(
              eq(gw_upstreams.id, id),
              eq(gw_upstreams.scope, 'personal'),
              eq(gw_upstreams.owner_user_id, owner),
            ),
          )
          .for('update')
        if (!existing) throw new GatewayError(404, '渠道不存在')
      } else {
        const [count] = await tx
          .select({ total: sql<number>`count(*)::integer` })
          .from(gw_upstreams)
          .where(
            and(
              eq(gw_upstreams.scope, 'personal'),
              eq(gw_upstreams.owner_user_id, owner),
            ),
          )
        if (count!.total >= 5)
          throw new GatewayError(400, '个人渠道最多 5 条，请先删除不用的渠道')
      }
      const values = {
        ...build(existing),
        scope: 'personal',
        owner_user_id: owner,
      }
      const [row] = existing
        ? await tx
            .update(gw_upstreams)
            .set(values)
            .where(eq(gw_upstreams.id, existing.id))
            .returning()
        : await tx.insert(gw_upstreams).values(values).returning()
      return row!
    })
  }
  deletePersonalChannel(owner: number, id: number) {
    return this.deleteAccount(id, owner)
  }
  async deleteAccount(id: number, owner?: number) {
    return this.db.transaction(async (tx) => {
      if (owner !== undefined)
        await tx.execute(sql`select pg_advisory_xact_lock(${owner}, 29)`)
      const [row] = await tx
        .select()
        .from(gw_upstreams)
        .where(
          and(
            eq(gw_upstreams.id, id),
            owner === undefined
              ? platformAccount()
              : and(
                  eq(gw_upstreams.scope, 'personal'),
                  eq(gw_upstreams.owner_user_id, owner),
                ),
          ),
        )
        .for('update')
      if (!row)
        throw new GatewayError(
          404,
          owner === undefined ? '凭证不存在' : '渠道不存在',
        )
      if (row.enabled)
        throw new GatewayError(
          409,
          owner === undefined ? '请先停用模型账号' : '请先停用个人渠道',
        )
      const probe = await tx.execute(
        sql`select probe_token is not null and probe_expires_at > clock_timestamp() as active from gw_upstreams where id=${id}`,
      )
      if (probe.rows[0]?.active)
        throw new GatewayError(409, '渠道正在探测，请稍后重试')
      const references = await tx.execute(
        sql`select 1 from gw_routes where upstream_id=${id} union all select 1 from gw_public_routes where upstream_id=${id} limit 1`,
      )
      if (references.rows.length)
        throw new GatewayError(
          409,
          owner === undefined
            ? '该账号仍被模型路由使用，请先解除路由绑定'
            : '该个人渠道仍被模型路由使用，请先解除路由绑定',
        )
      const leases = await tx
        .select({ id: gw_upstream_leases.request_id })
        .from(gw_upstream_leases)
        .where(eq(gw_upstream_leases.upstream_id, id))
        .limit(1)
      if (leases.length)
        throw new GatewayError(409, '渠道仍有在途请求，请稍后重试')
      await tx.delete(gw_upstreams).where(eq(gw_upstreams.id, id))
      return { ok: true }
    })
  }
  personalAccounts(owner: number) {
    return this.db
      .select()
      .from(gw_upstreams)
      .where(
        and(
          eq(gw_upstreams.scope, 'personal'),
          eq(gw_upstreams.owner_user_id, owner),
          eq(gw_upstreams.enabled, true),
        ),
      )
      .orderBy(asc(gw_upstreams.id))
  }
  async candidates(
    model: string,
    includeCooling = false,
    needsVision = false,
    owner?: number,
  ): Promise<Candidate[]> {
    if (owner !== undefined) {
      const rows = await this.db
        .select({
          upstream: gw_upstreams,
          available: sql<boolean>`(${gw_upstreams.cooldown_until} IS NULL OR ${gw_upstreams.cooldown_until} <= now())`,
        })
        .from(gw_upstreams)
        .where(
          and(
            eq(gw_upstreams.scope, 'personal'),
            eq(gw_upstreams.owner_user_id, owner),
            eq(gw_upstreams.enabled, true),
          ),
        )
      const personal = rows.flatMap(({ upstream, available }) => {
        const route = personalRoute(upstream, owner, model)
        return route ? [{ route, upstream, available }] : []
      })
      // A matched personal pool owns this selection even when every account cools.
      if (personal.length)
        return personal
          .filter((row) => includeCooling || row.available)
          .map(({ route, upstream }) => ({ route, upstream }))
    }
    const [config] = await this.db
      .select()
      .from(gw_public_routes)
      .where(eq(gw_public_routes.model, model))
    if (config) {
      const accounts = await this.db
        .select()
        .from(gw_upstreams)
        .where(
          and(
            platformAccount(),
            eq(gw_upstreams.enabled, true),
            includeCooling
              ? undefined
              : sql`(${gw_upstreams.cooldown_until} IS NULL OR ${gw_upstreams.cooldown_until} <= now())`,
          ),
        )
      return accounts.flatMap((upstream) => {
        const route = poolRoute(config, upstream, needsVision)
        return route ? [{ route, upstream }] : []
      })
    }
    const explicit = await this.db
      .select({ route: gw_routes, upstream: gw_upstreams })
      .from(gw_routes)
      .innerJoin(
        gw_upstreams,
        and(eq(gw_routes.upstream_id, gw_upstreams.id), platformAccount()),
      )
      .where(
        and(
          eq(gw_routes.model, model),
          eq(gw_routes.enabled, true),
          platformAccount(),
          eq(gw_upstreams.enabled, true),
          includeCooling
            ? undefined
            : sql`(${gw_upstreams.cooldown_until} IS NULL OR ${gw_upstreams.cooldown_until} <= now())`,
        ),
      )
      .orderBy(asc(gw_routes.priority), asc(gw_routes.id))
    if (explicit.length || needsVision) return explicit
    if ((await this.db.select({ id: gw_routes.id }).from(gw_routes).where(eq(gw_routes.model, model)).limit(1)).length) return explicit
    const accounts = await this.db.select().from(gw_upstreams).where(and(platformAccount(), eq(gw_upstreams.enabled, true),
      includeCooling ? undefined : sql`(${gw_upstreams.cooldown_until} IS NULL OR ${gw_upstreams.cooldown_until} <= now())`))
    return accounts.flatMap(upstream => {
      const route = automaticRoute(upstream, model)
      return route ? [{ route, upstream }] : []
    })
  }
  async environmentTarget(model: string, owner: number, fallbackModel: string) {
    // A personal pool owns matching names even if all of its accounts are cooling.
    const personal = await this.personalAccounts(owner)
    if (personal.some(account => personalRoute(account, owner, model))) return null
    const config = (await this.publicRoutes()).find(route => route.model === model)
    if (config && (!config.enabled || (config.upstream_id !== null && !config.fallback_enabled))) return null
    if ((config?.upstream_model || config?.model || model) !== fallbackModel) return null
    return { config }
  }
  async acquireUpstream(
    routeId: number,
    model: string,
    requestId: string,
    expiresAt: string,
    affinity?: { scope: string; modelKey?: string; owner: number; eligible: number[]; ttlSeconds?: number },
    needsVision = false,
    publicTarget?: number,
    personalOwner?: number,
    automaticPool = false,
    capability?: SearchCapability,
  ) {
    return this.db.transaction(async (tx) => {
      if (affinity)
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${affinity.scope}, 0))`,
        )
      let route: ResolvedRoute | undefined
      let publicConfig: typeof gw_public_routes.$inferSelect | undefined
      if (automaticPool) {
        // A newly configured alias takes precedence over an earlier pool snapshot.
        const configured = await tx.select({ id: gw_public_routes.id }).from(gw_public_routes).where(eq(gw_public_routes.model, model))
        if (configured.length || (await tx.select({ id: gw_routes.id }).from(gw_routes).where(eq(gw_routes.model, model)).limit(1)).length) return null
        const [account] = await tx.select().from(gw_upstreams).where(eq(gw_upstreams.id, routeId))
        route = account ? (capability && model === capability ? capabilityCandidate(account, capability)?.route : automaticRoute(account, model) ?? undefined) : undefined
      } else if (personalOwner !== undefined) {
        const [account] = await tx
          .select()
          .from(gw_upstreams)
          .where(eq(gw_upstreams.id, routeId))
        route = account
          ? (personalRoute(account, personalOwner, model) ?? undefined)
          : undefined
      } else if (publicTarget !== undefined) {
        ;[publicConfig] = await tx
          .select()
          .from(gw_public_routes)
          .where(eq(gw_public_routes.id, routeId))
          .for('share')
        const [account] = await tx
          .select()
          .from(gw_upstreams)
          .where(eq(gw_upstreams.id, publicTarget))
        route =
          publicConfig && account
            ? (poolRoute(publicConfig, account, needsVision) ?? undefined)
            : undefined
      } else {
        ;[route] = await tx
          .select()
          .from(gw_routes)
          .where(eq(gw_routes.id, routeId))
          .for('share')
      }
      if (!route || !route.enabled || route.model !== model) return null
      if (needsVision && !route.vision_model?.trim()) return null
      // Do not write a binding under a namespace computed before an alias edit.
      if (affinity?.modelKey && (route.public_route || route.automatic_pool) &&
        affinity.modelKey !== affinityModelKey(route.public_route ? route.id : undefined,
          model, (needsVision ? route.vision_model : route.upstream_model) || model)) return null
      if (affinity) {
        await tx
          .delete(gw_session_bindings)
          .where(
            and(
              eq(gw_session_bindings.scope, affinity.scope),
              sql`${gw_session_bindings.expires_at} <= now()`,
            ),
          )
        const [bound] = await tx
          .select()
          .from(gw_session_bindings)
          .where(eq(gw_session_bindings.scope, affinity.scope))
        // The request's eligible IDs are only a snapshot. Recheck the bound
        // account's routes and model declarations before honoring that binding.
        let boundEligible = Boolean(
          bound && affinity.eligible.includes(bound.upstream_id),
        )
        if (bound && boundEligible) {
          if (personalOwner !== undefined) {
            const [account] = await tx
              .select()
              .from(gw_upstreams)
              .where(
                and(
                  eq(gw_upstreams.id, bound.upstream_id),
                  sql`(${gw_upstreams.cooldown_until} IS NULL OR ${gw_upstreams.cooldown_until} <= now())`,
                ),
              )
            boundEligible = Boolean(
              account && personalRoute(account, personalOwner, model),
            )
          } else if (automaticPool) {
            const [account] = await tx.select().from(gw_upstreams).where(and(eq(gw_upstreams.id, bound.upstream_id),
              sql`(${gw_upstreams.cooldown_until} IS NULL OR ${gw_upstreams.cooldown_until} <= now())`))
            boundEligible = Boolean(account && automaticRoute(account, model))
          } else if (publicConfig) {
            const [account] = await tx
              .select()
              .from(gw_upstreams)
              .where(
                and(
                  eq(gw_upstreams.id, bound.upstream_id),
                  sql`(${gw_upstreams.cooldown_until} IS NULL OR ${gw_upstreams.cooldown_until} <= now())`,
                ),
              )
            boundEligible = Boolean(
              account && poolRoute(publicConfig, account, needsVision),
            )
          } else {
            const live = await tx
              .select({ route: gw_routes, upstream: gw_upstreams })
              .from(gw_routes)
              .innerJoin(
                gw_upstreams,
                eq(gw_routes.upstream_id, gw_upstreams.id),
              )
              .where(
                and(
                  eq(gw_upstreams.id, bound.upstream_id),
                  platformAccount(),
                  eq(gw_upstreams.enabled, true),
                  eq(gw_routes.enabled, true),
                  eq(gw_routes.model, model),
                  sql`(${gw_upstreams.cooldown_until} IS NULL OR ${gw_upstreams.cooldown_until} <= now())`,
                ),
              )
            boundEligible = live.some(({ route, upstream }) => {
              const target = needsVision
                ? route.vision_model
                : route.upstream_model
              return Boolean(target && supportsModel(upstream, target))
            })
          }
        }
        if (bound && boundEligible && bound.upstream_id !== route.upstream_id)
          return null
        if (bound && !boundEligible)
          await tx
            .delete(gw_session_bindings)
            .where(
              and(
                eq(gw_session_bindings.scope, affinity.scope),
                eq(gw_session_bindings.upstream_id, bound.upstream_id),
              ),
            )
      }
      let [upstream] = await tx
        .select()
        .from(gw_upstreams)
        .where(eq(gw_upstreams.id, route.upstream_id))
        .for('update')
      if (
        !upstream ||
        (personalOwner === undefined &&
          (upstream.scope !== 'platform' || upstream.owner_user_id !== null)) ||
        !upstream.enabled
      )
        return null
      if (capability) {
        const fresh = capabilityCandidate(upstream, capability)
        if (!fresh || model !== capability) return null
        upstream = fresh.upstream
        route = fresh.route
      }
      if (personalOwner !== undefined) {
        const fresh = personalRoute(upstream, personalOwner, model)
        if (!fresh) return null
        route = fresh
      }
      if (publicConfig) {
        const fresh = poolRoute(publicConfig, upstream, needsVision)
        if (!fresh) return null
        route = fresh
      }
      if (
        !supportsModel(
          upstream,
          needsVision ? route.vision_model! : route.upstream_model,
        )
      )
        return null
      const [state] = await tx
        .select({
          cooling: sql<boolean>`${gw_upstreams.cooldown_until} > now()`,
        })
        .from(gw_upstreams)
        .where(eq(gw_upstreams.id, upstream.id))
      if (state?.cooling) return null
      await tx
        .delete(gw_upstream_leases)
        .where(
          and(
            eq(gw_upstream_leases.upstream_id, upstream.id),
            sql`${gw_upstream_leases.expires_at} <= now()`,
          ),
        )
      const [load] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(gw_upstream_leases)
        .where(eq(gw_upstream_leases.upstream_id, upstream.id))
      if (load!.count >= upstream.concurrency_limit) {
        if (affinity)
          await tx
            .delete(gw_session_bindings)
            .where(
              and(
                eq(gw_session_bindings.scope, affinity.scope),
                eq(gw_session_bindings.upstream_id, upstream.id),
              ),
            )
        return null
      }
      await tx.insert(gw_upstream_leases).values({
        request_id: requestId,
        upstream_id: upstream.id,
        expires_at: expiresAt,
      })
      if (affinity)
        await tx
          .insert(gw_session_bindings)
          .values({
            scope: affinity.scope,
            owner_id: affinity.owner,
            model: affinity.modelKey ?? model,
            upstream_id: upstream.id,
            expires_at: sql`now() + (${affinity.ttlSeconds ?? 3600} * interval '1 second')`,
          })
          .onConflictDoUpdate({
            target: gw_session_bindings.scope,
            set: { expires_at: sql`now() + (${affinity.ttlSeconds ?? 3600} * interval '1 second')`, updated_at: sql`now()` },
            setWhere: sql`${gw_session_bindings.expires_at} <= now() + (${(affinity.ttlSeconds ?? 3600) / 2} * interval '1 second')`,
          })
      return { route, upstream }
    })
  }
  async poolLoad(model: string, eligible?: number[]) {
    const candidateFilter = eligible === undefined ? undefined : eligible.length
      ? inArray(gw_session_bindings.upstream_id, eligible) : sql`false`
    const [bindings, active, latest] = await Promise.all([
      this.db
        .select({
          id: gw_session_bindings.upstream_id,
          n: sql<number>`count(*)::int`,
        })
        .from(gw_session_bindings)
        .where(
          and(
            eq(gw_session_bindings.model, model),
            candidateFilter,
            sql`${gw_session_bindings.expires_at}>now()`,
          ),
        )
        .groupBy(gw_session_bindings.upstream_id),
      this.db
        .select({
          id: gw_upstream_leases.upstream_id,
          n: sql<number>`count(*)::int`,
        })
        .from(gw_upstream_leases)
        .where(and(
          sql`${gw_upstream_leases.expires_at}>now()`,
          eligible === undefined ? undefined : eligible.length
            ? inArray(gw_upstream_leases.upstream_id, eligible) : sql`false`,
        ))
        .groupBy(gw_upstream_leases.upstream_id),
      this.db
        .select({ id: gw_session_bindings.upstream_id })
        .from(gw_session_bindings)
        .where(
          and(
            eq(gw_session_bindings.model, model),
            candidateFilter,
            sql`${gw_session_bindings.expires_at}>now()`,
          ),
        )
        .orderBy(
          desc(gw_session_bindings.updated_at),
          desc(gw_session_bindings.id),
        )
        .limit(1),
    ])
    return {
      bindings: Object.fromEntries(bindings.map((row) => [row.id, row.n])),
      active: Object.fromEntries(active.map((row) => [row.id, row.n])),
      last: latest[0]?.id ?? null,
    }
  }
  async binding(scope: string) {
    return (
      await this.db
        .select()
        .from(gw_session_bindings)
        .where(
          and(
            eq(gw_session_bindings.scope, scope),
            sql`${gw_session_bindings.expires_at} > now()`,
          ),
        )
    )[0]
  }
  invalidateBinding(scope: string, upstreamId: number) {
    return this.db
      .delete(gw_session_bindings)
      .where(
        and(
          eq(gw_session_bindings.scope, scope),
          eq(gw_session_bindings.upstream_id, upstreamId),
        ),
      )
  }
  releaseUpstream(requestId: string) {
    return this.db
      .delete(gw_upstream_leases)
      .where(eq(gw_upstream_leases.request_id, requestId))
  }
  async probeCandidates(
    limit = 5,
    quietSeconds = 600,
    includePersonal = false,
  ) {
    return this.db
      .select({
        id: gw_upstreams.id,
        owner_user_id: gw_upstreams.owner_user_id,
      })
      .from(gw_upstreams)
      .where(
        and(
          includePersonal ? undefined : platformAccount(),
          eq(gw_upstreams.enabled, true),
          sql`${gw_upstreams.health_status} <> 'healthy'`,
          sql`(${gw_upstreams.probe_expires_at} IS NULL OR ${gw_upstreams.probe_expires_at} <= now())`,
          sql`(${gw_upstreams.last_probe_at} IS NULL OR ${gw_upstreams.last_probe_at} <= now() - (${quietSeconds} * interval '1 second'))`,
          sql`(${gw_upstreams.last_checked_at} IS NULL OR ${gw_upstreams.last_checked_at} <= now() - (${quietSeconds} * interval '1 second'))`,
        ),
      )
      .orderBy(
        sql`${gw_upstreams.last_checked_at} ASC NULLS FIRST`,
        asc(gw_upstreams.id),
      )
      .limit(limit)
  }
  async claimProbe(id: number, quietSeconds = 0, personalOwner?: number) {
    const rows = await this.db
      .update(gw_upstreams)
      .set({
        probe_token: randomUUID(),
        probe_expires_at: sql`clock_timestamp() + interval '60 seconds'`,
        last_probe_at: sql`clock_timestamp()`,
        last_probe_status: 'running',
        last_probe_latency_ms: null,
      })
      .where(
        and(
          eq(gw_upstreams.id, id),
          personalOwner === undefined
            ? platformAccount()
            : and(
                eq(gw_upstreams.scope, 'personal'),
                eq(gw_upstreams.owner_user_id, personalOwner),
              ),
          eq(gw_upstreams.enabled, true),
          quietSeconds > 0
            ? sql`${gw_upstreams.health_status} <> 'healthy'`
            : undefined,
          sql`(${gw_upstreams.probe_expires_at} IS NULL OR ${gw_upstreams.probe_expires_at} <= clock_timestamp())`,
          sql`(${gw_upstreams.last_probe_at} IS NULL OR ${gw_upstreams.last_probe_at} <= clock_timestamp() - (${quietSeconds} * interval '1 second'))`,
          quietSeconds > 0 ? sql`(${gw_upstreams.last_checked_at} IS NULL OR ${gw_upstreams.last_checked_at} <= clock_timestamp() - (${quietSeconds} * interval '1 second'))` : undefined,
        ),
      )
      .returning()
    return rows[0]
  }
  async completeProbe(
    row: UpstreamRow,
    verified: boolean,
    latencyMs: number,
    error?: string,
  ) {
    const at = row.last_probe_at!
    const fresh = sql`(${gw_upstreams.health_observed_at} IS NULL OR ${gw_upstreams.health_observed_at} < ${at}::timestamptz)`
    const same = and(
      eq(gw_upstreams.scope, row.scope),
      sql`${gw_upstreams.owner_user_id} IS NOT DISTINCT FROM ${row.owner_user_id}::integer`,
      eq(gw_upstreams.enabled, true),
      eq(gw_upstreams.secret, row.secret),
      sql`${gw_upstreams.proxy_secret} IS NOT DISTINCT FROM ${row.proxy_secret}::text`,
      eq(gw_upstreams.base_url, row.base_url),
      eq(gw_upstreams.protocol, row.protocol),
      eq(gw_upstreams.request_timeout_seconds, row.request_timeout_seconds),
      sql`${gw_upstreams.extra_headers} = ${JSON.stringify(row.extra_headers)}::jsonb`,
    )!
    const apply = sql`(${fresh} AND ${same})`
    const observe = verified || (Boolean(error) && row.protocol !== 'anthropic')
    const [saved] = await this.db
      .update(gw_upstreams)
      .set({
        probe_token: null,
        probe_expires_at: null,
        last_probe_status: sql`CASE WHEN ${same} THEN ${verified ? 'verified' : error ? 'failed' : 'unverified'} ELSE 'stale' END`,
        last_probe_latency_ms: latencyMs,
        last_checked_at: sql`CASE WHEN ${same} THEN clock_timestamp() ELSE ${gw_upstreams.last_checked_at} END`,
        last_latency_ms: sql`CASE WHEN ${apply} THEN ${Math.max(0, Math.trunc(latencyMs))} ELSE ${gw_upstreams.last_latency_ms} END`,
        last_success_at: sql`CASE WHEN ${apply} AND ${verified} THEN clock_timestamp() ELSE ${gw_upstreams.last_success_at} END`,
        last_error_at: sql`CASE WHEN ${apply} AND ${verified} THEN NULL WHEN ${apply} AND ${observe && Boolean(error)} THEN clock_timestamp() ELSE ${gw_upstreams.last_error_at} END`,
        ...(observe
          ? {
              health_observed_at: sql`CASE WHEN ${apply} THEN ${at}::timestamptz ELSE ${gw_upstreams.health_observed_at} END`,
              last_error: sql`CASE WHEN ${apply} THEN ${error ?? null}::text ELSE ${gw_upstreams.last_error} END`,
            }
          : {}),
        ...(verified
          ? {
              health_status: sql`CASE WHEN ${apply} THEN 'healthy' ELSE ${gw_upstreams.health_status} END`,
              consecutive_failures: sql`CASE WHEN ${apply} THEN 0 ELSE ${gw_upstreams.consecutive_failures} END`,
              cooldown_until: sql`CASE WHEN ${apply} THEN NULL ELSE ${gw_upstreams.cooldown_until} END`,
            }
          : {}),
      })
      .where(
        and(
          eq(gw_upstreams.id, row.id),
          eq(gw_upstreams.probe_token, row.probe_token!),
          sql`${gw_upstreams.probe_expires_at} > clock_timestamp()`,
        ),
      )
      .returning()
    return Boolean(
      saved &&
        verified &&
        saved.health_observed_at &&
        Date.parse(saved.health_observed_at) === Date.parse(at),
    )
  }
  async recordHealthSuccess(
    id: number,
    observedAt: string,
    expected?: UpstreamRow,
    latencyMs?: number,
  ) {
    return this.db
      .update(gw_upstreams)
      .set({
        last_success_at: sql`clock_timestamp()`,
        last_error_at: null,
        ...(latencyMs === undefined
          ? {}
          : { last_latency_ms: Math.max(0, Math.trunc(latencyMs)) }),
        health_status: 'healthy',
        consecutive_failures: 0,
        cooldown_until: null,
        last_error: null,
        health_observed_at: observedAt,
      })
      .where(
        and(
          eq(gw_upstreams.id, id),
          expected
            ? and(
                eq(gw_upstreams.scope, expected.scope),
                sql`${gw_upstreams.owner_user_id} IS NOT DISTINCT FROM ${expected.owner_user_id}::integer`,
                eq(gw_upstreams.enabled, true),
                eq(gw_upstreams.secret, expected.secret),
                sql`${gw_upstreams.proxy_secret} IS NOT DISTINCT FROM ${expected.proxy_secret}::text`,
                eq(gw_upstreams.base_url, expected.base_url),
                eq(gw_upstreams.protocol, expected.protocol),
                eq(
                  gw_upstreams.request_timeout_seconds,
                  expected.request_timeout_seconds,
                ),
                sql`${gw_upstreams.extra_headers} = ${JSON.stringify(expected.extra_headers)}::jsonb`,
              )
            : undefined,
          sql`(${gw_upstreams.health_observed_at} IS NULL OR ${gw_upstreams.health_observed_at} < ${observedAt}::timestamptz)`,
        ),
      )
      .returning()
  }
  async recordHealthFailure(
    id: number,
    observedAt: string,
    error: string,
    immediate: boolean,
    soft: boolean,
    expected?: UpstreamRow,
  ) {
    // One atomic UPDATE serializes competing observations; no lock spans provider I/O.
    const failures = sql`${gw_upstreams.consecutive_failures} + 1`
    return this.db
      .update(gw_upstreams)
      .set({
        health_observed_at: observedAt,
        last_error_at: sql`clock_timestamp()`,
        last_error: error,
        ...(soft
          ? {}
          : {
              consecutive_failures: failures,
              health_status: sql`CASE WHEN ${immediate} OR ${failures} >= ${this.schedulingPolicy.failureThreshold} THEN 'cooldown' ELSE 'unhealthy' END`,
              cooldown_until: sql`CASE WHEN ${immediate} OR ${failures} >= ${this.schedulingPolicy.failureThreshold} THEN now() + (${immediate ? Math.max(1800, this.schedulingPolicy.cooldownSeconds) : this.schedulingPolicy.cooldownSeconds} * interval '1 second') ELSE ${gw_upstreams.cooldown_until} END`,
            }),
      })
      .where(
        and(
          eq(gw_upstreams.id, id),
          expected
            ? and(
                eq(gw_upstreams.scope, expected.scope),
                sql`${gw_upstreams.owner_user_id} IS NOT DISTINCT FROM ${expected.owner_user_id}::integer`,
                eq(gw_upstreams.enabled, true),
                eq(gw_upstreams.secret, expected.secret),
                sql`${gw_upstreams.proxy_secret} IS NOT DISTINCT FROM ${expected.proxy_secret}::text`,
                eq(gw_upstreams.base_url, expected.base_url),
                eq(gw_upstreams.protocol, expected.protocol),
                eq(
                  gw_upstreams.request_timeout_seconds,
                  expected.request_timeout_seconds,
                ),
                sql`${gw_upstreams.extra_headers} = ${JSON.stringify(expected.extra_headers)}::jsonb`,
              )
            : undefined,
          sql`(${gw_upstreams.health_observed_at} IS NULL OR ${gw_upstreams.health_observed_at} <= ${observedAt}::timestamptz)`,
        ),
      )
      .returning()
  }
  async models(owner?: number) {
    const explicit = await this.db
      .selectDistinct({
        model: gw_routes.model,
        protocol: gw_upstreams.protocol,
      })
      .from(gw_routes)
      .innerJoin(
        gw_upstreams,
        and(eq(gw_routes.upstream_id, gw_upstreams.id), platformAccount()),
      )
      .where(and(eq(gw_routes.enabled, true), eq(gw_upstreams.enabled, true)))
    const configs = await this.publicRoutes()
    const publicModels = (
      await Promise.all(
        configs
          .filter((row) => row.enabled)
          .map(async (config) =>
            (await this.candidates(config.model, true)).map(({ upstream }) => ({
              model: config.model,
              protocol: upstream.protocol,
            })),
          ),
      )
    ).flat()
    const personal =
      owner === undefined
        ? []
        : (await this.personalAccounts(owner)).flatMap((account) =>
            personalModelNames(account).map((model) => ({
              model,
              protocol: account.protocol,
            })),
          )
    const accounts = await this.db.select().from(gw_upstreams).where(and(platformAccount(), eq(gw_upstreams.enabled, true)))
    const direct = accounts.flatMap(account => supportedModels(account)
      .filter(model => !configs.some(config => config.model === model))
      .map(model => ({ model, protocol: account.protocol })))
    return [
      ...new Map(
        [...explicit, ...publicModels, ...personal, ...direct].map((row) => [
          row.model + '\0' + row.protocol,
          row,
        ]),
      ).values(),
    ]
  }
  async userLimits(owner: number) {
    const [user] = await this.db
      .select({ id: admin_users.id })
      .from(admin_users)
      .where(eq(admin_users.id, owner))
    if (!user) return null
    return (
      (
        await this.db
          .select()
          .from(gw_user_limits)
          .where(eq(gw_user_limits.owner_id, owner))
      )[0] ?? {
        owner_id: owner,
        daily_limit: null,
        concurrency_limit: 0,
        rpm_limit: 0,
      }
    )
  }
  async quotaSummary(owner: number) {
    const limits = await this.userLimits(owner)
    if (!limits) return null
    const [row] = await this.db
      .select({
        used: sql<number>`coalesce(sum(${billedTokens}),0)::float8`,
      })
      .from(gw_requests)
      .innerJoin(gw_keys, eq(gw_requests.key_id, gw_keys.id))
      .where(
        and(
          eq(gw_keys.owner_id, owner),
          sql`${gw_requests.status} <> 'reserved'`,
          sql`${gw_requests.created_at} >= date_trunc('day',now() at time zone ${this.quotaTimezone}) at time zone ${this.quotaTimezone}`,
        ),
      )
    const quota = limits.daily_limit ?? this.defaultQuota
    const used = row!.used
    return {
      daily_quota: quota || null,
      quota_override: limits.daily_limit,
      quota_source: limits.daily_limit === null ? 'default' : 'user',
      used_today: used,
      remaining: quota > 0 ? Math.max(0, quota - used) : null,
      usage_percent:
        quota > 0
          ? Math.round(Math.min(100, (used / quota) * 100) * 10) / 10
          : null,
      exhausted: quota > 0 && used >= quota,
    }
  }
  async quotaPage(page: number, perPage: number, search?: string) {
    const where = search
      ? ilike(admin_users.username, `%${search}%`)
      : undefined
    return this.db.transaction(
      async (tx) => {
        const rows = await tx
          .select({
            user_id: admin_users.id,
            username: admin_users.username,
            daily_token_quota: gw_user_limits.daily_limit,
            updated_at: gw_user_limits.quota_updated_at,
            used_today: sql<number>`(select coalesce(sum(${billedTokens}),0)::float8 from gw_requests join gw_keys on gw_keys.id=gw_requests.key_id where gw_keys.owner_id=${admin_users.id} and gw_requests.status<>'reserved' and gw_requests.created_at >= date_trunc('day',now() at time zone ${this.quotaTimezone}) at time zone ${this.quotaTimezone})`,
          })
          .from(admin_users)
          .leftJoin(gw_user_limits, eq(gw_user_limits.owner_id, admin_users.id))
          .where(where)
          .orderBy(asc(admin_users.username), asc(admin_users.id))
          .limit(perPage)
          .offset((page - 1) * perPage)
        const [count] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(admin_users)
          .where(where)
        return { rows, total: count!.total }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
  async saveDailyQuota(owner: number, daily_limit: number | null) {
    // Only patch daily quota; do not overwrite concurrently edited RPM/concurrency.
    return this.db
      .insert(gw_user_limits)
      .values({
        owner_id: owner,
        daily_limit,
        quota_updated_at: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: gw_user_limits.owner_id,
        set: { daily_limit, quota_updated_at: sql`clock_timestamp()` },
      })
  }
  async saveUserLimits(
    owner: number,
    limits: {
      daily_limit: number | null
      concurrency_limit: number
      rpm_limit: number
    },
  ) {
    return (
      await this.db
        .insert(gw_user_limits)
        .values({
          owner_id: owner,
          ...limits,
          quota_updated_at: sql`clock_timestamp()`,
        })
        .onConflictDoUpdate({
          target: gw_user_limits.owner_id,
          set: { ...limits, quota_updated_at: sql`clock_timestamp()` },
        })
        .returning()
    )[0]
  }
  async reserve(
    keyId: number,
    values: Omit<typeof gw_requests.$inferInsert, 'key_id'>,
    budget?: { promptTokens: number; outputTokens: number; minHeadroom: number },
    delegation?: {model:string;parentRequestId:string},
  ) {
    return this.db.transaction(async (tx) => {
      const [key] = await tx
        .select()
        .from(gw_keys)
        .where(eq(gw_keys.id, keyId))
        .for('update')
      if (
        !key ||
        key.revoked ||
        (key.expires_at && Date.parse(key.expires_at) <= Date.now())
      )
        return 'unauthorized'
      if (!key.scopes.includes('chat')) return 'insufficient_scope'
      if (!key.models.includes('*') && !key.models.includes(delegation?.model ?? values.model))
        return 'model_not_allowed'
      if (delegation) {
        const [parent] = await tx.select({id:gw_requests.id}).from(gw_requests).where(and(
          eq(gw_requests.id,delegation.parentRequestId),eq(gw_requests.key_id,keyId),eq(gw_requests.model,delegation.model)))
        if (!parent) return 'model_not_allowed'
      }
      // Lock one owner policy after the key; all keys of that owner share this reservation barrier.
      await tx
        .insert(gw_user_limits)
        .values({ owner_id: key.owner_id })
        .onConflictDoNothing()
      const [policy] = await tx
        .select()
        .from(gw_user_limits)
        .where(eq(gw_user_limits.owner_id, key.owner_id))
        .for('update')
      // Sample after lock waits, then use one instant for both owner and key windows.
      const clock = await tx.execute<{ instant: string }>(
        sql`SELECT ${this.quotaClock()}::text AS instant`,
      )
      const quotaNow = clock.rows[0]!.instant
      const [shared] = await tx
        .select({
          used: sql<number>`coalesce(sum(case when ${gw_requests.status}='reserved' AND ${gw_requests.expires_at}>${quotaNow}::timestamptz AND ${gw_requests.created_at} >= date_trunc('day',${quotaNow}::timestamptz at time zone ${this.quotaTimezone}) at time zone ${this.quotaTimezone} then ${gw_requests.reserved_tokens} when ${billable} AND ${gw_requests.created_at} >= date_trunc('day',${quotaNow}::timestamptz at time zone ${this.quotaTimezone}) at time zone ${this.quotaTimezone} then ${gw_requests.input_tokens}+${gw_requests.output_tokens} else 0 end),0)::float8`,
          active: sql<number>`count(*) filter(where ${gw_requests.status}='reserved' AND ${gw_requests.expires_at}>${quotaNow}::timestamptz)::int`,
          recent: sql<number>`count(*) filter(where ${gw_requests.created_at}>${quotaNow}::timestamptz-interval '1 minute')::int`,
        })
        .from(gw_requests)
        .innerJoin(gw_keys, eq(gw_requests.key_id, gw_keys.id))
        .where(
          and(
            eq(gw_keys.owner_id, key.owner_id),
            sql`(${gw_requests.created_at} >= date_trunc('day',${quotaNow}::timestamptz at time zone ${this.quotaTimezone}) at time zone ${this.quotaTimezone} OR ${gw_requests.status}='reserved' OR ${gw_requests.created_at}>${quotaNow}::timestamptz-interval '1 minute')`,
          ),
        )
      if (
        policy!.concurrency_limit > 0 &&
        shared!.active >= policy!.concurrency_limit
      )
        return 'user_concurrency_limit'
      if (policy!.rpm_limit > 0 && shared!.recent >= policy!.rpm_limit)
        return 'user_rate_limit'
      const dailyLimit = policy!.daily_limit ?? this.defaultQuota
      if (!budget && dailyLimit > 0 && shared!.used + values.reserved_tokens > dailyLimit)
        return 'user_quota_exceeded'
      // No transaction or connection is held during upstream I/O.
      const [row] = await tx
        .select({
          used: sql<number>`coalesce(sum(case when ${gw_requests.status} = 'reserved' AND ${gw_requests.expires_at}>${quotaNow}::timestamptz AND ${gw_requests.created_at} >= date_trunc('day',${quotaNow}::timestamptz at time zone ${this.quotaTimezone}) at time zone ${this.quotaTimezone} then ${gw_requests.reserved_tokens} when ${billable} AND ${gw_requests.created_at} >= date_trunc('day',${quotaNow}::timestamptz at time zone ${this.quotaTimezone}) at time zone ${this.quotaTimezone} then ${gw_requests.input_tokens}+${gw_requests.output_tokens} else 0 end),0)::float8`,
          active: sql<number>`count(*) filter (where ${gw_requests.status}='reserved' AND ${gw_requests.expires_at}>${quotaNow}::timestamptz)::int`,
          recent: sql<number>`count(*) filter (where ${gw_requests.created_at} > ${quotaNow}::timestamptz-interval '1 minute')::int`,
        })
        .from(gw_requests)
        .innerJoin(gw_keys, eq(gw_requests.key_id, gw_keys.id))
        .where(
          and(
            eq(gw_keys.quota_group, key.quota_group),
            eq(gw_keys.owner_id, key.owner_id),
            sql`(${gw_requests.created_at} >= date_trunc('day', ${quotaNow}::timestamptz at time zone ${this.quotaTimezone}) at time zone ${this.quotaTimezone} OR ${gw_requests.status}='reserved' OR ${gw_requests.created_at}>${quotaNow}::timestamptz-interval '1 minute')`,
          ),
        )
      if (
        key.concurrency_limit > 0 &&
        Number(row!.active) >= key.concurrency_limit
      )
        return 'concurrency_limit'
      if (key.rpm_limit > 0 && Number(row!.recent) >= key.rpm_limit)
        return 'rate_limit'
      if (
        !budget && key.daily_limit > 0 &&
        Number(row!.used) + values.reserved_tokens > key.daily_limit
      )
        return 'quota_exceeded'
      let reserved = values.reserved_tokens
      let allowance = budget?.outputTokens
      if (budget) {
        const minimum = Math.max(1, Math.min(budget.outputTokens, budget.minHeadroom))
        const ownerRoom = dailyLimit > 0 ? dailyLimit - shared!.used - budget.promptTokens : Infinity
        const keyRoom = key.daily_limit > 0 ? key.daily_limit - Number(row!.used) - budget.promptTokens : Infinity
        if (ownerRoom < minimum) return 'user_quota_exceeded'
        if (keyRoom < minimum) return 'quota_exceeded'
        allowance = Math.min(budget.outputTokens, ownerRoom, keyRoom)
        reserved = budget.promptTokens + allowance
      }
      await tx
        .insert(gw_requests)
        .values({ ...values, reserved_tokens: reserved, key_id: keyId, created_at: quotaNow })
      if (budget) budget.outputTokens = allowance!
      return null
    })
  }
  recordRejected(values: typeof gw_requests.$inferInsert) {
    return this.db.insert(gw_requests).values(values)
  }
  async finish(id: string, values: Partial<RequestRow>) {
    return this.db
      .update(gw_requests)
      .set(values)
      .where(and(eq(gw_requests.id, id), eq(gw_requests.status, 'reserved')))
      .returning()
  }
  async recordExecution(
    id: string,
    execution: NonNullable<RequestRow['execution']>,
  ) {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(gw_requests)
        .set({ execution })
        .where(and(eq(gw_requests.id, id), eq(gw_requests.status, 'reserved')))
        .returning({ id: gw_requests.id })
      if (rows.length !== 1)
        throw new Error('Cannot record execution on settled request')
      if (execution.upstream_id !== null) await tx
        .update(gw_upstreams)
        .set({ last_used_at: sql`clock_timestamp()` })
        .where(eq(gw_upstreams.id, execution.upstream_id))
    })
  }

  attempt(values: typeof gw_attempts.$inferInsert) {
    return this.db.insert(gw_attempts).values(values)
  }
  async requestById(id: string) {
    return (
      await this.db.select().from(gw_requests).where(eq(gw_requests.id, id))
    )[0]
  }
  async listRequests(page = 1, ownerId?: number) {
    const where = ownerId
      ? inArray(
          gw_requests.key_id,
          this.db
            .select({ id: gw_keys.id })
            .from(gw_keys)
            .where(eq(gw_keys.owner_id, ownerId)),
        )
      : undefined
    const [items, count] = await Promise.all([
      this.db
        .select()
        .from(gw_requests)
        .where(where)
        .orderBy(desc(gw_requests.created_at))
        .limit(20)
        .offset((page - 1) * 20),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(gw_requests)
        .where(where),
    ])
    return { items, total: count[0]!.total, page, per_page: 20 }
  }
  attempts(id: string) {
    return this.db
      .select()
      .from(gw_attempts)
      .where(eq(gw_attempts.request_id, id))
      .orderBy(asc(gw_attempts.id))
  }
  async summary() {
    const [row] = await this.db
      .select({
        requests: sql<number>`count(*)::int`,
        active: sql<number>`(select count(*)::int from gw_requests active_requests where active_requests.status='reserved')`,
        failed: sql<number>`count(*) filter(where status not in ('reserved','ok'))::int`,
        tokens: sql<number>`coalesce(sum(${billedTokens}),0)::float8`,
      })
      .from(gw_requests)
      .where(
        sql`created_at >= date_trunc('day',now() at time zone ${this.quotaTimezone}) at time zone ${this.quotaTimezone}`,
      )
    return { ...row, timezone: this.quotaTimezone }
  }
  recoverExpired() {
    // Expired reservations cease consuming quota; reservation size is not observed usage.
    return this.db.transaction(async tx => {
      await tx.delete(gw_upstream_leases).where(sql`${gw_upstream_leases.expires_at} < now()`)
      return tx
      .update(gw_requests)
      .set({
        status: 'interrupted',
        usage_source: 'unknown',
        input_tokens: 0,
        output_tokens: 0,
        error: '请求进程中断；实际用量未知，预留已释放，请核对上游用量',
      })
      .where(and(eq(gw_requests.status, 'reserved'), sql`expires_at < now()`))
      .returning({ id: gw_requests.id })
    })
  }
  // Shared fixed-window admission for unauthenticated device start/poll.
  // The global lock also bounds the number of identities under address churn.
  async admitDeviceRequest(identity: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(73462110)`)
      await tx.execute(sql`delete from gw_device_rate_limits
        where started_at <= clock_timestamp() - interval '60 seconds'`)
      const current = await tx.execute(sql`select count,
        greatest(1, ceil(extract(epoch from started_at + interval '60 seconds' - clock_timestamp())))::integer as retry_after
        from gw_device_rate_limits where identity = ${identity}`)
      if (current.rows[0]) {
        const row = current.rows[0]
        if (Number(row.count) >= 60) return Number(row.retry_after)
        await tx.execute(
          sql`update gw_device_rate_limits set count = count + 1 where identity = ${identity}`,
        )
      } else {
        const size = await tx.execute(
          sql`select count(*)::integer as count from gw_device_rate_limits`,
        )
        if (Number(size.rows[0]?.count) >= 10000) return 60
        await tx.execute(
          sql`insert into gw_device_rate_limits (identity, started_at) values (${identity}, clock_timestamp())`,
        )
      }
      return 0
    })
  }
  async createDevice(
    values: typeof gw_devices.$inferInsert,
    policy: DeviceStartPolicy = deviceStartPolicy(),
  ) {
    return this.db.transaction(async (tx) => {
      // Database-wide admission, matching the Python gateway's lock namespace.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(73462109)`)
      await tx
        .delete(gw_devices)
        .where(
          sql`${gw_devices.created_at} < clock_timestamp() - (${policy.retentionHours} * interval '1 hour')`,
        )
      await tx
        .update(gw_devices)
        .set({ status: 'expired' })
        .where(
          and(
            inArray(gw_devices.status, ['pending', 'approved']),
            sql`${gw_devices.expires_at} <= clock_timestamp()`,
          ),
        )
      const counts = await tx.execute<{ recent: number; active: number }>(sql`
        SELECT count(*) FILTER (WHERE created_at >= clock_timestamp() - interval '1 minute')::int AS recent,
          count(*) FILTER (WHERE status IN ('pending','approved') AND expires_at > clock_timestamp())::int AS active
        FROM gw_devices`)
      if (counts.rows[0]!.recent >= policy.startsPerMinute)
        return 'rate_limited' as const
      if (counts.rows[0]!.active >= policy.maxActive)
        return 'capacity_exceeded' as const
      await tx.insert(gw_devices).values({
        ...values,
        created_at: sql`clock_timestamp()`,
        expires_at: sql`clock_timestamp() + interval '600 seconds'`,
      })
      return 'created' as const
    })
  }
  async confirmDevice(
    code: string,
    owner: number,
    decision: 'approved' | 'denied' = 'approved',
  ) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(gw_devices)
        .where(eq(gw_devices.user_code, code))
        .for('update')
      if (!row) return { error: 'invalid_user_code' as const, status: 'missing' }
      const clock = await tx.execute<{ expired: boolean }>(
        sql`SELECT ${row.expires_at}::timestamptz <= clock_timestamp() AS expired`,
      )
      if (
        ['pending', 'approved'].includes(row.status) &&
        clock.rows[0]!.expired
      ) {
        await tx
          .update(gw_devices)
          .set({ status: 'expired' })
          .where(eq(gw_devices.id, row.id))
        return { error: 'expired_token' as const, status: 'expired' }
      }
      if (row.status !== 'pending')
        return {
          status: row.status,
          error:
            row.status === 'expired'
              ? ('expired_token' as const)
              : ('already_decided' as const),
        }
      await tx
        .update(gw_devices)
        .set({ owner_id: owner, status: decision })
        .where(eq(gw_devices.id, row.id))
      return { user_code: row.user_code }
    })
  }
  async consumeDevice(
    hash: string,
    key: Omit<typeof gw_keys.$inferInsert, 'owner_id'>,
  ) {
    return this.db.transaction(async (tx) => {
      const [device] = await tx
        .select()
        .from(gw_devices)
        .where(eq(gw_devices.device_hash, hash))
        .for('update')
      if (!device) return 'invalid_device_code'
      const clock = await tx.execute<{ expired: boolean }>(
        sql`SELECT ${device.expires_at}::timestamptz <= clock_timestamp() AS expired`,
      )
      if (
        ['pending', 'approved'].includes(device.status) &&
        clock.rows[0]!.expired
      ) {
        await tx
          .update(gw_devices)
          .set({ status: 'expired' })
          .where(eq(gw_devices.id, device.id))
        return 'expired_token'
      }
      if (device.status === 'expired') return 'expired_token'
      if (device.status === 'consumed') return 'already_consumed'
      if (device.status === 'pending') return 'authorization_pending'
      if (device.status !== 'approved' || !device.owner_id)
        return 'access_denied'
      const [user] = await loadAdminsWithRolesByIds(tx, [device.owner_id])
      if (!user) return 'access_denied'
      await tx.insert(gw_keys).values({ ...key, owner_id: device.owner_id })
      await tx
        .update(gw_devices)
        .set({ status: 'consumed' })
        .where(eq(gw_devices.id, device.id))
      return { user }
    })
  }
}
