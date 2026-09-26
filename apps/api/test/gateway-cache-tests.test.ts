import Fastify, { type FastifyInstance } from 'fastify'
import { beforeAll, afterAll, beforeEach, test, expect, vi } from 'vitest'
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
} from './helpers'
import { GatewayService, gatewayOptions } from '../src/modules/gateway/service'
import { CacheTestService } from '../src/modules/gateway/cache-test'
import { safePayload } from '../src/common/request-meta'
const db = openTestDb()
let app: FastifyInstance,
  mock: FastifyInstance,
  admin: AuthedSession,
  ordinary: AuthedSession,
  service: GatewayService,
  base: string
let calls: unknown[] = [],
  mode = 'cache',
  keyId = 0,
  primaryId = 0
const root = '/api/admin/gateway/cache-tests'
const payload = () => ({
  name: 'cache fixture',
  key_id: keyId,
  model: 'cache-fixture',
  prompt: 'a fixed reusable test prefix',
  rounds: 3,
  max_tokens: 16,
})
beforeAll(async () => {
  vi.stubEnv('GATEWAY_ALLOW_PRIVATE_UPSTREAMS', 'true')
  mock = Fastify()
  mock.post('/v1/chat/completions', async (request, reply) => {
    calls.push(request.body)
    if (mode === 'switch' && calls.length === 1)
      await db.db.execute(
        sql`update gw_upstreams set enabled=false where id=${primaryId}`,
      )
    if (mode === 'failure' && calls.length === 2)
      return reply.code(400).send({ error: { message: 'mock rejection' } })
    const usage =
      mode === 'unknown'
        ? { prompt_tokens: 100, completion_tokens: 1 }
        : {
            prompt_tokens: 100,
            completion_tokens: 1,
            prompt_tokens_details: {
              cached_tokens: calls.length === 1 ? 0 : 75,
            },
          }
    return {
      id: 'fixture-response',
      object: 'chat.completion',
      model: 'actual-fixture',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage,
    }
  })
  base = await mock.listen({ host: '127.0.0.1', port: 0 })
  app = await buildTestApp()
  const actor = await createFixture(db)
  admin = await superAdminSession(app, db)
  ordinary = await loginSession(
    app,
    FIXTURE_USER,
    FIXTURE_PASSWORD,
    actor.userId,
  )
  service = new GatewayService(db.db, gatewayOptions(app.config))
})
const clean = () =>
  db.db.execute(
    sql`TRUNCATE gw_cache_tests,gw_session_bindings,gw_user_limits,gw_attempts,gw_requests,gw_devices,gw_keys,gw_routes,gw_public_routes,gw_upstreams RESTART IDENTITY CASCADE`,
  )
beforeEach(async () => {
  await clean()
  calls = []
  mode = 'cache'
  const account = await service.saveUpstream({
    name: 'mock-local-only',
    base_url: base + '/v1',
    protocol: 'openai',
    api_key: 'fixture-secret',
    supported_models: ['actual-fixture'],
  })
  primaryId = account.id
  await service.saveRoute({
    model: 'cache-fixture',
    upstream_id: account.id,
    upstream_model: 'actual-fixture',
  })
  const key = await service.createKey(admin.userId, {
    name: 'cache-test-key',
    models: ['cache-fixture'],
  })
  keyId = key.id
})
afterAll(async () => {
  await app.close()
  await service.transport.close()
  await mock.close()
  await clean()
  await cleanupFixture(db)
  await db.pool.end()
  vi.unstubAllEnvs()
})
test('same requests traverse HTTP upstream and quota/usage accounting, preserving zero and derived miss', async () => {
  const response = await admin.inject({
    method: 'POST',
    url: root,
    payload: payload(),
  })
  expect(response.statusCode, response.body).toBe(201)
  const run = response.json()
  expect(run).toMatchObject({
    status: 'ok',
    summary: {
      completed_rounds: 3,
      account_consistent: true,
      cache_read_tokens: 150,
      cache_miss_tokens: 150,
      hit_ratio: 0.5,
    },
  })
  expect(run.results[0]).toMatchObject({
    cache_read_tokens: 0,
    cache_miss_tokens: 100,
    cache_miss_source: 'derived',
    hit_ratio: 0,
    upstream_name: 'mock-local-only',
    upstream_model: 'actual-fixture',
  })
  expect(calls).toHaveLength(3)
  expect(calls[0]).toEqual(calls[1])
  expect(calls[1]).toEqual(calls[2])
  const result = await db.db.execute<{
    n: number
    tokens: number
    sessions: number
  }>(
    sql`select count(*)::int n,sum(input_tokens+output_tokens)::int tokens,count(distinct request_context->>'session_id')::int sessions from gw_requests where key_id=${keyId} and status='ok'`,
  )
  expect(result.rows[0]).toMatchObject({ n: 3, tokens: 303, sessions: 1 })
  const list = await admin.inject({ url: root })
  expect(list.json().items[0]).not.toHaveProperty('prompt')
  expect(
    (await admin.inject({ url: root + '/' + run.id })).json().results,
  ).toHaveLength(3)
  const legacy = await admin.inject({url:'/api/admin/agent/cache-tests/'+run.id})
  expect(legacy.statusCode).toBe(200)
  expect(legacy.json().round_details).toHaveLength(3)
  expect(legacy.json().summary).toMatchObject({rounds_total:3,rounds_ok:3})
  expect(safePayload(payload())).not.toContain(payload().prompt)
})
test('missing cache counters remain unknown and first failure preserves partial results', async () => {
  mode = 'unknown'
  const unknown = await admin.inject({
    method: 'POST',
    url: root,
    payload: { ...payload(), rounds: 1 },
  })
  expect(unknown.json().results[0]).toMatchObject({
    cache_read_tokens: null,
    cache_miss_tokens: null,
    hit_ratio: null,
    cache_status: 'unreported',
  })
  expect(unknown.json().summary).toMatchObject({
    hit_ratio: null,
    cache_read_tokens: null,
    cache_status: 'unreported',
  })
  calls = []
  mode = 'failure'
  const partial = await admin.inject({
    method: 'POST',
    url: root,
    payload: payload(),
  })
  expect(partial.json()).toMatchObject({
    status: 'partial',
    summary: { completed_rounds: 1, attempted_rounds: 2 },
  })
  expect(calls).toHaveLength(2)
  expect(partial.json().results[1].request_id).toBeTruthy()
  calls = []
  mode = 'switch'
  const backup = await service.saveUpstream({
    name: 'mock-backup',
    base_url: base + '/v1',
    protocol: 'openai',
    api_key: 'fixture-backup',
    supported_models: ['actual-fixture'],
  })
  await service.saveRoute({
    model: 'cache-fixture',
    upstream_id: backup.id,
    upstream_model: 'actual-fixture',
    priority: 200,
  })
  const switched = await admin.inject({
    method: 'POST',
    url: root,
    payload: payload(),
  })
  expect(switched.json()).toMatchObject({
    status: 'ok',
    summary: { account_consistent: false },
  })
  expect(switched.json().summary.warning).toContain('切换')
  expect(
    new Set(
      switched
        .json()
        .results.map((row: { upstream_id: number }) => row.upstream_id),
    ).size,
  ).toBe(2)
})
test('permissions, owner isolation, revoked keys, quota, and cancellation cannot reach upstream', async () => {
  expect(
    (await ordinary.inject({ method: 'POST', url: root, payload: payload() }))
      .statusCode,
  ).toBe(403)
  const cache = new CacheTestService(service)
  await expect(
    cache.run(ordinary.userId, payload(), new AbortController().signal),
  ).rejects.toMatchObject({ status: 404 })
  const cancelled = await cache.run(
    admin.userId,
    payload(),
    AbortSignal.abort(),
  )
  expect(cancelled.status).toBe('failed')
  await expect(
    cache.repo.get(ordinary.userId, cancelled.id),
  ).rejects.toMatchObject({ status: 404 })
  await expect(
    cache.repo.remove(ordinary.userId, cancelled.id),
  ).rejects.toMatchObject({ status: 404 })
  await db.db.execute(sql`update gw_keys set daily_limit=1 where id=${keyId}`)
  const limited = await cache.run(
    admin.userId,
    payload(),
    new AbortController().signal,
  )
  expect(limited.status).toBe('failed')
  expect(limited.results[0]!.http_status).toBe(429)
  await db.db.execute(sql`update gw_keys set revoked=true where id=${keyId}`)
  expect(
    (await admin.inject({ method: 'POST', url: root, payload: payload() }))
      .statusCode,
  ).toBe(409)
  expect(calls).toHaveLength(0)
  expect(
    (await admin.inject({ method: 'DELETE', url: root + '/' + cancelled.id }))
      .statusCode,
  ).toBe(200)
})

test('durable rounds survive interruption and recovery cannot overwrite live or completed runs', async () => {
  const repo = new CacheTestService(service).repo
  const {key_id: _key,...fields}=payload()
  const record=await repo.create({...fields,user_id:admin.userId,status:'running',summary:{},results:[]})
  await expect(repo.remove(admin.userId,record.id)).rejects.toMatchObject({status:409})
  await repo.checkpoint(admin.userId,record.id,{status:'running',summary:{completed_rounds:1},results:[{round:1,status:'ok'}]})
  expect(await repo.recoverInterrupted()).toHaveLength(0)
  await db.db.execute(sql`update gw_cache_tests set created_at=now()-interval '17 minutes' where id=${record.id}`)
  expect(await repo.get(admin.userId,record.id)).toMatchObject({status:'interrupted',results:[{round:1,status:'ok'}]})
  await expect(repo.checkpoint(admin.userId,record.id,{status:'ok',summary:{},results:[]})).rejects.toMatchObject({status:409})
  expect(await repo.recoverInterrupted()).toHaveLength(0)
  expect(calls).toHaveLength(0)
})


test('cookie-authorized cache runs need no PAT and internal accounting cannot become a bearer credential', async () => {
  const { key_id: _key, ...input } = payload()
  const models = await admin.inject({ method: 'GET', url: root + '/models' })
  expect(models.statusCode).toBe(200)
  expect(models.json().models).toContain('cache-fixture')
  expect((await db.db.execute(sql`select count(*)::int n from gw_keys where kind='internal-cache'`)).rows[0]?.n).toBe(0)
  const result = await admin.inject({ method: 'POST', url: root, payload: input })
  expect(result.statusCode, result.body).toBe(201)
  expect(result.json().summary.completed_rounds).toBe(3)
  const [identity] = (await db.db.execute(sql`select id,digest from gw_keys where kind='internal-cache'`)).rows
  expect(await service.repo.key(String(identity!.digest))).toBeUndefined()
  expect((await service.keys(admin.userId)).some(key => key.id === identity!.id)).toBe(false)
  await expect(service.authenticateOwnedKey(admin.userId, Number(identity!.id))).rejects.toMatchObject({ status: 404 })
  await expect(service.rotateKey(admin.userId, Number(identity!.id))).rejects.toMatchObject({ status: 404 })
  await service.saveUserLimits(admin.userId, { daily_limit: 1, concurrency_limit: 0, rpm_limit: 0 })
  const limited = await admin.inject({ method: 'POST', url: root, payload: input })
  expect(limited.json().results[0].http_status).toBe(429)
  expect(calls).toHaveLength(3)
  expect((await db.db.execute(sql`select count(*)::int n from gw_keys where kind='internal-cache'`)).rows[0]?.n).toBe(1)
})
