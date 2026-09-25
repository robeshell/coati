import { and, eq, asc, desc, sql, inArray } from 'drizzle-orm'
import type { Db } from '@/db/client'
import {
  gw_upstreams,
  gw_routes,
  gw_keys,
  gw_requests,
  gw_attempts,
  gw_devices,
} from '@/db/schema/gateway'
export type KeyRow = typeof gw_keys.$inferSelect
export type RequestRow = typeof gw_requests.$inferSelect
export class GatewayRepository {
  constructor(readonly db: Db) {}
  upstreams() {
    return this.db.select().from(gw_upstreams).orderBy(asc(gw_upstreams.id))
  }
  async saveUpstream(values: typeof gw_upstreams.$inferInsert, id?: number) {
    const rows = id
      ? await this.db
          .update(gw_upstreams)
          .set(values)
          .where(eq(gw_upstreams.id, id))
          .returning()
      : await this.db.insert(gw_upstreams).values(values).returning()
    return rows[0]
  }
  routes() {
    return this.db
      .select()
      .from(gw_routes)
      .orderBy(asc(gw_routes.priority), asc(gw_routes.id))
  }
  async saveRoute(values: typeof gw_routes.$inferInsert, id?: number) {
    return (
      id
        ? await this.db
            .update(gw_routes)
            .set(values)
            .where(eq(gw_routes.id, id))
            .returning()
        : await this.db.insert(gw_routes).values(values).returning()
    )[0]
  }
  async disable(resource: 'upstreams' | 'routes', id: number) {
    const table = resource === 'upstreams' ? gw_upstreams : gw_routes
    return (
      await this.db
        .update(table)
        .set({ enabled: false })
        .where(eq(table.id, id))
        .returning()
    )[0]
  }
  keys(ownerId?: number) {
    return this.db
      .select()
      .from(gw_keys)
      .where(ownerId ? eq(gw_keys.owner_id, ownerId) : undefined)
      .orderBy(desc(gw_keys.id))
  }
  async key(digest: string) {
    return (
      await this.db.select().from(gw_keys).where(eq(gw_keys.digest, digest))
    )[0]
  }
  async createKey(values: typeof gw_keys.$inferInsert) {
    return (await this.db.insert(gw_keys).values(values).returning())[0]!
  }
  async revoke(id: number, ownerId: number) {
    return (
      await this.db
        .update(gw_keys)
        .set({ revoked: true })
        .where(and(eq(gw_keys.id, id), eq(gw_keys.owner_id, ownerId)))
        .returning()
    )[0]
  }
  candidates(model: string, protocol: string) {
    return this.db
      .select({ route: gw_routes, upstream: gw_upstreams })
      .from(gw_routes)
      .innerJoin(gw_upstreams, eq(gw_routes.upstream_id, gw_upstreams.id))
      .where(
        and(
          eq(gw_routes.model, model),
          eq(gw_routes.enabled, true),
          eq(gw_upstreams.enabled, true),
          eq(gw_upstreams.protocol, protocol),
        ),
      )
      .orderBy(asc(gw_routes.priority), asc(gw_routes.id))
      .limit(3)
  }
  async models() {
    return this.db
      .selectDistinct({
        model: gw_routes.model,
        protocol: gw_upstreams.protocol,
      })
      .from(gw_routes)
      .innerJoin(gw_upstreams, eq(gw_routes.upstream_id, gw_upstreams.id))
      .where(and(eq(gw_routes.enabled, true), eq(gw_upstreams.enabled, true)))
  }
  async reserve(
    keyId: number,
    values: Omit<typeof gw_requests.$inferInsert, 'key_id'>,
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
      // Only this key is locked. No transaction or connection is held during upstream I/O.
      const [row] = await tx
        .select({
          used: sql<number>`coalesce(sum(case when ${gw_requests.status} = 'reserved' then ${gw_requests.reserved_tokens} else ${gw_requests.input_tokens}+${gw_requests.output_tokens} end),0)::float8`,
          active: sql<number>`count(*) filter (where ${gw_requests.status}='reserved')::int`,
          recent: sql<number>`count(*) filter (where ${gw_requests.created_at} > now()-interval '1 minute')::int`,
        })
        .from(gw_requests)
        .where(
          and(
            eq(gw_requests.key_id, keyId),
            sql`${gw_requests.created_at} >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' OR (${gw_requests.key_id}=${keyId} AND ${gw_requests.status}='reserved')`,
          ),
        )
      if (Number(row!.active) >= key.concurrency_limit)
        return 'concurrency_limit'
      if (Number(row!.recent) >= key.rpm_limit) return 'rate_limit'
      if (
        key.daily_limit > 0 &&
        Number(row!.used) + values.reserved_tokens > key.daily_limit
      )
        return 'quota_exceeded'
      await tx.insert(gw_requests).values({ ...values, key_id: keyId })
      return null
    })
  }
  async finish(id: string, values: Partial<RequestRow>) {
    return this.db
      .update(gw_requests)
      .set(values)
      .where(and(eq(gw_requests.id, id), eq(gw_requests.status, 'reserved')))
      .returning()
  }
  attempt(values: typeof gw_attempts.$inferInsert) {
    return this.db.insert(gw_attempts).values(values)
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
        active: sql<number>`count(*) filter(where status='reserved')::int`,
        failed: sql<number>`count(*) filter(where status not in ('reserved','ok'))::int`,
        tokens: sql<number>`coalesce(sum(input_tokens+output_tokens),0)::float8`,
      })
      .from(gw_requests)
      .where(
        sql`created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'`,
      )
    return row
  }
  recoverExpired() {
    // Unknown final usage is conservatively charged at reservation; never silently made free.
    return this.db
      .update(gw_requests)
      .set({
        status: 'interrupted',
        usage_source: 'estimated',
        input_tokens: sql`reserved_tokens`,
        output_tokens: 0,
        error: '请求进程中断；按预留量暂记，请核对上游用量',
      })
      .where(and(eq(gw_requests.status, 'reserved'), sql`expires_at < now()`))
      .returning({ id: gw_requests.id })
  }
  async createDevice(values: typeof gw_devices.$inferInsert) {
    return (await this.db.insert(gw_devices).values(values).returning())[0]!
  }
  async confirmDevice(code: string, owner: number) {
    return (
      await this.db
        .update(gw_devices)
        .set({ owner_id: owner, status: 'approved' })
        .where(
          and(
            eq(gw_devices.user_code, code),
            eq(gw_devices.status, 'pending'),
            sql`expires_at > now()`,
          ),
        )
        .returning()
    )[0]
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
      if (!device || Date.parse(device.expires_at) <= Date.now())
        return 'expired_token'
      if (device.status === 'pending') return 'authorization_pending'
      if (device.status !== 'approved' || !device.owner_id)
        return 'access_denied'
      await tx.insert(gw_keys).values({ ...key, owner_id: device.owner_id })
      await tx
        .update(gw_devices)
        .set({ status: 'consumed' })
        .where(eq(gw_devices.id, device.id))
      return null
    })
  }
}
