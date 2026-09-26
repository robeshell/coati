import { eq, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { gw_upstreams, gw_search_settings } from '@/db/schema/gateway'
import { CredentialVault } from './crypto'

/** Offline all-or-nothing re-encryption. Caller must stop every writer/worker first. */
export async function rotateCredentials(
  db: Db,
  source: CredentialVault,
  target: CredentialVault,
  apply = false,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`)
    await tx.execute(
      sql`lock table gw_upstreams, gw_search_settings in exclusive mode`,
    )
    const accounts = await tx.select().from(gw_upstreams)
    const settings = await tx.select().from(gw_search_settings)
    const converted = accounts.map((row) => ({
      id: row.id,
      secret: target.encrypt(source.decrypt(row.secret)),
      proxy_secret: row.proxy_secret
        ? target.encrypt(source.decrypt(row.proxy_secret))
        : row.proxy_secret,
    }))
    const configs = settings.map((row) => {
      const config = { ...row.config }
      for (const field of ['api_key', 'proxy_url'] as const)
        if (config[field])
          config[field] = target.encrypt(source.decrypt(config[field]!))
      return { id: row.id, config }
    })
    if (apply) {
      for (const { id, ...value } of converted)
        await tx.update(gw_upstreams).set(value).where(eq(gw_upstreams.id, id))
      for (const { id, config } of configs)
        await tx
          .update(gw_search_settings)
          .set({ config })
          .where(eq(gw_search_settings.id, id))
    }
    return {
      applied: apply,
      accounts: accounts.length,
      account_proxies: accounts.filter((row) => row.proxy_secret).length,
      search_secrets: settings.reduce(
        (n, row) =>
          n +
          Number(Boolean(row.config.api_key)) +
          Number(Boolean(row.config.proxy_url)),
        0,
      ),
    }
  })
}
