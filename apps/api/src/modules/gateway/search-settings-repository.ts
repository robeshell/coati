import { eq, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import {
  gw_search_settings,
  type SearchSettingsOverrides,
} from '@/db/schema/gateway'
export class SearchSettingsRepository {
  constructor(private readonly db: Db) {}
  async read() {
    return (
      (
        await this.db
          .select()
          .from(gw_search_settings)
          .where(eq(gw_search_settings.id, 1))
      )[0]?.config ?? {}
    )
  }
  async update(
    change: (current: SearchSettingsOverrides) => SearchSettingsOverrides,
  ) {
    return this.db.transaction(async (tx) => {
      await tx
        .insert(gw_search_settings)
        .values({ id: 1 })
        .onConflictDoNothing()
      const [row] = await tx
        .select()
        .from(gw_search_settings)
        .where(eq(gw_search_settings.id, 1))
        .for('update')
      const config = change(row!.config)
      await tx
        .update(gw_search_settings)
        .set({ config, updated_at: sql`clock_timestamp()` })
        .where(eq(gw_search_settings.id, 1))
    })
  }
}
