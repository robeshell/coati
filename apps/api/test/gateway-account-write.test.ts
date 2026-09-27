import Fastify, { type FastifyInstance } from 'fastify'
import { beforeAll, afterAll, test, expect, vi } from 'vitest'
import { sql } from 'drizzle-orm'
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
  mock: FastifyInstance,
  admin: AuthedSession,
  ordinary: AuthedSession,
  actor: Fixture,
  base: string
let calls = 0,
  fail = false
const root = '/api/admin/agent/credentials'
const personal = '/api/admin/agent/my-channels'
const ids: number[] = []
beforeAll(async () => {
  vi.stubEnv('GATEWAY_ALLOW_PRIVATE_UPSTREAMS', 'true')
  mock = Fastify()
  mock.get('/v1/models', async (_req, reply) => {
    calls++
    if (fail) return reply.code(503).send({ error: 'mock unavailable' })
    return { data: [{ id: 'fixture-model' }] }
  })
  base = await mock.listen({ port: 0, host: '127.0.0.1' })
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
  await mock.close()
  for (const id of ids) {
    await db.db.execute(
      sql`delete from gw_public_routes where upstream_id=${id}`,
    )
    await db.db.execute(sql`delete from gw_upstreams where id=${id}`)
  }
  await cleanupFixture(db)
  await db.pool.end()
  vi.unstubAllEnvs()
})
const create = async (path = root, extra: Record<string, unknown> = {}) => {
  const response = await admin.inject({
    method: 'POST',
    url: path,
    payload: {
      name: 'legacy-write-fixture',
      base_url: base + '/v1',
      api_key: 'legacy-secret-key',
      supported_models: ['fixture-model'],
      ...extra,
    },
  })
  expect(response.statusCode, response.body).toBe(201)
  ids.push(response.json().id)
  return response
}
const row = async (id: number) =>
  (await db.db.execute(sql`select * from gw_upstreams where id=${id}`)).rows[0]!
test('account lifecycle preserves encrypted fields, copy resets observations, and delete protects referenced accounts', async () => {
  const response = await create(root, {
    provider: 'spoofed',
    extra_headers_json: '{"X-Tenant":"fixture"}',
    default_model: 'fallback-model',
    weight: '130',
  })
  const id = response.json().id,
    before = await row(id)
  expect(response.json()).toMatchObject({
    provider: 'openai-compatible',
    weight: 130,
    upstream_protocol: 'openai-chat',
    health_probe: { ok: true, attempted: true },
  })
  expect(response.body).not.toContain('legacy-secret-key')
  expect(before.secret).not.toBe('legacy-secret-key')
  const update = await admin.inject({
    method: 'PUT',
    url: `${root}/${id}`,
    payload: { note: 'changed', api_key: '', enabled: 'false' },
  })
  expect(update.statusCode, update.body).toBe(200)
  expect(update.json()).toMatchObject({
    note: 'changed',
    weight: 130,
    enabled: false,
    supported_models: ['fallback-model', 'fixture-model'],
  })
  expect((await row(id)).secret).toBe(before.secret)
  const copy = await admin.inject({ method: 'POST', url: `${root}/${id}/copy` })
  expect(copy.statusCode, copy.body).toBe(201)
  const copyId = copy.json().id
  ids.push(copyId)
  expect(copy.json()).toMatchObject({
    name: 'legacy-write-fixture（复制）',
    enabled: false,
    health_status: 'unknown',
    last_checked_at: null,
    last_success_at: null,
    last_used_at: null,
  })
  expect((await row(copyId)).secret).toBe(before.secret)
  await db.db.execute(
    sql`insert into gw_public_routes(model,upstream_id,enabled) values('legacy-write-ref',${id},false)`,
  )
  expect(
    (await admin.inject({ method: 'DELETE', url: `${root}/${id}` })).statusCode,
  ).toBe(409)
  await db.db.execute(sql`delete from gw_public_routes where upstream_id=${id}`)
  expect(
    (await admin.inject({ method: 'DELETE', url: `${root}/${id}` })).json(),
  ).toEqual({ ok: true })
  expect(
    (await admin.inject({ method: 'DELETE', url: `${root}/${id}` })).statusCode,
  ).toBe(404)
})
test('creation survives failed probe; discovery rejects credential destination changes and checks report current health', async () => {
  fail = true
  const failed = await create()
  fail = false
  expect(failed.json().health_probe).toMatchObject({
    ok: false,
    attempted: true,
  })
  const id = failed.json().id
  expect(await row(id)).toBeTruthy()
  const start = calls
  const refused = await admin.inject({
    method: 'POST',
    url: root + '/discover-models',
    payload: { credential_id: String(id), base_url: 'http://127.0.0.1:1/v1' },
  })
  expect(refused.statusCode, refused.body).toBe(400)
  expect(calls).toBe(start)
  const discovered = await admin.inject({
    method: 'POST',
    url: root + '/discover-models',
    payload: { credential_id: String(id) },
  })
  expect(discovered.statusCode, discovered.body).toBe(200)
  expect(discovered.json()).toMatchObject({
    models: ['fixture-model'],
    model_count: 1,
  })
  const checked = await admin.inject({
    method: 'POST',
    url: `${root}/${id}/check`,
  })
  expect(checked.statusCode, checked.body).toBe(200)
  expect(checked.json()).toMatchObject({
    ok: true,
    verified: true,
    health_status: 'healthy',
    model_count: 1,
  })
  await db.db.execute(
    sql`update gw_upstreams set health_status='unknown',last_probe_at=null,last_checked_at=null where id=${id}`,
  )
  const batch = await admin.inject({
    method: 'POST',
    url: root + '/health-probe',
    payload: { limit: '50', quiet_seconds: '30' },
  })
  expect(batch.statusCode, batch.body).toBe(200)
  expect(batch.json().items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id, ok: true, scope: 'platform' }),
    ]),
  )
  expect(
    batch
      .json()
      .items.every((item: { scope: string }) => item.scope === 'platform'),
  ).toBe(true)
  expect(
    (
      await admin.inject({
        method: 'POST',
        url: root + '/health-probe',
        payload: { limit: 'invalid' },
      })
    ).statusCode,
  ).toBe(400)
  expect(
    (await admin.inject({ method: 'DELETE', url: `${root}/${id}` })).statusCode,
  ).toBe(409)
})
test('personal CRUD uses session owner; platform operations and cross-owner IDs stay isolated', async () => {
  const created = await create(personal, {
    model_prefix: 'mine',
    upstream_protocol: 'anthropic-messages',
  })
  const id = created.json().id
  expect(created.json()).toMatchObject({
    owner_user_id: admin.userId,
    scope: 'personal',
    health_probe: { verified: false },
  })
  for (const [method, url, payload] of [
    ['PUT', `${root}/${id}`, { note: 'forbidden' }],
    ['POST', `${root}/${id}/copy`, {}],
    ['POST', root + '/discover-models', { credential_id: id }],
    ['POST', `${root}/${id}/check`, {}],
    ['DELETE', `${root}/${id}`, {}],
  ] as const)
    expect((await admin.inject({ method, url, payload })).statusCode).toBe(404)
  expect(
    (await ordinary.inject({ method: 'POST', url: root, payload: {} }))
      .statusCode,
  ).toBe(403)
  expect(
    (await app.inject({ method: 'POST', url: root, payload: {} })).statusCode,
  ).toBe(401)
  await db.db.execute(
    sql`update gw_upstreams set owner_user_id=${actor.userId} where id=${id}`,
  )
  expect(
    (
      await admin.inject({
        method: 'PUT',
        url: `${personal}/${id}`,
        payload: { note: 'forbidden' },
      })
    ).statusCode,
  ).toBe(404)
  expect(
    (
      await admin.inject({
        method: 'POST',
        url: personal + '/discover-models',
        payload: { credential_id: id },
      })
    ).statusCode,
  ).toBe(404)
  expect(
    (await admin.inject({ method: 'DELETE', url: `${personal}/${id}` }))
      .statusCode,
  ).toBe(404)
})
