import { afterAll, beforeAll, expect, test } from 'vitest'
import { inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { gw_upstreams } from '../src/db/schema/gateway'
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
const db = openTestDb()
let app: FastifyInstance,
  admin: AuthedSession,
  ordinary: AuthedSession,
  actor: Fixture
let ids: number[] = [],
  menu: number | undefined
const root = '/api/admin/agent'
const prefix = 'legacy-list-fixture'
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
  const base = {
    base_url: 'https://example.invalid/v1',
    secret: 'private-ciphertext',
    probe_token: 'private-probe-claim',
  }
  const rows = await db.db
    .insert(gw_upstreams)
    .values([
      {
        ...base,
        name: prefix + '-a',
        protocol: 'openai',
        provider: 'openai',
        default_model: 'unique-needle-model',
        supported_models: ['other'],
        api_key_hint: 'abcd…wxyz',
        key_fingerprint: 'fixture-hash',
        proxy_secret: 'private-proxy-ciphertext',
        proxy_hint: 'https://proxy.invalid',
        health_status: 'healthy',
        extra_headers: { 'X-Tenant': 'demo' },
        last_used_at: '2026-01-02 03:04:05.123456+00',
        created_at: '2026-01-01 00:00:00+00',
        updated_at: null,
      },
      { ...base, name: prefix + '-b', protocol: 'responses', enabled: false },
      {
        ...base,
        name: prefix + '-c',
        protocol: 'anthropic',
        health_status: 'cooldown',
        cooldown_until: '2099-01-01 00:00:00+00',
      },
      {
        ...base,
        name: prefix + '-own',
        protocol: 'openai',
        scope: 'personal',
        owner_user_id: actor.userId,
        model_prefix: 'mine',
      },
      {
        ...base,
        name: prefix + '-admin',
        protocol: 'responses',
        scope: 'personal',
        owner_user_id: admin.userId,
        model_prefix: 'admin',
      },
    ])
    .returning()
  ids = rows.map((row) => row.id)
})
afterAll(async () => {
  await app.close()
  if (ids.length)
    await db.db.delete(gw_upstreams).where(inArray(gw_upstreams.id, ids))
  await cleanupFixture(db)
  if (menu) await db.db.execute(sql`delete from menus where id=${menu}`)
  await db.pool.end()
})
const platform = (query: string) =>
  admin.inject({ url: `${root}/credentials?${query}` })
test('legacy account lists require an admin session and their own menu permission', async () => {
  for (const path of ['credentials', 'my-channels']) {
    expect((await app.inject({ url: `${root}/${path}` })).statusCode).toBe(401)
    expect((await ordinary.inject({ url: `${root}/${path}` })).statusCode).toBe(
      403,
    )
  }
})
test('platform list serializes the Python allowlist, models and microsecond history without secrets', async () => {
  const response = await platform('search=unique-needle-model')
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json()).toMatchObject({ total: 1, page: 1, per_page: 20 })
  expect(response.json().items[0]).toEqual({
    id: ids[0],
    name: prefix + '-a',
    provider: 'openai',
    upstream_protocol: 'openai-chat',
    base_url: 'https://example.invalid/v1',
    api_key_masked: 'abcd…wxyz',
    key_fingerprint: 'fixture-hash',
    supported_models: ['unique-needle-model', 'other'],
    default_model: 'unique-needle-model',
    model_prefix: '',
    extra_headers: { 'X-Tenant': 'demo' },
    proxy_enabled: true,
    proxy_hint: 'https://proxy.invalid',
    priority: 100,
    weight: 1,
    request_timeout_seconds: 120,
    enabled: true,
    note: null,
    health_status: 'healthy',
    consecutive_failures: 0,
    last_checked_at: null,
    last_success_at: null,
    last_error_at: null,
    last_error: null,
    last_latency_ms: null,
    cooldown_until: null,
    cooldown_active: false,
    last_used_at: '2026-01-02T03:04:05.123456Z',
    scope: 'platform',
    owner_user_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: null,
  })
  expect(response.body).not.toContain('private-')
})
test('platform search, descending pagination and unfiltered summary preserve scope', async () => {
  const first = (await platform(`search=${prefix}&per_page=2`)).json()
  expect(first.total).toBe(3)
  expect(first.items.map((row: { id: number }) => row.id)).toEqual([
    ids[2],
    ids[1],
  ])
  const second = (await platform(`search=${prefix}&per_page=2&page=2`)).json()
  expect(second.items.map((row: { id: number }) => row.id)).toEqual([ids[0]])
  const empty = (await platform(`search=never-matches-this-fixture`)).json()
  expect(empty.items).toEqual([])
  expect(empty.summary).toEqual(first.summary)
  expect(second.summary).toEqual(first.summary)
})
test('legacy filters retain Python protocol names, boolean coercion and SQL wildcard search', async () => {
  for (const [query, expected] of [
    [`search=${prefix}&enabled=off`, [ids[1]]],
    [`search=${prefix}&enabled=yes&health_status=cooldown`, [ids[2]]],
    [`search=${prefix}&provider=openai`, [ids[0]]],
    [`search=${prefix}&upstream_protocol=openai-responses`, [ids[1]]],
    [`search=${prefix}&upstream_protocol=responses`, []],
    [`search=${prefix}%25&enabled=`, [ids[2], ids[1], ids[0]]],
  ] as const) {
    expect(
      (await platform(query)).json().items.map((row: { id: number }) => row.id),
    ).toEqual(expected)
  }
  const byProtocol = (await platform('search=ANTHROPIC-MESSAGES')).json()
  expect(
    byProtocol.items.some((row: { id: number }) => row.id === ids[2]),
  ).toBe(true)
  expect(
    byProtocol.items.every(
      (row: { upstream_protocol: string }) =>
        row.upstream_protocol === 'anthropic-messages',
    ),
  ).toBe(true)
})
test('legacy pagination clamps negative and huge sizes and defaults invalid integers', async () => {
  expect((await platform('page=-2&per_page=0')).json()).toMatchObject({
    page: 1,
    per_page: 1,
  })
  expect((await platform('page=no&per_page=no')).json()).toMatchObject({
    page: 1,
    per_page: 20,
  })
  expect(
    (await platform('page=999999999999999999999999&per_page=9999')).json(),
  ).toMatchObject({ per_page: 100, items: [] })
})
test('personal list uses authenticated ownership even for superadmins and ignores forged scope', async () => {
  let row = (
    await db.db.execute(
      sql`select id from menus where code='gateway_my_channels'`,
    )
  ).rows[0]
  if (!row) {
    row = (
      await db.db.execute(
        sql`insert into menus(name,code,menu_type,is_visible) values('Account list fixture','gateway_my_channels','menu',false) returning id`,
      )
    ).rows[0]!
    menu = Number(row.id)
  }
  await db.db.execute(
    sql`insert into role_menus(role_id,menu_id) values(${actor.roleId},${Number(row.id)}) on conflict do nothing`,
  )
  const response = await ordinary.inject({
    url: `${root}/my-channels?scope=platform&owner_user_id=${admin.userId}`,
  })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().items.map((row: { id: number }) => row.id)).toEqual([
    ids[3],
  ])
  expect(response.json().summary).toEqual({
    total: 1,
    enabled: 1,
    disabled: 0,
    used: 0,
    healthy: 0,
    unhealthy: 0,
    cooling: 0,
    recovering: 0,
    unknown: 1,
  })
  const filtered = await ordinary.inject({
    url: `${root}/my-channels?enabled=false`,
  })
  expect(filtered.json().items).toEqual([])
  expect(filtered.json().summary).toEqual(response.json().summary)
  expect(
    (await ordinary.inject({ url: `${root}/credentials` })).statusCode,
  ).toBe(403)
  const own = await admin.inject({
    url: `${root}/my-channels?search=${prefix}`,
  })
  expect(own.json().items.map((row: { id: number }) => row.id)).toEqual([
    ids[4],
  ])
})
