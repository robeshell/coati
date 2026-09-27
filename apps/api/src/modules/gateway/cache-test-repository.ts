import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { gw_cache_tests, gw_keys, gw_requests } from '@/db/schema/gateway'
import { GatewayError } from './schema'
export class CacheTestRepository {
  constructor(readonly db: Db) {}
  async page(
    owner: number,
    q: { page: number; per_page: number; search?: string },
    legacyDetails = false,
  ) {
    await this.recoverInterrupted()
    const where = and(
      eq(gw_cache_tests.user_id, owner),
      q.search
        ? or(
            ilike(gw_cache_tests.name, `%${q.search}%`),
            ilike(gw_cache_tests.model, `%${q.search}%`),
          )
        : undefined,
    )
    return this.db.transaction(
      async (tx) => {
        // Do not include long prompts or per-round payloads in list responses.
        const items = await tx
          .select({
            ...(legacyDetails ? { results: gw_cache_tests.results, user_id: gw_cache_tests.user_id } : {}),
            id: gw_cache_tests.id,
            name: gw_cache_tests.name,
            model: gw_cache_tests.model,
            rounds: gw_cache_tests.rounds,
            max_tokens: gw_cache_tests.max_tokens,
            status: gw_cache_tests.status,
            summary: gw_cache_tests.summary,
            error_summary: gw_cache_tests.error_summary,
            created_at: gw_cache_tests.created_at,
          })
          .from(gw_cache_tests)
          .where(where)
          .orderBy(desc(gw_cache_tests.id))
          .limit(q.per_page)
          .offset((q.page - 1) * q.per_page)
        const [count] = await tx
          .select({ total: sql<number>`count(*)`.mapWith(Number) })
          .from(gw_cache_tests)
          .where(where)
        return { ...q, total: count!.total, items }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
  async get(owner: number, id: number) {
    await this.recoverInterrupted()
    const [row] = await this.db
      .select()
      .from(gw_cache_tests)
      .where(and(eq(gw_cache_tests.id, id), eq(gw_cache_tests.user_id, owner)))
    if (!row) throw new GatewayError(404, '缓存验证记录不存在')
    return row
  }
  async remove(owner: number, id: number) {
    await this.recoverInterrupted()
    const rows = await this.db
      .delete(gw_cache_tests)
      .where(
        and(
          eq(gw_cache_tests.id, id),
          eq(gw_cache_tests.user_id, owner),
          sql`${gw_cache_tests.status} <> 'running'`,
        ),
      )
      .returning({ id: gw_cache_tests.id })
    if (!rows.length) {
      await this.get(owner, id)
      throw new GatewayError(409, '运行中的缓存验证不能删除')
    }
    return { deleted: id }
  }
  async create(values: typeof gw_cache_tests.$inferInsert) {
    return (await this.db.insert(gw_cache_tests).values(values).returning())[0]!
  }
  async checkpoint(
    owner: number,
    id: number,
    values: Pick<
      typeof gw_cache_tests.$inferInsert,
      'status' | 'summary' | 'results' | 'error_summary'
    >,
  ) {
    const [row] = await this.db
      .update(gw_cache_tests)
      .set(values)
      .where(
        and(
          eq(gw_cache_tests.id, id),
          eq(gw_cache_tests.user_id, owner),
          eq(gw_cache_tests.status, 'running'),
        ),
      )
      .returning()
    if (!row)
      throw new GatewayError(409, 'Cache verification is no longer running')
    return row
  }
  async recoverInterrupted() {
    return this.db
      .update(gw_cache_tests)
      .set({
        status: 'interrupted',
        error_summary:
          'Cache verification interrupted; completed rounds are retained',
      })
      .where(
        and(
          eq(gw_cache_tests.status, 'running'),
          sql`${gw_cache_tests.created_at} < now() - interval '16 minutes'`,
        ),
      )
      .returning({ id: gw_cache_tests.id })
  }
  async usage(owner: number, id: string) {
    const [row] = await this.db
      .select({ request: gw_requests })
      .from(gw_requests)
      .innerJoin(
        gw_keys,
        and(eq(gw_requests.key_id, gw_keys.id), eq(gw_keys.owner_id, owner)),
      )
      .where(eq(gw_requests.id, id))
    return row?.request
  }
}
