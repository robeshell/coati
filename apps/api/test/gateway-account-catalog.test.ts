import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  providerCatalog,
  protocolCatalog,
} from '../src/modules/gateway/account-catalog'
import {
  buildTestApp,
  openTestDb,
  superAdminSession,
  createFixture,
  cleanupFixture,
  loginSession,
  FIXTURE_USER,
  FIXTURE_PASSWORD,
  type AuthedSession,
  type Fixture,
} from './helpers'
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/python-account-catalog.json', import.meta.url),
    'utf8',
  ),
)
const db = openTestDb()
let app: FastifyInstance,
  admin: AuthedSession,
  ordinary: AuthedSession,
  actor: Fixture
let addedMenu: number | undefined
beforeAll(async () => {
  app = await buildTestApp()
  actor = await createFixture(db)
  admin = await superAdminSession(app, db)
  ordinary = await loginSession(
    app,
    FIXTURE_USER,
    FIXTURE_PASSWORD,
    actor.userId,
  )
})
afterAll(async () => {
  await app.close()
  await cleanupFixture(db)
  if (addedMenu)
    await db.db.execute(sql`delete from menus where id=${addedMenu}`)
  await db.pool.end()
})

test('catalog fixture pins the actual Python migration sources', () => {
  for (const [path, hash] of Object.entries(fixture.sources)) {
    expect(
      createHash('sha256')
        .update(readFileSync(resolve('../..', path)))
        .digest('hex'),
    ).toBe(hash)
  }
})
test('catalog preserves Python provider status, empty model defaults and protocol capability metadata', () => {
  expect(providerCatalog()).toEqual({ items: fixture.providers })
  expect(protocolCatalog()).toEqual({ items: fixture.protocols })
  expect(
    providerCatalog().items.find((item) => item.code === 'gemini'),
  ).toMatchObject({ available: false, status: 'reserved' })
  expect(
    protocolCatalog().items.find((item) => item.code === 'anthropic-messages'),
  ).toMatchObject({
    model_discovery: true,
    model_discovery_verifies_health: false,
  })
  const first = providerCatalog()
  first.items[0]!.label = 'changed by caller'
  expect(providerCatalog()).toEqual({ items: fixture.providers })
})
const prefixes = [
  '/api/admin/gateway',
  '/api/admin/agent',
  '/api/admin/gateway/my-channels',
  '/api/admin/agent/my-channels',
]
for (const prefix of prefixes)
  for (const kind of ['providers', 'upstream-protocols']) {
    test(`catalog ${prefix}/${kind} preserves payload and requires session and menu permission`, async () => {
      const url = `${prefix}/${kind}`
      expect((await app.inject({ url })).statusCode).toBe(401)
      expect((await ordinary.inject({ url })).statusCode).toBe(403)
      const response = await admin.inject({ url })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toEqual(
        kind === 'providers'
          ? { items: fixture.providers }
          : prefix.includes('/gateway')
            ? protocolCatalog(true)
            : { items: fixture.protocols },
      )
    })
  }
test('personal catalog permission grants both aliases without granting platform catalog access', async () => {
  let row = (
    await db.db.execute(
      sql`select id from menus where code='gateway_my_channels'`,
    )
  ).rows[0]
  if (!row) {
    row = (
      await db.db.execute(
        sql`insert into menus(name,code,menu_type,is_visible) values('Personal catalog fixture','gateway_my_channels','menu',false) returning id`,
      )
    ).rows[0]!
    addedMenu = Number(row.id)
  }
  await db.db.execute(
    sql`insert into role_menus(role_id,menu_id) values(${actor.roleId},${Number(row.id)}) on conflict do nothing`,
  )
  for (const prefix of prefixes) {
    const response = await ordinary.inject({
      url: `${prefix}/upstream-protocols`,
    })
    expect(response.statusCode, response.body).toBe(
      prefix.includes('/my-channels') ? 200 : 403,
    )
  }
})
