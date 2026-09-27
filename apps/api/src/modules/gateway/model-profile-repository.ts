import { and, asc, eq, ilike, or, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import {
  gw_model_profiles,
  gw_upstreams,
  gw_routes,
  gw_public_routes,
} from '@/db/schema/gateway'
import { GatewayError } from './schema'
export type ProfileRow = typeof gw_model_profiles.$inferSelect
export class ModelProfileRepository {
  constructor(readonly db: Db) {}
  async page(query: {
    page: number
    per_page: number
    search?: string
    enabled?: boolean
  }) {
    const where = and(
      query.search
        ? or(
            ilike(gw_model_profiles.model_name, `%${query.search}%`),
            ilike(gw_model_profiles.note, `%${query.search}%`),
          )
        : undefined,
      query.enabled === undefined
        ? undefined
        : eq(gw_model_profiles.enabled, query.enabled),
    )
    return this.db.transaction(
      async (tx) => {
        const items = await tx
          .select()
          .from(gw_model_profiles)
          .where(where)
          .orderBy(asc(gw_model_profiles.model_name))
          .limit(query.per_page)
          .offset((query.page - 1) * query.per_page)
        const [count] = await tx
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(gw_model_profiles)
          .where(where)
        return {
          items,
          total: count!.n,
          page: query.page,
          per_page: query.per_page,
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
  all() {
    return this.db.select().from(gw_model_profiles)
  }
  async candidates() {
    const accounts = await this.db
      .select({
        models: gw_upstreams.supported_models,
        default: gw_upstreams.default_model,
      })
      .from(gw_upstreams)
      .where(
        and(
          eq(gw_upstreams.scope, 'platform'),
          sql`${gw_upstreams.owner_user_id} is null`,
        ),
      )
    const routes = await this.db
      .select({
        model: gw_routes.model,
        upstream: gw_routes.upstream_model,
        vision: gw_routes.vision_model,
      })
      .from(gw_routes)
    const publicRoutes = await this.db
      .select({
        model: gw_public_routes.model,
        upstream: gw_public_routes.upstream_model,
        vision: gw_public_routes.vision_model,
      })
      .from(gw_public_routes)
    return [
      ...new Set(
        [
          ...accounts.flatMap((row) => [...row.models, row.default]),
          ...[...routes, ...publicRoutes].flatMap((row) => [
            row.model,
            row.upstream,
            row.vision,
          ]),
          ...(await this.all()).map((row) => row.model_name),
        ].filter((v): v is string => Boolean(v)),
      ),
    ].sort()
  }
  async save(
    values: Partial<typeof gw_model_profiles.$inferInsert>,
    id?: number,
  ) {
    try {
      const [row] =
        id === undefined
          ? await this.db
              .insert(gw_model_profiles)
              .values(values as typeof gw_model_profiles.$inferInsert)
              .returning()
          : await this.db
              .update(gw_model_profiles)
              .set(values)
              .where(eq(gw_model_profiles.id, id))
              .returning()
      if (!row) throw new GatewayError(404, '模型能力档案不存在')
      return row
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } }
      if ((e.cause?.code || e.code) === '23505')
        throw new GatewayError(409, '该模型已经配置能力档案')
      throw error
    }
  }
  async remove(id: number) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(gw_model_profiles)
        .where(eq(gw_model_profiles.id, id))
        .for('update')
      if (!row) throw new GatewayError(404, '模型能力档案不存在')
      if (row.enabled) throw new GatewayError(409, '请先停用模型能力档案')
      await tx.delete(gw_model_profiles).where(eq(gw_model_profiles.id, id))
      return { ok: true }
    })
  }
  async sync(
    items: Array<{
      model_name: string
      context_window: number
      max_output_tokens: number
    }>,
    source: string,
  ) {
    return this.db.transaction(async (tx) => {
      for (const item of items) {
        const values = {
          catalog_context_window: item.context_window,
          catalog_max_output_tokens: item.max_output_tokens,
          catalog_source: source,
          catalog_synced_at: sql`clock_timestamp()`,
        }
        await tx
          .insert(gw_model_profiles)
          .values({ model_name: item.model_name, ...values })
          .onConflictDoUpdate({
            target: gw_model_profiles.model_name,
            set: { ...values, updated_at: sql`clock_timestamp()` },
          })
      }
      return { status: 'ok', matched_count: items.length, source }
    })
  }
}
