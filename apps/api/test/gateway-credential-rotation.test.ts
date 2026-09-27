import { afterAll, test, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { openTestDb } from './helpers'
import { gw_upstreams, gw_search_settings } from '../src/db/schema/gateway'
import { CredentialVault } from '../src/modules/gateway/crypto'
import { rotateCredentials } from '../src/modules/gateway/credential-rotation'
const db = openTestDb(),
  old = new CredentialVault('fixture-old'),
  next = new CredentialVault('fixture-new')
afterAll(async () => {
  await db.db.execute(
    sql`delete from gw_upstreams where name='rotation-fixture'`,
  )
  await db.db.execute(sql`delete from gw_search_settings`)
  await db.pool.end()
})
test('dry-run preserves ciphertext, all encrypted fields rotate atomically, wrong source leaves data intact', async () => {
  const [row] = await db.db
    .insert(gw_upstreams)
    .values({
      name: 'rotation-fixture',
      base_url: 'https://example.com',
      protocol: 'openai',
      secret: old.encrypt('key-fixture'),
      proxy_secret: old.encrypt('https://user:pass@example.com'),
    })
    .returning()
  await db.db
    .insert(gw_search_settings)
    .values({
      id: 1,
      config: {
        provider: 'tavily',
        api_key: old.encrypt('search-fixture'),
        proxy_url: '',
      },
    })
    .onConflictDoUpdate({
      target: gw_search_settings.id,
      set: {
        config: {
          provider: 'tavily',
          api_key: old.encrypt('search-fixture'),
          proxy_url: '',
        },
      },
    })
  const summary = await rotateCredentials(db.db, old, next)
  expect(summary).toMatchObject({
    applied: false,
    accounts: 1,
    account_proxies: 1,
    search_secrets: 1,
  })
  expect((await db.db.select().from(gw_upstreams))[0]!.secret).toBe(row!.secret)
  await expect(rotateCredentials(db.db, next, old, true)).rejects.toThrow()
  expect((await db.db.select().from(gw_upstreams))[0]!.secret).toBe(row!.secret)
  await rotateCredentials(db.db, old, next, true)
  const [changed] = await db.db
    .select()
    .from(gw_upstreams)
    .where(eq(gw_upstreams.id, row!.id))
  expect(next.decrypt(changed!.secret)).toBe('key-fixture')
  expect(next.decrypt(changed!.proxy_secret!)).toBe(
    'https://user:pass@example.com',
  )
  const [settings] = await db.db.select().from(gw_search_settings)
  expect(next.decrypt(settings!.config.api_key!)).toBe('search-fixture')
  expect(settings!.config.proxy_url).toBe('')
  expect(() => old.decrypt(changed!.secret)).toThrow()
  expect(
    new CredentialVault('fixture-new', ['fixture-old']).decrypt(row!.secret),
  ).toBe('key-fixture')
  await rotateCredentials(db.db, next, old, true)
  expect(
    old.decrypt((await db.db.select().from(gw_upstreams))[0]!.secret),
  ).toBe('key-fixture')
})
