import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { schedulingPolicy } from '../src/modules/gateway/scheduling-policy'
import {
  credentialMetadata,
  accountSummary,
} from '../src/modules/gateway/account-metadata'
import { startProxyFixture } from './proxy-fixture'
import { readFileSync } from 'node:fs'
import { listQuotas } from '../src/modules/gateway/quotas'
import { read, utils } from 'xlsx'
import * as authHelpers from '../src/common/auth'
import { generatePasswordHash } from '../src/common/password'
import { beforeAll, afterAll, beforeEach, vi, test, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'
import { sql } from 'drizzle-orm'
import {
  buildTestApp,
  testConfig,
  openTestDb,
  superAdminSession,
  type AuthedSession,
} from './helpers'
import { runProbeBatch } from '../src/modules/gateway/probe-runner'
import { GatewayService, gatewayOptions } from '../src/modules/gateway/service'
import { GatewayRepository } from '../src/modules/gateway/repository'
import { CredentialVault } from '../src/modules/gateway/crypto'
import { UsageMeter, nativeStream } from '../src/modules/gateway/stream'
import {
  GatewayTransport,
  validateBase,
  routeBase,
  privateAddress,
} from '../src/modules/gateway/transport'
const handle = openTestDb()
let app: FastifyInstance,
  upstream: FastifyInstance,
  session: AuthedSession,
  service: GatewayService,
  base: string
let failureStatus = 503
let failureBody = 'upstream unavailable secret-test-key'
let behavior = 'normal',
  calls = 0,
  observed: any,
  observedWireHeaders: any,
  clientClosed = false
beforeAll(async () => {
  process.env.GATEWAY_ALLOW_PRIVATE_UPSTREAMS = 'true'
  upstream = Fastify()
  upstream.post('/v1/:a', async (request, reply) =>
    respond(request.body, reply, request.headers),
  )
  upstream.post('/v1/chat/completions', async (request, reply) =>
    respond(request.body, reply, request.headers),
  )
  upstream.post('/v1/alternate/chat/completions', async (request, reply) =>
    respond(request.body, reply, request.headers),
  )
  upstream.get('/v1/models', async (request, reply) => {
    observed = request.headers
    calls++
    if (behavior === 'discovery-unsupported') return reply.code(404).send({})
    if (behavior === 'discovery-failure')
      return reply.code(401).send({ error: 'secret-test-key' })
    if (behavior === 'discovery-html')
      return reply.type('text/html').send('<html>login</html>')
    return {
      data: [{ id: 'fixture-b' }, { id: 'fixture-a' }, { id: 'fixture-b' }],
    }
  })
  function respond(body: any, reply: any, headers: any) {
    observedWireHeaders = headers
    calls++
    observed = body
    if (
      behavior.startsWith('account-timeout-') &&
      (behavior !== 'account-timeout-retry' || calls === 1)
    ) {
      reply.hijack()
      reply.raw.on('close', () => {
        clientClosed = true
      })
      if (behavior === 'account-timeout-body') {
        reply.raw.writeHead(200, { 'content-type': 'application/json' })
        reply.raw.write('{')
      } else if (behavior === 'account-timeout-stream') {
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream' })
        reply.raw.write(
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        )
      }
      return reply
    }
    if (behavior === 'raw-failure') return reply.code(failureStatus).type('text/plain').send(failureBody)
    if (behavior === 'failure' || (behavior === 'fail-once' && calls === 1))
      return reply.code(failureStatus).send({ error: { message: failureBody } })
    if (behavior === 'invalid-json')
      return reply.type('application/json').send('null')
    if (body.stream) {
      reply.header('content-type', 'text/event-stream')
      const protocol = body.model
      const frames =
        protocol === 'anthropic'
          ? [
              'event: message_start\ndata: {"type":"message_start","message":{"model":"anthropic","usage":{"input_tokens":10,"cache_read_input_tokens":2,"output_tokens":0}}}\n\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"你好"}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ]
          : protocol === 'responses'
            ? [
                'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\n',
                'event: response.completed\ndata: {"type":"response.completed","response":{"model":"responses","usage":{"input_tokens":10,"output_tokens":3}}}\n\n',
              ]
            : [
                'data: {"model":"openai","choices":[{"delta":{"content":"你好"}}]}\n\n',
                'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\n',
                'data: [DONE]\n\n',
              ]
      reply.raw.on('close', () => {
        clientClosed = true
      })
      return reply.send(
        Readable.from(
          (async function* () {
            for (const frame of frames) {
              if (behavior === 'truncated' && frame.includes('[DONE]')) return
              yield frame
              if (behavior === 'slow')
                await new Promise((r) => setTimeout(r, 100))
            }
          })(),
        ),
      )
    }
    return {
      id: 'fixture',
      model: body.model,
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    }
  }
  await upstream.listen({ host: '127.0.0.1', port: 0 })
  base = `http://127.0.0.1:${(upstream.server.address() as any).port}/v1`
  app = await buildTestApp()
  await app.listen({ host: '127.0.0.1', port: 0 })
  session = await superAdminSession(app, handle)
  service = new GatewayService(handle.db, {
    encryptionKey: 'test-only-key',
    allowPrivate: true,
    timeoutMs: 5000,
    idleTimeoutMs: 1000,
  })
})
beforeEach(async () => {
  await handle.db.execute(
    sql`TRUNCATE gw_route_migrations,gw_device_rate_limits,gw_user_limits,gw_attempts,gw_requests,gw_devices,gw_keys,gw_routes,gw_upstreams RESTART IDENTITY CASCADE`,
  )
  behavior = 'normal'
  failureStatus = 503
  failureBody = 'upstream unavailable secret-test-key'
  calls = 0
  clientClosed = false
})
afterAll(async () => {
  await handle.db.execute(
    sql`TRUNCATE gw_route_migrations,gw_device_rate_limits,gw_user_limits,gw_attempts,gw_requests,gw_devices,gw_keys,gw_routes,gw_upstreams RESTART IDENTITY CASCADE`,
  )
  app?.server.closeAllConnections()
  upstream?.server.closeAllConnections()
  await app?.close()
  await service?.transport.close()
  await upstream?.close()
  await handle.pool.end()
  delete process.env.GATEWAY_ALLOW_PRIVATE_UPSTREAMS
})
async function setup(protocol = 'openai', keyOverrides = {}) {
  const u = await session.inject({
    method: 'POST',
    url: '/api/admin/gateway/upstreams',
    payload: {
      name: 'Fixture',
      supported_models: [protocol, 'text-target', 'vision-target'],
      protocol,
      base_url: base,
      api_key: 'secret-test-key',
    },
  })
  expect(u.statusCode, u.body).toBe(201)
  expect(u.body).not.toContain('secret-test-key')
  expect(u.json().secret).toBeUndefined()
  const r = await session.inject({
    method: 'POST',
    url: '/api/admin/gateway/routes',
    payload: {
      model: 'public-model',
      upstream_id: u.json().id,
      upstream_model: protocol,
    },
  })
  expect(r.statusCode, r.body).toBe(201)
  const k = await session.inject({
    method: 'POST',
    url: '/api/admin/gateway/keys',
    payload: { name: 'fixture', models: ['public-model'], ...keyOverrides },
  })
  expect(k.statusCode, k.body).toBe(201)
  return k.json()
}
const invoke = (
  token: string,
  payload: any = { model: 'public-model' },
  path = '/v1/chat/completions',
) =>
  app.inject({
    method: 'POST',
    url: path,
    headers: { authorization: `Bearer ${token}` },
    payload,
  })
test('encrypts credentials with authenticated encryption and rejects tampering', () => {
  const vault = new CredentialVault('x'),
    encrypted = vault.encrypt('secret')
  expect(encrypted).not.toContain('secret')
  expect(vault.decrypt(encrypted)).toBe('secret')
  expect(() => new CredentialVault('y').decrypt(encrypted)).toThrow()
})
test('public upstream defaults reject private addresses and credential-bearing URLs', () => {
  expect(() => validateBase('http://127.0.0.1/v1', false)).toThrow()
  expect(() => validateBase('https://a:b@example.com/v1', true)).toThrow()
  expect(privateAddress('169.254.169.254')).toBe(true)
  expect(privateAddress('::1')).toBe(true)
})
test('admin login, configuration, API invocation and usage form one complete flow', async () => {
  const k = await setup()
  const res = await invoke(k.token)
  expect(res.statusCode, res.body).toBe(200)
  expect(res.json().model).toBe('public-model')
  expect(observed.model).toBe('openai')
  const records = await service.repo.listRequests()
  expect(records.items[0]).toMatchObject({
    status: 'ok',
    input_tokens: 10,
    output_tokens: 3,
    usage_source: 'upstream',
  })
  expect(await service.repo.attempts(records.items[0]!.id)).toHaveLength(1)
  const keys = await session.inject({
    method: 'GET',
    url: '/api/admin/gateway/keys',
  })
  expect(keys.body).not.toContain(k.token)
  expect(keys.body).not.toContain('digest')
})
test('gateway uses bearer authentication independently of console cookies/CSRF', async () => {
  const k = await setup()
  const denied = await app.inject({
    method: 'POST',
    url: '/api/admin/gateway/routes',
    payload: {},
    cookies: { coati_session: session.cookie },
  })
  expect(denied.statusCode).toBe(403)
  const res = await app.inject({
    method: 'POST',
    url: '/api/agent/v1/chat/completions',
    payload: { model: 'public-model' },
    headers: { authorization: `Bearer ${k.token}` },
    cookies: { coati_session: session.cookie },
  })
  expect(res.statusCode, res.body).toBe(200)
  expect(res.cookies).toHaveLength(0)
  expect((await invoke('invalid')).statusCode).toBe(401)
})
test.each([
  ['openai', '/v1/chat/completions', 10],
  ['anthropic', '/v1/messages', 12],
  ['responses', '/v1/responses', 10],
])(
  'streams %s natively and records actual usage',
  async (protocol, path, input) => {
    const k = await setup(protocol)
    const res = await invoke(
      k.token,
      { model: 'public-model', stream: true },
      path,
    )
    expect(res.statusCode, res.body).toBe(200)
    expect(res.body).toContain('你好')
    expect(res.headers['content-type']).toContain('text/event-stream')
    const row = (await service.repo.listRequests()).items[0]!
    expect(row).toMatchObject({
      status: 'ok',
      input_tokens: input,
      output_tokens: 3,
      usage_source: 'upstream',
      execution: {
        upstream_model: protocol,
        upstream_protocol: protocol,
        upstream_name: 'Fixture',
      },
    })
    expect((await service.repo.attempts(row.id))[0]!.execution).toEqual(
      row.execution,
    )
  },
)
test('rejects unauthorized models and revoked keys before upstream I/O', async () => {
  const k = await setup()
  expect((await invoke(k.token, { model: 'other' })).statusCode).toBe(403)
  await session.inject({
    method: 'DELETE',
    url: `/api/admin/gateway/keys/${k.id}`,
  })
  expect((await invoke(k.token)).statusCode).toBe(401)
  expect(calls).toBe(0)
})
test('quota reservation is atomic under concurrent requests', async () => {
  const k = await setup('openai', { daily_limit: 100, concurrency_limit: 20 })
  const repo = new GatewayRepository(handle.db)
  const result = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      repo.reserve(k.id, {
        id: `reservation-${i}`,
        model: 'public-model',
        protocol: 'openai',
        reserved_tokens: 60,
        expires_at: new Date(Date.now() + 60000).toISOString(),
      }),
    ),
  )
  expect(result.filter((x) => x === null)).toHaveLength(1)
  expect(result.filter((x) => x === 'quota_exceeded')).toHaveLength(7)
})
test('rejects requests that exceed quota before calling the upstream', async () => {
  const k = await setup('openai', { daily_limit: 1 })
  expect((await invoke(k.token)).statusCode).toBe(429)
  expect(calls).toBe(0)
})
test('preserves diagnostic upstream errors while redacting credentials', async () => {
  const k = await setup()
  behavior = 'failure'
  const res = await invoke(k.token)
  expect(res.statusCode).toBe(503)
  expect(res.body).toContain('upstream unavailable')
  expect(res.body).not.toContain('secret-test-key')
  expect((await service.repo.listRequests()).items[0]?.status).toBe(
    'upstream_error',
  )
})
test('truncated streams report an error and never fabricate success', async () => {
  const k = await setup()
  behavior = 'truncated'
  const res = await invoke(k.token, { model: 'public-model', stream: true })
  expect(res.body).toContain('stream_error')
  expect(res.body).not.toContain('[DONE]')
  expect((await service.repo.listRequests()).items[0]?.status).toBe(
    'stream_error',
  )
})
test('SSE parsing handles split unicode and split event delimiters', async () => {
  const encoded = Buffer.from(
    'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
  )
  const source = (async function* () {
    for (const byte of encoded) yield Buffer.from([byte])
  })()
  let result = ''
  for await (const event of nativeStream(
    source,
    'openai',
    'x',
    new UsageMeter(),
  ))
    result += event
  expect(result).toContain('你好')
  expect(result).toContain('[DONE]')
})
test('device grant can only be redeemed once, even under concurrent polls', async () => {
  const start = await app.inject({
      method: 'POST',
      url: '/api/agent/auth/device/start',
    }),
    codes = start.json()
  expect(start.statusCode).toBe(200)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/agent/auth/device/poll',
        payload: { device_code: codes.device_code },
      })
    ).json().error_code,
  ).toBe('authorization_pending')
  const confirmed = await session.inject({
    method: 'POST',
    url: '/api/admin/gateway/device/confirm',
    payload: { user_code: codes.user_code },
  })
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  const polls = await Promise.all(
    Array.from({ length: 3 }, () =>
      app.inject({
        method: 'POST',
        url: '/api/agent/auth/device/poll',
        payload: { device_code: codes.device_code },
      }),
    ),
  )
  expect(polls.filter((r) => r.statusCode === 200)).toHaveLength(1)
})
test('expired reservations release quota without inventing final usage', async () => {
  const k = await setup()
  await service.repo.reserve(k.id, {
    id: 'expired',
    model: 'public-model',
    protocol: 'openai',
    reserved_tokens: 50,
    expires_at: new Date(Date.now() - 10000).toISOString(),
  })
  expect(await service.repo.recoverExpired()).toHaveLength(1)
  expect(await service.repo.recoverExpired()).toHaveLength(0)
  expect((await service.repo.listRequests()).items[0]).toMatchObject({
    status: 'interrupted',
    input_tokens: 0,
    reserved_tokens: 50,
    usage_source: 'unknown',
  })
})

test('rejects malformed JSON and unsupported batch generation as client errors', async () => {
  const k = await setup()
  const malformed = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      authorization: `Bearer ${k.token}`,
      'content-type': 'application/json',
    },
    payload: '{',
  })
  expect(malformed.statusCode).toBe(400)
  expect(
    (await invoke(k.token, { model: 'public-model', n: 2 })).statusCode,
  ).toBe(400)
  expect(calls).toBe(0)
})
test('only retries explicit pre-stream rejections and records both attempts', async () => {
  const k = await setup()
  const original = (await service.repo.routes())[0]!
  await service.repo.saveRoute({ ...original, id: undefined, priority: 200 })
  behavior = 'fail-once'
  expect((await invoke(k.token)).statusCode).toBe(200)
  expect(calls).toBe(2)
  const request = (await service.repo.listRequests()).items[0]!
  expect(
    (await service.repo.attempts(request.id)).map((a) => a.status),
  ).toEqual([503, 200])
  const attempts = await service.repo.attempts(request.id)
  expect(attempts[0]!.execution).toMatchObject({
    route_id: original.id,
    upstream_model: 'openai',
  })
  expect(attempts[1]!.execution!.route_id).not.toBe(original.id)
  expect(request.execution).toEqual(attempts[1]!.execution)
})
test('disconnecting a real HTTP client aborts upstream work and releases its reservation', async () => {
  const k = await setup()
  behavior = 'slow'
  const port = (app.server.address() as { port: number }).port
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${k.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'public-model', stream: true }),
    signal: controller.signal,
  })
  const reader = response.body!.getReader()
  expect((await reader.read()).value?.length).toBeGreaterThan(0)
  controller.abort()
  await reader.cancel().catch(() => {})
  await vi.waitFor(async () =>
    expect((await service.repo.listRequests()).items[0]?.status).toBe(
      'client_error',
    ),
  )
  await vi.waitFor(() => expect(clientClosed).toBe(true))
})
test('idle stream timeout settles usage and does not fabricate completion', async () => {
  const k = await setup()
  behavior = 'slow'
  const short = new GatewayService(handle.db, {
    ...service.options,
    encryptionKey:
      process.env.GATEWAY_ENCRYPTION_KEY || 'dev-insecure-secret-key',
    idleTimeoutMs: 20,
  })
  // Use the already-configured upstream vault key from the test app, not development credentials.
  await short.repo.saveUpstream(
    {
      name: 'fixture',
      protocol: 'openai',
      base_url: base,
      secret: short.vault.encrypt('secret-test-key'),
    },
    1,
  )
  try {
    const result = await short.execute(
      await short.authenticate(k.token),
      { model: 'public-model', stream: true },
      'openai',
      new AbortController().signal,
    )
    let output = ''
    for await (const frame of result.stream!) output += frame
    expect(output).toContain('stream_error')
    expect(output).not.toContain('[DONE]')
    expect((await short.repo.listRequests()).items[0]?.status).toBe(
      'stream_error',
    )
  } finally {
    await short.transport.close()
  }
})
test('treats non-object upstream JSON as a 502 instead of successful usage', async () => {
  const k = await setup()
  behavior = 'invalid-json'
  expect((await invoke(k.token)).statusCode).toBe(502)
  expect((await service.repo.listRequests()).items[0]?.status).toBe(
    'upstream_error',
  )
})
test.each([
  '::ffff:7f00:1',
  '::ffff:192.168.1.1',
  '::127.0.0.1',
  'fd00::1',
  '198.18.0.1',
])('blocks private and mapped address %s', (address) =>
  expect(privateAddress(address)).toBe(true),
)
test('Responses requests explicitly disable upstream persistence', async () => {
  const k = await setup('responses')
  await invoke(k.token, { model: 'public-model' }, '/v1/responses')
  expect(observed.store).toBe(false)
  expect(
    (
      await invoke(
        k.token,
        { model: 'public-model', store: true, background:true, conversation:'fixture-conversation' },
        '/v1/responses',
      )
    ).statusCode,
  ).toBe(200)
  expect(observed.store).toBe(false)
  expect(observed.background).toBe(true)
  expect(observed.conversation).toBe('fixture-conversation')
  const strict = await app.inject({ method:'POST',url:'/v1/responses',headers:{authorization:`Bearer ${k.token}`,'x-coati-compatibility-policy':'strict'},payload:{model:'public-model',store:true} })
  expect(strict.statusCode).toBe(400)
})

test('withholds the successful terminal event if accounting persistence fails', async () => {
  const k = await setup()
  const accounting = new GatewayService(handle.db, {
    ...service.options,
    encryptionKey: 'accounting-fixture',
  })
  await accounting.repo.saveUpstream(
    {
      name: 'fixture',
      protocol: 'openai',
      base_url: base,
      secret: accounting.vault.encrypt('secret-test-key'),
    },
    1,
  )
  const persist = vi
    .spyOn(accounting.repo, 'finish')
    .mockRejectedValue(new Error('accounting unavailable'))
  try {
    const result = await accounting.execute(
      await accounting.authenticate(k.token),
      { model: 'public-model', stream: true },
      'openai',
      new AbortController().signal,
    )
    let body = ''
    for await (const frame of result.stream!) body += frame
    expect(body).toContain('settlement_failed')
    expect(body).not.toContain('[DONE]')
    expect((await service.repo.listRequests()).items[0]?.status).toBe(
      'reserved',
    )
  } finally {
    persist.mockRestore()
    await accounting.transport.close()
  }
})

for (const status of [401, 402, 403, 408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status} switches before response content, with one settlement`, async () => {
    const k = await setup()
    const original = (await service.repo.routes())[0]!
    const account = (await service.repo.upstreams())[0]!
    const second = await service.repo.saveUpstream({
      ...account,
      id: undefined,
      name: 'second account',
    })
    await service.repo.saveRoute({
      ...original,
      id: undefined,
      upstream_id: second!.id,
      priority: 200,
    })
    failureStatus = status
    behavior = 'fail-once'
    expect((await invoke(k.token)).statusCode).toBe(200)
    const rows = await service.repo.listRequests()
    expect(rows.total).toBe(1)
    expect(rows.items[0]).toMatchObject({
      status: 'ok',
      input_tokens: 10,
      output_tokens: 3,
    })
    expect(
      (await service.repo.attempts(rows.items[0]!.id)).map((a) => a.status),
    ).toEqual([status, 200])
  })
}
for (const status of [400, 404, 422]) {
  test(`ordinary HTTP ${status} does not switch candidates`, async () => {
    const k = await setup()
    const original = (await service.repo.routes())[0]!
    const account = (await service.repo.upstreams())[0]!
    const second = await service.repo.saveUpstream({
      ...account,
      id: undefined,
      name: 'second account',
    })
    await service.repo.saveRoute({
      ...original,
      id: undefined,
      upstream_id: second!.id,
      priority: 200,
    })
    failureStatus = status
    behavior = 'fail-once'
    expect((await invoke(k.token)).statusCode).toBe(status)
    expect(calls).toBe(1)
  })
}
test('explicit billing rejection switches and retry attempts remain bounded at three', async () => {
  const k = await setup()
  const original = (await service.repo.routes())[0]!
  for (let i = 0; i < 4; i++) {
    const account = (await service.repo.upstreams())[0]!
    const second = await service.repo.saveUpstream({
      ...account,
      id: undefined,
      name: 'fallback account',
    })
    await service.repo.saveRoute({
      ...original,
      upstream_id: second!.id,
      id: undefined,
      priority: 200 + i,
    })
  }
  failureStatus = 400
  failureBody = 'Insufficient balance'
  behavior = 'failure'
  expect((await invoke(k.token)).statusCode).toBe(400)
  expect(calls).toBe(3)
  const row = (await service.repo.listRequests()).items[0]!
  expect(row.status).toBe('upstream_error')
  expect(await service.repo.attempts(row.id)).toHaveLength(3)
})
test('a truncated stream never switches to a second candidate', async () => {
  const k = await setup()
  const original = (await service.repo.routes())[0]!
  await service.repo.saveRoute({ ...original, id: undefined, priority: 200 })
  behavior = 'truncated'
  const response = await invoke(k.token, {
    model: 'public-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  })
  expect(response.body).toContain('gateway_error')
  expect(calls).toBe(1)
})

test('health observations ignore late results and cooldown blocks subsequent selection', async () => {
  await setup()
  const row = (await service.repo.upstreams())[0]!
  const earlier = new Date(Date.now() - 1000).toISOString()
  const later = new Date().toISOString()
  await service.repo.recordHealthFailure(row.id, later, 'HTTP 401', true, false)
  expect(await service.repo.recordHealthSuccess(row.id, earlier)).toHaveLength(
    0,
  )
  expect(await service.repo.candidates('public-model')).toHaveLength(0)
  const health = (await service.repo.upstreams())[0]!
  expect(health.health_status).toBe('cooldown')
  expect(Date.parse(health.cooldown_until!) - Date.now()).toBeGreaterThan(
    1700000,
  )
  await handle.db.execute(
    sql`UPDATE gw_upstreams SET cooldown_until=now()-interval '1 second' WHERE id=${row.id}`,
  )
  expect(await service.repo.candidates('public-model')).toHaveLength(1)
  await service.repo.recordHealthSuccess(
    row.id,
    new Date(Date.now() + 1000).toISOString(),
  )
  expect(
    await service.repo.recordHealthFailure(
      row.id,
      earlier,
      'old failure',
      true,
      false,
    ),
  ).toHaveLength(0)
  expect((await service.repo.upstreams())[0]).toMatchObject({
    health_status: 'healthy',
    consecutive_failures: 0,
    cooldown_until: null,
    last_error: null,
  })
})
test('hard failures accumulate atomically; soft rate limits never hard-cool the account', async () => {
  await setup()
  const row = (await service.repo.upstreams())[0]!
  const time = new Date().toISOString()
  await Promise.all(
    Array.from({ length: 3 }, () =>
      service.repo.recordHealthFailure(
        row.id,
        time,
        'unavailable',
        false,
        false,
      ),
    ),
  )
  expect((await service.repo.upstreams())[0]).toMatchObject({
    health_status: 'cooldown',
    consecutive_failures: 3,
  })
  await service.repo.recordHealthSuccess(
    row.id,
    new Date(Date.now() + 1000).toISOString(),
  )
  await service.repo.recordHealthFailure(
    row.id,
    new Date(Date.now() + 2000).toISOString(),
    'rate limit',
    false,
    true,
  )
  expect((await service.repo.upstreams())[0]).toMatchObject({
    health_status: 'healthy',
    consecutive_failures: 0,
    cooldown_until: null,
    last_error: 'rate limit',
  })
})
test('HTTP fatal failure persists account cooldown for the next request', async () => {
  const k = await setup()
  failureStatus = 401
  behavior = 'failure'
  expect((await invoke(k.token)).statusCode).toBe(401)
  expect(calls).toBe(1)
  expect((await service.repo.upstreams())[0]!.health_status).toBe('cooldown')
  expect((await invoke(k.token)).statusCode).toBe(503)
  expect(calls).toBe(1)
})

test('revalidates candidates after quota reservation and before upstream I/O', async () => {
  const k = await setup()
  const original = GatewayRepository.prototype.reserve
  const spy = vi
    .spyOn(GatewayRepository.prototype, 'reserve')
    .mockImplementation(async function (this: GatewayRepository, ...args) {
      const result = await original.apply(this, args)
      await handle.db.execute(sql`UPDATE gw_upstreams SET enabled=false`)
      return result
    })
  try {
    expect((await invoke(k.token)).statusCode).toBe(503)
    expect(calls).toBe(0)
    expect((await service.repo.listRequests()).items[0]).toMatchObject({
      status: 'routing_error',
      input_tokens: 0,
      output_tokens: 0,
    })
  } finally {
    spy.mockRestore()
  }
})

test('account leases serialize competing requests across repository instances and recover expiry', async () => {
  const k = await setup()
  const route = (await service.repo.routes())[0]!
  await handle.db.execute(sql`UPDATE gw_upstreams SET concurrency_limit=1`)
  const requests = [
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
  ]
  for (const id of requests) {
    const key = await service.authenticate(k.token)
    await service.repo.reserve(key.id, {
      id,
      model: 'public-model',
      protocol: 'openai',
      reserved_tokens: 1,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    })
  }
  const other = new GatewayRepository(handle.db)
  const expires = new Date(Date.now() + 60000).toISOString()
  const results = await Promise.all([
    service.repo.acquireUpstream(
      route.id,
      'public-model',
      requests[0]!,
      expires,
    ),
    other.acquireUpstream(route.id, 'public-model', requests[1]!, expires),
  ])
  expect(results.filter(Boolean)).toHaveLength(1)
  await handle.db.execute(
    sql`UPDATE gw_upstream_leases SET expires_at=now()-interval '1 second'`,
  )
  const next = results[0] ? requests[1]! : requests[0]!
  expect(
    await other.acquireUpstream(route.id, 'public-model', next, expires),
  ).not.toBeNull()
  await other.releaseUpstream(next)
  await other.releaseUpstream(next)
  expect(
    (
      await handle.db.execute(
        sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
      )
    ).rows[0]!.n,
  ).toBe(0)
})

test('successful and failed requests release account leases', async () => {
  const k = await setup()
  expect((await invoke(k.token)).statusCode).toBe(200)
  expect(
    (
      await handle.db.execute(
        sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
      )
    ).rows[0]!.n,
  ).toBe(0)
  behavior = 'invalid-json'
  expect((await invoke(k.token)).statusCode).toBe(502)
  expect(
    (
      await handle.db.execute(
        sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
      )
    ).rows[0]!.n,
  ).toBe(0)
})

test('saturated routes do not consume the three upstream-send attempts', async () => {
  const k = await setup()
  const first = (await service.repo.routes())[0]!
  const account = (await service.repo.upstreams())[0]!
  await handle.db.execute(sql`UPDATE gw_upstreams SET concurrency_limit=1`)
  for (let priority = 101; priority < 103; priority++)
    await service.repo.saveRoute({ ...first, id: undefined, priority })
  const second = await service.repo.saveUpstream({
    ...account,
    id: undefined,
    name: 'available account',
  })
  await service.repo.saveRoute({
    ...first,
    id: undefined,
    priority: 200,
    upstream_id: second!.id,
  })
  const key = await service.authenticate(k.token)
  const heldId = '20000000-0000-4000-8000-000000000001'
  const expiry = new Date(Date.now() + 60000).toISOString()
  await service.repo.reserve(key.id, {
    id: heldId,
    model: 'public-model',
    protocol: 'openai',
    reserved_tokens: 1,
    expires_at: expiry,
  })
  await service.repo.acquireUpstream(first.id, 'public-model', heldId, expiry)
  try {
    expect((await invoke(k.token)).statusCode).toBe(200)
    expect(calls).toBe(1)
    const attempts = await handle.db.execute(
      sql`SELECT upstream_id FROM gw_attempts`,
    )
    expect(attempts.rows).toEqual([{ upstream_id: second!.id }])
  } finally {
    await service.repo.releaseUpstream(heldId)
  }
})

test('admin saves account concurrency limit without exposing credentials', async () => {
  await setup()
  const row = (await service.repo.upstreams())[0]!
  const updated = await session.inject({
    method: 'PUT',
    url: `/api/admin/gateway/upstreams/${row.id}`,
    payload: {
      name: row.name,
      protocol: row.protocol,
      base_url: row.base_url,
      enabled: true,
      concurrency_limit: 2,
      weight: 4,
    },
  })
  expect(updated.statusCode).toBe(200)
  expect(updated.json().concurrency_limit).toBe(2)
  expect(updated.json().weight).toBe(4)
  expect(updated.json().secret).toBeUndefined()
  expect((await service.repo.upstreams())[0]!.concurrency_limit).toBe(2)
})

test('explicit session binds persistently and rebinds after retryable failure', async () => {
  const k = await setup()
  const first = (await service.repo.routes())[0]!
  const account = (await service.repo.upstreams())[0]!
  const second = await service.repo.saveUpstream({
    ...account,
    id: undefined,
    name: 'fallback',
  })
  await service.repo.saveRoute({
    ...first,
    id: undefined,
    priority: 200,
    upstream_id: second!.id,
  })
  const call = () =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${k.token}`,
        'x-coati-session-id': 'session-fixture',
      },
      payload: { model: 'public-model' },
    })
  expect((await call()).statusCode).toBe(200)
  let bindings = await handle.db.execute(
    sql`SELECT upstream_id,scope FROM gw_session_bindings`,
  )
  expect(bindings.rows).toHaveLength(1)
  expect(bindings.rows[0]!.upstream_id).toBe(account.id)
  calls = 0
  behavior = 'fail-once'
  failureStatus = 401
  expect((await call()).statusCode).toBe(200)
  bindings = await handle.db.execute(
    sql`SELECT upstream_id,scope FROM gw_session_bindings`,
  )
  expect(bindings.rows).toHaveLength(1)
  expect(bindings.rows[0]!.upstream_id).toBe(second!.id)
  expect(String(bindings.rows[0]!.scope)).not.toContain('session-fixture')
  behavior = 'normal'
  expect((await call()).statusCode).toBe(200)
  expect(
    (await handle.db.execute(sql`SELECT upstream_id FROM gw_session_bindings`))
      .rows[0]!.upstream_id,
  ).toBe(second!.id)
})

test('first session writer wins across repositories; expired bindings can move', async () => {
  const k = await setup()
  const key = await service.authenticate(k.token)
  const route = (await service.repo.routes())[0]!
  const account = (await service.repo.upstreams())[0]!
  const second = await service.repo.saveUpstream({
    ...account,
    id: undefined,
    name: 'second',
  })
  const route2 = await service.repo.saveRoute({
    ...route,
    id: undefined,
    upstream_id: second!.id,
  })
  const ids = [
    '30000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000002',
  ]
  const expiry = new Date(Date.now() + 60000).toISOString()
  for (const id of ids)
    await service.repo.reserve(key.id, {
      id,
      model: 'public-model',
      protocol: 'openai',
      reserved_tokens: 1,
      expires_at: expiry,
    })
  const affinity = {
    scope: 'race-scope',
    owner: key.owner_id,
    eligible: [account.id, second!.id],
  }
  const other = new GatewayRepository(handle.db)
  const results = await Promise.all([
    service.repo.acquireUpstream(
      route.id,
      'public-model',
      ids[0]!,
      expiry,
      affinity,
    ),
    other.acquireUpstream(
      route2!.id,
      'public-model',
      ids[1]!,
      expiry,
      affinity,
    ),
  ])
  expect(results.filter(Boolean)).toHaveLength(1)
  const winner = results.find(Boolean)!
  expect((await service.repo.binding('race-scope'))!.upstream_id).toBe(
    winner.upstream.id,
  )
  for (const id of ids) await service.repo.releaseUpstream(id)
  await handle.db.execute(
    sql`UPDATE gw_session_bindings SET expires_at=now()-interval '1 second'`,
  )
  expect(await service.repo.binding('race-scope')).toBeUndefined()
  const alternate = winner.upstream.id === account.id ? route2! : route
  expect(
    await other.acquireUpstream(
      alternate.id,
      'public-model',
      ids[0]!,
      expiry,
      affinity,
    ),
  ).not.toBeNull()
  expect((await service.repo.binding('race-scope'))!.upstream_id).toBe(
    alternate.upstream_id,
  )
  await service.repo.invalidateBinding('race-scope', winner.upstream.id)
  expect((await service.repo.binding('race-scope'))!.upstream_id).toBe(
    alternate.upstream_id,
  )
  await other.releaseUpstream(ids[0]!)
  await handle.db.execute(
    sql`UPDATE gw_session_bindings SET expires_at=now()+interval '10 minutes'`,
  )
  await other.acquireUpstream(
    alternate.id,
    'public-model',
    ids[0]!,
    expiry,
    affinity,
  )
  const [renewed] = (
    await handle.db.execute(
      sql`SELECT expires_at > now()+interval '50 minutes' AS renewed FROM gw_session_bindings`,
    )
  ).rows
  expect(renewed!.renewed).toBe(true)
  await other.releaseUpstream(ids[0]!)
})

test('transient pre-response connection failure releases lease and rebinds session to fallback', async () => {
  const k = await setup()
  const route = (await service.repo.routes())[0]!
  const account = (await service.repo.upstreams())[0]!
  const second = await service.repo.saveUpstream({
    ...account,
    id: undefined,
    name: 'network fallback',
  })
  await service.repo.saveRoute({
    ...route,
    id: undefined,
    priority: 200,
    upstream_id: second!.id,
  })
  const call = () =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${k.token}`,
        'x-coati-session-id': 'network-session',
      },
      payload: { model: 'public-model' },
    })
  expect((await call()).statusCode).toBe(200)
  const original = GatewayTransport.prototype.send
  let sends = 0
  const spy = vi
    .spyOn(GatewayTransport.prototype, 'send')
    .mockImplementation(function (this: GatewayTransport, ...args) {
      sends++
      if (sends === 1)
        return Promise.reject(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error('connection reset'), {
              code: 'ECONNRESET',
            }),
          }),
        )
      return original.apply(this, args)
    })
  try {
    expect((await call()).statusCode).toBe(200)
    expect(sends).toBe(2)
    expect(
      (
        await handle.db.execute(
          sql`SELECT upstream_id FROM gw_session_bindings`,
        )
      ).rows[0]!.upstream_id,
    ).toBe(second!.id)
    expect(
      (
        await handle.db.execute(
          sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
        )
      ).rows[0]!.n,
    ).toBe(0)
  } finally {
    spy.mockRestore()
  }
})

test('local transport policy errors do not trigger fallback', async () => {
  const k = await setup()
  const route = (await service.repo.routes())[0]!
  await service.repo.saveRoute({ ...route, id: undefined, priority: 200 })
  const spy = vi
    .spyOn(GatewayTransport.prototype, 'send')
    .mockRejectedValue(new Error('Private upstream address is not allowed'))
  try {
    expect((await invoke(k.token)).statusCode).toBe(502)
    expect(spy).toHaveBeenCalledTimes(1)
    expect((await service.repo.upstreams())[0]!.consecutive_failures).toBe(0)
    expect(
      (
        await handle.db.execute(
          sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
        )
      ).rows[0]!.n,
    ).toBe(0)
  } finally {
    spy.mockRestore()
  }
})

test('client cancellation during connection failure never retries', async () => {
  const k = await setup()
  const route = (await service.repo.routes())[0]!
  const account = (await service.repo.upstreams())[0]!
  await service.repo.saveUpstream(
    { ...account, secret: service.vault.encrypt('test-key') },
    account.id,
  )
  await service.repo.saveRoute({ ...route, id: undefined, priority: 200 })
  const key = await service.authenticate(k.token)
  const controller = new AbortController()
  const spy = vi.spyOn(service.transport, 'send').mockImplementation(() => {
    controller.abort()
    return Promise.reject(
      Object.assign(new Error('reset after cancellation'), {
        code: 'ECONNRESET',
      }),
    )
  })
  try {
    await expect(
      service.execute(
        key,
        { model: 'public-model' },
        'openai',
        controller.signal,
      ),
    ).rejects.toMatchObject({ status: 504 })
    expect(spy).toHaveBeenCalledTimes(1)
    expect((await service.repo.listRequests()).items[0]!.status).toBe(
      'client_error',
    )
    expect((await service.repo.upstreams())[0]!.consecutive_failures).toBe(0)
    expect(
      (
        await handle.db.execute(
          sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
        )
      ).rows[0]!.n,
    ).toBe(0)
  } finally {
    spy.mockRestore()
  }
})

test('new explicit sessions distribute across the shared model pool and existing sessions stay bound', async () => {
  const k = await setup()
  const route = (await service.repo.routes())[0]!
  const account = (await service.repo.upstreams())[0]!
  const second = await service.repo.saveUpstream({
    ...account,
    id: undefined,
    name: 'balanced account',
  })
  await service.repo.saveRoute({
    ...route,
    id: undefined,
    upstream_id: second!.id,
  })
  const call = (session: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${k.token}`,
        'x-coati-session-id': session,
      },
      payload: { model: 'public-model' },
    })
  for (let i = 0; i < 4; i++)
    expect((await call(`balanced-${i}`)).statusCode).toBe(200)
  const load = await service.repo.poolLoad('pool:public-model:openai')
  expect(load.bindings).toEqual({ [account.id]: 2, [second!.id]: 2 })
  // Recency is independent of TTL; excluded accounts cannot bias the last-account tie break.
  await handle.db.execute(sql`UPDATE gw_session_bindings SET
    updated_at = now() - interval '2 minutes', expires_at = now() + interval '2 hours'
    WHERE upstream_id = ${account.id}`)
  await handle.db.execute(sql`UPDATE gw_session_bindings SET
    updated_at = now() - interval '1 minute', expires_at = now() + interval '10 minutes'
    WHERE upstream_id = ${second!.id}`)
  expect((await service.repo.poolLoad('pool:public-model:openai')).last).toBe(second!.id)
  const eligible = await service.repo.poolLoad('pool:public-model:openai', [account.id])
  expect(eligible.bindings).toEqual({ [account.id]: 2 })
  expect(eligible.last).toBe(account.id)
  expect((await service.repo.poolLoad('pool:public-model:openai', [])).last).toBeNull()
  await handle.db.execute(sql`UPDATE gw_session_bindings SET updated_at = now()`)
  const latest = await handle.db.execute(sql`SELECT upstream_id FROM gw_session_bindings ORDER BY id DESC LIMIT 1`)
  expect((await service.repo.poolLoad('pool:public-model:openai')).last).toBe(latest.rows[0]!.upstream_id)

  expect((await call('balanced-0')).statusCode).toBe(200)
  expect((await service.repo.poolLoad('pool:public-model:openai')).bindings).toEqual(
    load.bindings,
  )
})

for (const [field, limit, denial] of [
  ['concurrency_limit', 1, 'user_concurrency_limit'],
  ['daily_limit', 60, 'user_quota_exceeded'],
  ['rpm_limit', 1, 'user_rate_limit'],
] as const) {
  test(`multiple keys cannot race past shared user ${field}`, async () => {
    const first = await setup()
    const key = await service.authenticate(first.token)
    const second = await service.createKey(key.owner_id, {
      name: 'second key',
      models: ['public-model'],
    })
    const saved = await session.inject({
      method: 'PUT',
      url: `/api/admin/gateway/user-limits/${key.owner_id}`,
      payload: {
        daily_limit: 0,
        concurrency_limit: 0,
        rpm_limit: 0,
        [field]: limit,
      },
    })
    expect(saved.statusCode).toBe(200)
    const values = (id: string) => ({
      id,
      model: 'public-model',
      protocol: 'openai',
      reserved_tokens: 40,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    })
    const other = new GatewayRepository(handle.db)
    const results = await Promise.all([
      service.repo.reserve(
        key.id,
        values('40000000-0000-4000-8000-000000000001'),
      ),
      other.reserve(second.id, values('40000000-0000-4000-8000-000000000002')),
    ])
    expect(results.filter((value) => value === null)).toHaveLength(1)
    expect(results).toContain(denial)
    expect((await service.repo.listRequests()).total).toBe(1)
  })
}
test('shared quota uses settled actual totals and cannot be changed with a gateway bearer key', async () => {
  const first = await setup()
  const key = await service.authenticate(first.token)
  const second = await service.createKey(key.owner_id, {
    name: 'second',
    models: ['public-model'],
  })
  await service.saveUserLimits(key.owner_id, {
    daily_limit: 60,
    concurrency_limit: 0,
    rpm_limit: 0,
  })
  const a = '50000000-0000-4000-8000-000000000001',
    b = '50000000-0000-4000-8000-000000000002'
  const values = (id: string) => ({
    id,
    model: 'public-model',
    protocol: 'openai',
    reserved_tokens: 40,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  })
  expect(await service.repo.reserve(key.id, values(a))).toBeNull()
  await service.repo.finish(a, {
    status: 'ok',
    input_tokens: 10,
    output_tokens: 3,
    usage_source: 'upstream',
  })
  expect(await service.repo.reserve(second.id, values(b))).toBeNull()
  const denied = await app.inject({
    method: 'PUT',
    url: `/api/admin/gateway/user-limits/${key.owner_id}`,
    headers: { authorization: `Bearer ${first.token}` },
    payload: { daily_limit: 0, concurrency_limit: 0, rpm_limit: 0 },
  })
  expect([401, 403]).toContain(denied.statusCode)
  expect((await service.userLimits(key.owner_id)).daily_limit).toBe(60)
})

class MidnightQuotaRepository extends GatewayRepository {
  protected override quotaClock() {
    return sql`'2030-01-02T00:00:10Z'::timestamptz`
  }
}
for (const scope of ['key', 'user'] as const) {
  test(`${scope} rolling RPM includes completed requests before UTC midnight`, async () => {
    const first = await setup('openai', scope === 'key' ? { rpm_limit: 1 } : {})
    const key = await service.authenticate(first.token)
    if (scope === 'user')
      await service.saveUserLimits(key.owner_id, {
        daily_limit: 0,
        concurrency_limit: 0,
        rpm_limit: 1,
      })
    const repo = new MidnightQuotaRepository(handle.db, 'UTC')
    const previous = '60000000-0000-4000-8000-000000000001'
    await handle.db.execute(sql`INSERT INTO gw_requests
      (id,key_id,model,protocol,status,reserved_tokens,input_tokens,output_tokens,created_at,expires_at)
      VALUES (${previous},${key.id},'public-model','openai','ok',0,100,10,'2030-01-01T23:59:30Z','2030-01-02T00:01:00Z')`)
    const values = {
      id: '60000000-0000-4000-8000-000000000002',
      model: 'public-model',
      protocol: 'openai',
      reserved_tokens: 1,
      expires_at: '2030-01-02T00:01:00Z',
    }
    expect(await repo.reserve(key.id, values)).toBe(
      scope === 'key' ? 'rate_limit' : 'user_rate_limit',
    )
    await handle.db.execute(
      sql`UPDATE gw_requests SET created_at='2030-01-01T23:59:10Z' WHERE id=${previous}`,
    )
    expect(await repo.reserve(key.id, values)).toBeNull()
  })
  test(`${scope} new-day quota excludes yesterday's usage and reservations like Python`, async () => {
    const first = await setup(
      'openai',
      scope === 'key' ? { daily_limit: 60 } : {},
    )
    const key = await service.authenticate(first.token)
    if (scope === 'user')
      await service.saveUserLimits(key.owner_id, {
        daily_limit: 60,
        concurrency_limit: 0,
        rpm_limit: 0,
      })
    const repo = new MidnightQuotaRepository(handle.db, 'UTC')
    const previous = '70000000-0000-4000-8000-000000000001'
    await handle.db.execute(sql`INSERT INTO gw_requests
      (id,key_id,model,protocol,status,reserved_tokens,input_tokens,output_tokens,created_at,expires_at)
      VALUES (${previous},${key.id},'public-model','openai','reserved',40,0,0,'2030-01-01T23:59:30Z','2030-01-02T00:01:00Z')`)
    const values = {
      id: '70000000-0000-4000-8000-000000000002',
      model: 'public-model',
      protocol: 'openai',
      reserved_tokens: 30,
      created_at: '2030-01-02T00:00:10Z',
      expires_at: '2030-01-02T00:01:00Z',
    }
    expect(await repo.reserve(key.id, values)).toBeNull()
    await repo.finish(previous, {
      status: 'ok',
      input_tokens: 100,
      output_tokens: 10,
    })
    // Yesterday's completion remains outside today's budget; the new reservation counts.
    expect(
      await repo.reserve(key.id, {
        ...values,
        id: '70000000-0000-4000-8000-000000000003',
        reserved_tokens: 31,
      }),
    ).toBe(scope === 'key' ? 'quota_exceeded' : 'user_quota_exceeded')
  })
}

for (const protocol of ['openai', 'responses', 'anthropic']) {
  test(`manual ${protocol} discovery preserves protocol-specific recovery semantics`, async () => {
    await setup(protocol)
    const row = (await service.repo.upstreams())[0]!
    await service.repo.recordHealthFailure(
      row.id,
      new Date(Date.now() - 10000).toISOString(),
      'fatal',
      true,
      false,
    )
    const result = await session.inject({
      method: 'POST',
      url: `/api/admin/gateway/upstreams/${row.id}/probe`,
    })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().models).toEqual(['fixture-a', 'fixture-b'])
    expect(result.json().verified).toBe(protocol !== 'anthropic')
    expect(result.json().health_updated).toBe(protocol !== 'anthropic')
    expect(result.body).not.toContain('secret-test-key')
    expect(observed.authorization).toBe('Bearer secret-test-key')
    expect(observed['x-api-key']).toBe('secret-test-key')
    expect((await service.repo.upstreams())[0]!.health_status).toBe(
      protocol === 'anthropic' ? 'cooldown' : 'healthy',
    )
  })
}
for (const behaviorName of [
  'discovery-unsupported',
  'discovery-html',
  'discovery-failure',
]) {
  test(`${behaviorName} never clears cooldown or extends hard punishment`, async () => {
    const key = await setup()
    const row = (await service.repo.upstreams())[0]!
    await service.repo.recordHealthFailure(
      row.id,
      new Date(Date.now() - 10000).toISOString(),
      'fatal',
      true,
      false,
    )
    const before = (await service.repo.upstreams())[0]!
    behavior = behaviorName
    const result = await session.inject({
      method: 'POST',
      url: `/api/admin/gateway/upstreams/${row.id}/probe`,
    })
    expect(result.statusCode).toBe(
      behaviorName === 'discovery-failure' ? 502 : 200,
    )
    if (result.statusCode === 200) expect(result.json().verified).toBe(false)
    expect(result.body).not.toContain('secret-test-key')
    const after = (await service.repo.upstreams())[0]!
    expect(after.cooldown_until).toBe(before.cooldown_until)
    expect(after.consecutive_failures).toBe(before.consecutive_failures)
    const denied = await app.inject({
      method: 'POST',
      url: `/api/admin/gateway/upstreams/${row.id}/probe`,
      headers: { authorization: `Bearer ${key.token}` },
    })
    expect([401, 403]).toContain(denied.statusCode)
  })
}
test('probe health cannot overwrite an edited credential snapshot', async () => {
  await setup()
  const row = (await service.repo.upstreams())[0]!
  await service.repo.saveUpstream(
    { ...row, secret: service.vault.encrypt('replacement') },
    row.id,
  )
  const at = new Date().toISOString()
  expect(await service.repo.recordHealthSuccess(row.id, at, row)).toEqual([])
  expect(
    await service.repo.recordHealthFailure(
      row.id,
      at,
      'stale',
      false,
      true,
      row,
    ),
  ).toEqual([])
  expect((await service.repo.upstreams())[0]!.health_status).toBe('unknown')
})

test('database probe claims exclude concurrent replicas and fence expired owners', async () => {
  await setup()
  const id = (await service.repo.upstreams())[0]!.id
  const other = new GatewayRepository(handle.db)
  const claims = await Promise.all([
    service.repo.claimProbe(id),
    other.claimProbe(id),
  ])
  expect(claims.filter(Boolean)).toHaveLength(1)
  const old = claims.find(Boolean)!
  await handle.db.execute(
    sql`UPDATE gw_upstreams SET probe_expires_at=now()-interval '1 second' WHERE id=${id}`,
  )
  const current = (await other.claimProbe(id))!
  expect(current.probe_token).not.toBe(old.probe_token)
  expect(await service.repo.completeProbe(old, true, 10)).toBe(false)
  expect((await service.repo.upstreams())[0]!.probe_token).toBe(
    current.probe_token,
  )
  expect(await other.completeProbe(current, true, 11)).toBe(true)
  const saved = (await service.repo.upstreams())[0]!
  expect(saved.probe_token).toBeNull()
  expect(saved.last_probe_status).toBe('verified')
  expect(saved.last_probe_latency_ms).toBe(11)
})
test('recovery batches respect durable quiet windows across service instances', async () => {
  await setup('anthropic')
  const account = (await service.repo.upstreams())[0]!
  await service.repo.saveUpstream(
    { ...account, secret: service.vault.encrypt('secret-test-key') },
    account.id,
  )
  const other = new GatewayService(handle.db, service.options)
  try {
    const results = await Promise.all([
      runProbeBatch(service),
      runProbeBatch(other),
    ])
    expect(results.flat()).toHaveLength(1)
    expect(calls).toBe(1)
    expect(await runProbeBatch(other)).toEqual([])
    await handle.db.execute(
      sql`UPDATE gw_upstreams SET last_probe_at=now()-interval '11 minutes'`,
    )
    expect(await runProbeBatch(other)).toEqual([])
    await handle.db.execute(sql`UPDATE gw_upstreams SET last_checked_at=now()-interval '11 minutes'`)
    expect(await runProbeBatch(other)).toHaveLength(1)
    expect(calls).toBe(2)
    expect((await service.repo.upstreams())[0]!.last_probe_status).toBe(
      'unverified',
    )
  } finally {
    await other.transport.close()
  }
})
test('probe completion preserves newer traffic failures and marks edited snapshots stale', async () => {
  await setup()
  const id = (await service.repo.upstreams())[0]!.id
  const claim = (await service.repo.claimProbe(id))!
  await service.repo.recordHealthFailure(
    id,
    new Date(Date.parse(claim.last_probe_at!) + 1000).toISOString(),
    'newer failure',
    true,
    false,
  )
  expect(await service.repo.completeProbe(claim, true, 1)).toBe(false)
  expect((await service.repo.upstreams())[0]!.health_status).toBe('cooldown')
  const another = (await service.repo.claimProbe(id))!
  await service.repo.saveUpstream(
    { ...another, base_url: base + '/changed' },
    id,
  )
  expect(await service.repo.completeProbe(another, true, 2)).toBe(false)
  expect((await service.repo.upstreams())[0]!.last_probe_status).toBe('stale')
})

test('personal key editing preserves credential and quotas while changing name and expiry', async () => {
  const first = await setup('openai', { daily_limit: 500, rpm_limit: 12 })
  const key = await service.authenticate(first.token)
  const result = await session.inject({
    method: 'PUT',
    url: `/api/admin/gateway/keys/${key.id}`,
    payload: { name: 'renamed', expires_days: 3650 },
  })
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json().name).toBe('renamed')
  expect(result.json().daily_limit).toBe(500)
  expect(result.json().rpm_limit).toBe(12)
  expect(result.json().digest).toBeUndefined()
  expect(result.json().token).toBeUndefined()
  expect(Date.parse(result.json().expires_at)).toBeGreaterThan(
    Date.now() + 3649 * 86400000,
  )
  expect((await service.authenticate(first.token)).id).toBe(key.id)
  const unlimited = await session.inject({
    method: 'PUT',
    url: `/api/admin/gateway/keys/${key.id}`,
    payload: { name: 'no expiry' },
  })
  expect(unlimited.statusCode).toBe(200)
  expect(unlimited.json().expires_at).toBeNull()
  expect((await service.authenticate(first.token)).expires_at).toBeNull()
})
for (const state of ['revoked', 'expired', 'device'] as const) {
  test(`editing cannot revive or change a ${state} key`, async () => {
    const first = await setup()
    if (state === 'revoked') await service.repo.revoke(first.id, first.owner_id)
    if (state === 'expired')
      await handle.db.execute(
        sql`UPDATE gw_keys SET expires_at=now()-interval '1 day' WHERE id=${first.id}`,
      )
    if (state === 'device')
      await handle.db.execute(
        sql`UPDATE gw_keys SET kind='device' WHERE id=${first.id}`,
      )
    const result = await session.inject({
      method: 'PUT',
      url: `/api/admin/gateway/keys/${first.id}`,
      payload: { name: 'should not apply', expires_days: 30 },
    })
    expect(result.statusCode).toBe(409)
    expect((await service.repo.keys())[0]!.name).toBe('fixture')
  })
}
test('key editing enforces owner scope and rejects privilege fields and bearer administration', async () => {
  const first = await setup()
  await expect(
    service.updateKey(first.owner_id + 10000, first.id, { name: 'other' }),
  ).rejects.toMatchObject({ status: 404 })
  const extra = await session.inject({
    method: 'PUT',
    url: `/api/admin/gateway/keys/${first.id}`,
    payload: { name: 'bad', models: ['*'], daily_limit: 0 },
  })
  expect([400, 422]).toContain(extra.statusCode)
  const denied = await app.inject({
    method: 'PUT',
    url: `/api/admin/gateway/keys/${first.id}`,
    headers: { authorization: `Bearer ${first.token}` },
    payload: { name: 'bad' },
  })
  expect([401, 403]).toContain(denied.statusCode)
  expect((await service.repo.keys())[0]!.models).toEqual(['public-model'])
})

test('rotation replaces the record atomically, preserves policy and immediately rejects the old bearer', async () => {
  const first = await setup('openai', { daily_limit: 900, rpm_limit: 4 })
  const old = await service.authenticate(first.token)
  const result = await session.inject({
    method: 'POST',
    url: `/api/admin/gateway/keys/${old.id}/rotate`,
  })
  expect(result.statusCode, result.body).toBe(201)
  const next = result.json()
  expect(next.id).not.toBe(old.id)
  expect(next.rotated_from_id).toBe(old.id)
  expect(next.quota_group).toBe(old.quota_group)
  expect(next.expires_at).toBe(old.expires_at)
  expect(next.models).toEqual(old.models)
  expect(next.daily_limit).toBe(900)
  expect(next.rpm_limit).toBe(4)
  expect(next.digest).toBeUndefined()
  await expect(service.authenticate(first.token)).rejects.toMatchObject({
    status: 401,
  })
  expect((await service.authenticate(next.token)).id).toBe(next.id)
  const listed = await service.keys(old.owner_id)
  expect(listed.find((item) => item.id === old.id)!.revoked).toBe(true)
  expect(JSON.stringify(listed)).not.toContain(next.token)
})
test('competing rotations produce only one replacement and cannot rotate another owner key', async () => {
  const first = await setup()
  const results = await Promise.allSettled([
    service.rotateKey(first.owner_id, first.id),
    service.rotateKey(first.owner_id, first.id),
  ])
  expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(
    1,
  )
  expect(
    (await service.repo.keys()).filter((value) => !value.revoked),
  ).toHaveLength(1)
  const active = (await service.repo.keys()).find((value) => !value.revoked)!
  await expect(
    service.rotateKey(active.owner_id + 10000, active.id),
  ).rejects.toMatchObject({ status: 404 })
  await handle.db.execute(
    sql`UPDATE gw_keys SET expires_at=now()-interval '1 second' WHERE id=${active.id}`,
  )
  await expect(
    service.rotateKey(active.owner_id, active.id),
  ).rejects.toMatchObject({ status: 409 })
})
for (const [field, limit, denied] of [
  ['daily_limit', 60, 'quota_exceeded'],
  ['concurrency_limit', 1, 'concurrency_limit'],
  ['rpm_limit', 1, 'rate_limit'],
] as const) {
  test(`rotation cannot reset ${field} including old in-flight reservations`, async () => {
    const first = await setup('openai', { [field]: limit })
    const values = {
      id: '80000000-0000-4000-8000-000000000001',
      model: 'public-model',
      protocol: 'openai',
      reserved_tokens: 40,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    }
    expect(await service.repo.reserve(first.id, values)).toBeNull()
    const next = await service.rotateKey(first.owner_id, first.id)
    expect(
      await service.repo.reserve(next.id, {
        ...values,
        id: '80000000-0000-4000-8000-000000000002',
      }),
    ).toBe(denied)
    expect(
      await service.repo.reserve(first.id, {
        ...values,
        id: '80000000-0000-4000-8000-000000000003',
      }),
    ).toBe('unauthorized')
    await service.repo.finish(values.id, {
      status: 'ok',
      input_tokens: 5,
      output_tokens: 5,
    })
    if (field !== 'rpm_limit')
      expect(
        await service.repo.reserve(next.id, {
          ...values,
          id: '80000000-0000-4000-8000-000000000004',
        }),
      ).toBeNull()
    else
      expect(
        await service.repo.reserve(next.id, {
          ...values,
          id: '80000000-0000-4000-8000-000000000004',
        }),
      ).toBe('rate_limit')
  })
}
test('repeated rotations retain settled history and distinct keys keep independent key budgets', async () => {
  const first = await setup('openai', { daily_limit: 60 })
  const values = {
    id: '90000000-0000-4000-8000-000000000001',
    model: 'public-model',
    protocol: 'openai',
    reserved_tokens: 40,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  }
  expect(await service.repo.reserve(first.id, values)).toBeNull()
  await service.repo.finish(values.id, {
    status: 'ok',
    input_tokens: 30,
    output_tokens: 10,
  })
  const second = await service.rotateKey(first.owner_id, first.id)
  const third = await service.rotateKey(first.owner_id, second.id)
  expect(third.quota_group).toBe(first.quota_group)
  expect(third.rotated_from_id).toBe(second.id)
  expect(
    await service.repo.reserve(third.id, {
      ...values,
      id: '90000000-0000-4000-8000-000000000002',
    }),
  ).toBe('quota_exceeded')
  const unrelated = await service.createKey(first.owner_id, {
    name: 'unrelated',
    models: ['public-model'],
    daily_limit: 60,
  })
  expect(unrelated.quota_group).not.toBe(third.quota_group)
  expect(
    await service.repo.reserve(unrelated.id, {
      ...values,
      id: '90000000-0000-4000-8000-000000000003',
    }),
  ).toBeNull()
})

test('failed rotation insertion leaves the existing token active', async () => {
  const first = await setup()
  const old = await service.authenticate(first.token)
  await expect(
    service.repo.rotateKey(old.id, old.owner_id, {
      digest: old.digest,
      prefix: old.prefix,
    }),
  ).rejects.toThrow()
  expect((await service.authenticate(first.token)).id).toBe(old.id)
  expect(await service.repo.keys(old.owner_id)).toHaveLength(1)
})

test('profile-only keys cannot invoke any model protocol or discover models', async () => {
  const first = await setup('openai', { scopes: ['profile'] })
  for (const path of [
    '/api/agent/v1/chat/completions',
    '/api/agent/v1/messages',
    '/api/agent/v1/responses',
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: { authorization: `Bearer ${first.token}` },
      payload: {
        model: 'public-model',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })
    expect(response.statusCode, response.body).toBe(403)
    expect(response.body).toContain('insufficient_scope')
  }
  const models = await app.inject({
    method: 'GET',
    url: '/api/agent/v1/models',
    headers: { authorization: `Bearer ${first.token}` },
  })
  expect(models.statusCode).toBe(403)
  expect(calls).toBe(0)
  expect((await service.repo.listRequests()).total).toBe(0)
})
test('scope survives rotation without granting chat and editing rejects scope escalation', async () => {
  const first = await setup('openai', { scopes: ['profile'] })
  const next = await service.rotateKey(first.owner_id, first.id)
  expect(next.scopes).toEqual(['profile'])
  await expect(
    service.models(await service.authenticate(next.token)),
  ).rejects.toMatchObject({ status: 403 })
  const edit = await session.inject({
    method: 'PUT',
    url: `/api/admin/gateway/keys/${next.id}`,
    payload: { name: 'escalate', scopes: ['chat', 'profile'] },
  })
  expect([400, 422]).toContain(edit.statusCode)
})
test('admission rechecks saved scopes and models instead of trusting an earlier authentication snapshot', async () => {
  const first = await setup()
  const snapshot = await service.authenticate(first.token)
  const values = {
    id: 'a0000000-0000-4000-8000-000000000001',
    model: 'public-model',
    protocol: 'openai',
    reserved_tokens: 10,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  }
  await handle.db.execute(
    sql`UPDATE gw_keys SET scopes='["profile"]'::jsonb WHERE id=${snapshot.id}`,
  )
  expect(await service.repo.reserve(snapshot.id, values)).toBe(
    'insufficient_scope',
  )
  await handle.db.execute(
    sql`UPDATE gw_keys SET scopes='["chat"]'::jsonb,models='["different-model"]'::jsonb WHERE id=${snapshot.id}`,
  )
  expect(await service.repo.reserve(snapshot.id, values)).toBe(
    'model_not_allowed',
  )
  expect((await service.repo.listRequests()).total).toBe(0)
})

class BusinessDayRepository extends GatewayRepository {
  constructor(
    db: GatewayRepository['db'],
    zone: string,
    private readonly instant: string,
  ) {
    super(db, zone)
  }
  protected override quotaClock() {
    return sql`${this.instant}::timestamptz`
  }
}
for (const [zone, now, previous] of [
  ['Asia/Shanghai', '2026-09-25T16:00:10Z', '2026-09-25T15:59:50Z'],
  ['America/New_York', '2026-03-08T07:30:00Z', '2026-03-08T04:59:50Z'],
]) {
  for (const scope of ['key', 'user']) {
    test(`${scope} daily quota follows ${zone} midnight including DST`, async () => {
      const first = await setup(
        'openai',
        scope === 'key' ? { daily_limit: 60 } : {},
      )
      if (scope === 'user')
        await service.saveUserLimits(first.owner_id, {
          daily_limit: 60,
          concurrency_limit: 0,
          rpm_limit: 0,
        })
      const repo = new BusinessDayRepository(handle.db, zone!, now!)
      await handle.db
        .execute(sql`INSERT INTO gw_requests (id,key_id,model,protocol,status,reserved_tokens,input_tokens,created_at,expires_at)
        VALUES ('b0000000-0000-4000-8000-000000000001',${first.id},'public-model','openai','ok',0,100,${previous}::timestamptz,now())`)
      const values = {
        id: 'b0000000-0000-4000-8000-000000000002',
        model: 'public-model',
        protocol: 'openai',
        reserved_tokens: 30,
        expires_at: new Date(Date.now() + 60000).toISOString(),
      }
      expect(await repo.reserve(first.id, values)).toBeNull()
      expect(
        await repo.reserve(first.id, {
          ...values,
          id: 'b0000000-0000-4000-8000-000000000003',
          reserved_tokens: 31,
        }),
      ).toBe(scope === 'key' ? 'quota_exceeded' : 'user_quota_exceeded')
    })
  }
}

test('default user quota applies until overridden and null restores inheritance', async () => {
  const first = await setup()
  const repo = new GatewayRepository(handle.db, 'UTC', 60)
  const values = {
    id: 'c0000000-0000-4000-8000-000000000001',
    model: 'public-model',
    protocol: 'openai',
    reserved_tokens: 40,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  }
  expect((await repo.quotaSummary(first.owner_id))!.quota_source).toBe(
    'default',
  )
  expect(await repo.reserve(first.id, values)).toBeNull()
  expect(
    await repo.reserve(first.id, {
      ...values,
      id: 'c0000000-0000-4000-8000-000000000002',
    }),
  ).toBe('user_quota_exceeded')
  await repo.saveUserLimits(first.owner_id, {
    daily_limit: 0,
    concurrency_limit: 0,
    rpm_limit: 0,
  })
  expect(await repo.quotaSummary(first.owner_id)).toMatchObject({
    daily_quota: null,
    quota_override: 0,
    quota_source: 'user',
    remaining: null,
  })
  expect(
    await repo.reserve(first.id, {
      ...values,
      id: 'c0000000-0000-4000-8000-000000000002',
    }),
  ).toBeNull()
  await repo.saveUserLimits(first.owner_id, {
    daily_limit: null,
    concurrency_limit: 0,
    rpm_limit: 0,
  })
  expect(
    await repo.reserve(first.id, {
      ...values,
      id: 'c0000000-0000-4000-8000-000000000003',
    }),
  ).toBe('user_quota_exceeded')
  await repo.finish(values.id, {
    status: 'ok',
    input_tokens: 5,
    output_tokens: 5,
  })
  expect(await repo.quotaSummary(first.owner_id)).toMatchObject({
    daily_quota: 60,
    quota_override: null,
    used_today: 10,
    remaining: 50,
    usage_percent: 16.7,
    exhausted: false,
  })
})
test('legacy me returns safe owner profile and quota, requires profile scope', async () => {
  const first = await setup('openai', { scopes: ['profile'] })
  await service.saveUserLimits(first.owner_id, {
    daily_limit: 100,
    concurrency_limit: 0,
    rpm_limit: 0,
  })
  const result = await app.inject({
    method: 'GET',
    url: '/api/agent/me',
    headers: { authorization: `Bearer ${first.token}` },
  })
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json().user.id).toBe(first.owner_id)
  expect(result.json().user.roles).toBeInstanceOf(Array)
  expect(result.json().user.menu_codes).toBeInstanceOf(Array)
  expect(result.json().user.password_hash).toBeUndefined()
  expect(result.json().quota).toEqual({
    daily_quota: 100,
    quota_override: 100,
    quota_source: 'user',
    used_today: 0,
    remaining: 100,
    usage_percent: 0,
    exhausted: false,
  })
  const chat = await service.createKey(first.owner_id, {
    name: 'chat only',
    models: ['public-model'],
    scopes: ['chat'],
  })
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/agent/me',
        headers: { authorization: `Bearer ${chat.token}` },
      })
    ).statusCode,
  ).toBe(403)
  expect(
    (await app.inject({ method: 'GET', url: '/api/agent/me' })).statusCode,
  ).toBe(401)
})
test('legacy me preserves authentication header aliases and legacy error shape', async () => {
  const first = await setup('openai', { scopes: ['chat'] })
  expect(
    (await app.inject({ method: 'GET', url: '/api/agent/me' })).json(),
  ).toEqual({ error: '缺少 API Key' })
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/agent/me',
        headers: { 'api-key': 'invalid' },
      })
    ).json(),
  ).toEqual({ error: '未授权' })
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/agent/me',
        headers: { 'api-key': first.token },
      })
    ).json(),
  ).toEqual({ error: '令牌权限不足', required_scope: 'profile' })
  const second = await service.createKey(first.owner_id, {
    name: 'profile',
    models: ['public-model'],
    scopes: ['profile'],
  })
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/agent/me',
        headers: { 'api-key': second.token },
      })
    ).statusCode,
  ).toBe(200)
})

test('legacy PAT CRUD preserves wire fields, notes, no-expiry defaults and rotation history', async () => {
  const created = await session.inject({
    method: 'POST',
    url: '/api/agent/auth/pat',
    payload: {
      name: 'legacy',
      note: 'searchable memo',
      scopes: ['profile', 'chat', 'profile'],
    },
  })
  expect(created.statusCode, created.body).toBe(201)
  const pat = created.json()
  expect(pat).toMatchObject({
    name: 'legacy',
    token_type: 'personal',
    note: 'searchable memo',
    scopes: ['profile', 'chat'],
    status: 'active',
    expires_at: null,
    expires_in_days: null,
    revoked_at: null,
    last_used_at: null,
  })
  expect(pat.token_prefix).toBe(pat.token.slice(0, 12))
  expect(pat.digest).toBeUndefined()
  const key = await service.authenticate(pat.token)
  expect(key.concurrency_limit).toBe(0)
  expect(key.rpm_limit).toBe(0)
  const edited = await session.inject({
    method: 'PUT',
    url: `/api/agent/auth/pat/${pat.id}`,
    payload: { name: 'renamed legacy', expires_days: 3650 },
  })
  expect(edited.statusCode).toBe(200)
  expect(edited.json().note).toBe('searchable memo')
  expect(edited.json().expires_in_days).toBeGreaterThanOrEqual(3649)
  const rotated = await session.inject({
    method: 'POST',
    url: `/api/agent/auth/pat/${pat.id}/rotate`,
  })
  expect(rotated.statusCode).toBe(201)
  expect(rotated.json().rotated_from_id).toBe(pat.id)
  expect(rotated.json().note).toBe('searchable memo')
  const revoked = await session.inject({
    method: 'DELETE',
    url: `/api/agent/auth/pat/${rotated.json().id}`,
  })
  expect(revoked.statusCode).toBe(200)
  expect(revoked.json().status).toBe('revoked')
  expect(revoked.json().revoked_at).toBeTruthy()
  const again = await session.inject({
    method: 'DELETE',
    url: `/api/agent/auth/pat/${rotated.json().id}`,
  })
  expect(again.json().revoked_at).toBe(revoked.json().revoked_at)
  const list = await session.inject({
    method: 'GET',
    url: '/api/agent/auth/pat?search=searchable&status=revoked&per_page=1',
  })
  expect(list.json().total).toBe(2)
  expect(list.json().items).toHaveLength(1)
  expect(list.body).not.toContain(rotated.json().token)
  expect(list.body).not.toContain('digest')
})
test('legacy PAT seven-day statistics exclude reservations and preserve per-record history', async () => {
  const first = await setup()
  const values = {
    id: 'd0000000-0000-4000-8000-000000000001',
    model: 'public-model',
    protocol: 'openai',
    reserved_tokens: 40,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  }
  await service.repo.reserve(first.id, values)
  let list = await session.inject({ method: 'GET', url: '/api/agent/auth/pat' })
  expect(list.json().items[0]).toMatchObject({ requests_7d: 0, tokens_7d: 0 })
  await service.repo.finish(values.id, {
    status: 'ok',
    input_tokens: 10,
    output_tokens: 3,
  })
  await service.authenticate(first.token)
  list = await session.inject({
    method: 'GET',
    url: '/api/agent/auth/pat?token_type=personal&status=active',
  })
  expect(list.json().items[0]).toMatchObject({ requests_7d: 1, tokens_7d: 13 })
  expect(list.json().items[0].last_used_at).toBeTruthy()
  expect(
    (await service.repo.legacyKeyPage(first.owner_id + 1000, 1, 20)).total,
  ).toBe(0)
  await handle.db.execute(
    sql`UPDATE gw_requests SET created_at=now()-interval '8 days'`,
  )
  expect(
    (await session.inject({ method: 'GET', url: '/api/agent/auth/pat' })).json()
      .items[0].requests_7d,
  ).toBe(0)
})
test('legacy PAT management rejects bearer-only access and invalid scopes', async () => {
  const first = await setup()
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/agent/auth/pat',
        headers: { authorization: `Bearer ${first.token}` },
      })
    ).statusCode,
  ).toBe(401)
  expect(
    (
      await session.inject({
        method: 'POST',
        url: '/api/agent/auth/pat',
        payload: { scopes: ['admin'] },
      })
    ).statusCode,
  ).toBe(400)
  const list = await session.inject({
    method: 'GET',
    url: '/api/agent/auth/pat?page=bad&per_page=1000',
  })
  expect(list.json()).toMatchObject({ page: 1, per_page: 100 })
})

test('legacy PAT usage captures context, filters and isolates rotation history without internal fields', async () => {
  const key = await setup()
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      authorization: `Bearer ${key.token}`,
      'x-coati-request-id': 'fixture:title:1',
      'x-coati-session-id': 'session-fixture',
      'x-coati-step': '2',
    },
    payload: {
      model: 'public-model',
      messages: [{ role: 'user', content: 'private prompt' }],
    },
  })
  expect(response.statusCode).toBe(200)
  const rotated = await service.rotateKey(key.owner_id, key.id)
  await invoke(rotated.token)
  const url = `/api/agent/auth/pat/${key.id}/usage`
  const list = await session.inject({
    method: 'GET',
    url: url + '?model=public-model&status=ok&user_id=99999&pat_id=99999',
  })
  expect(list.statusCode, list.body).toBe(200)
  expect(
    (
      await session.inject({
        method: 'GET',
        url: '/api/agent/auth/pat/99999999/usage',
      })
    ).statusCode,
  ).toBe(404)
  expect(list.json()).toMatchObject({ total: 1, page: 1, per_page: 20 })
  expect(list.json().items[0]).toMatchObject({
    model: 'public-model',
    prompt_tokens: 10,
    completion_tokens: 3,
    total_tokens: 13,
    message_count: 1,
    client_request_id: 'fixture:title:1',
    session_id: 'session-fixture',
    step_index: 2,
    request_purpose: { code: 'title', label: '会话标题' },
    attempt_count: 1,
    fallback_used: false,
    http_status: 200,
  })
  for (const field of [
    'owner_id',
    'user_id',
    'key_id',
    'pat_id',
    'route_id',
    'credential_id',
    'upstream_id',
    'upstream_model',
    'raw_usage',
    'request_context',
  ])
    expect(list.json().items[0]).not.toHaveProperty(field)
  expect(list.body).not.toContain('private prompt')
  expect(
    (
      await session.inject({ method: 'GET', url: url + '?model=unknown' })
    ).json().total,
  ).toBe(0)
  expect(
    (
      await session.inject({ method: 'GET', url: url + '?page=2&per_page=1' })
    ).json().items,
  ).toEqual([])
  await handle.db.execute(
    sql`UPDATE gw_requests SET created_at=now()-interval '8 days' WHERE key_id=${key.id}`,
  )
  expect((await session.inject({ method: 'GET', url })).json().total).toBe(0)
  expect(
    (await session.inject({ method: 'GET', url: url + '?days=9' })).json()
      .total,
  ).toBe(1)
  expect(
    await service.repo.legacyPatUsage(key.owner_id + 1000, key.id, {
      page: 1,
      per_page: 20,
      days: 7,
    }),
  ).toBeNull()
  expect(
    (
      await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${rotated.token}` },
      })
    ).statusCode,
  ).toBe(401)
  expect(
    (await session.inject({ method: 'GET', url: url + '?days=366' }))
      .statusCode,
  ).toBe(400)
  expect(
    (await session.inject({ method: 'GET', url: url + '?status=invalid' }))
      .statusCode,
  ).toBe(400)
})
test('legacy PAT usage explicitly exposes reservations, maps client errors and hides fallback traces', async () => {
  const key = await setup()
  const id = 'pat-usage-reserved'
  await service.repo.reserve(key.id, {
    id,
    model: 'public-model',
    protocol: 'openai',
    reserved_tokens: 40,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  })
  const url = `/api/agent/auth/pat/${key.id}/usage`
  expect((await session.inject({ method: 'GET', url })).json().total).toBe(0)
  expect(
    (
      await session.inject({ method: 'GET', url: url + '?status=reserved' })
    ).json().items[0].status,
  ).toBe('reserved')
  const upstreamId = (await service.repo.upstreams())[0]!.id
  for (let i = 0; i < 2; i++)
    await service.repo.attempt({
      request_id: id,
      upstream_id: upstreamId,
      status: 503,
      duration_ms: 1,
    })
  await service.repo.finish(id, {
    status: 'cancelled',
    error: '账号调用链：private account',
    input_tokens: 2,
  })
  const list = await session.inject({
    method: 'GET',
    url: url + '?status=client_error',
  })
  expect(list.json().items[0]).toMatchObject({
    status: 'client_error',
    fallback_used: true,
    attempt_count: 2,
    error_summary: '请求过程中已自动切换备用账号',
    context_bytes: null,
  })
  expect(list.body).not.toContain('private account')
})

test.each(['key', 'user'])(
  'nonbillable failures do not consume %s quota or usage totals; partial output still counts',
  async (scope) => {
    const key = await setup(
      'openai',
      scope === 'key' ? { daily_limit: 100 } : {},
    )
    if (scope === 'user')
      await service.repo.saveUserLimits(key.owner_id, {
        daily_limit: 100,
        concurrency_limit: 0,
        rpm_limit: 0,
      })
    const statuses = [
      'error',
      'upstream_error',
      'protocol_error',
      'routing_error',
      'quota_exceeded',
      'ok',
      'stream_error',
      'client_error',
      'cancelled',
      'interrupted',
    ]
    for (const [i, status] of statuses.entries()) {
      const id = `billing-${scope}-${i}`
      expect(
        await service.repo.reserve(key.id, {
          id,
          model: 'public-model',
          protocol: 'openai',
          reserved_tokens: 1,
          expires_at: new Date(Date.now() + 60000).toISOString(),
        }),
      ).toBeNull()
      await service.repo.finish(id, {
        status,
        input_tokens: i < 5 ? 1000 : 2,
        output_tokens: i < 5 ? 1000 : 1,
      })
    }
    expect(await service.repo.quotaSummary(key.owner_id)).toMatchObject({
      used_today: 12,
    })
    const list = await session.inject({
      method: 'GET',
      url: '/api/agent/auth/pat',
    })
    expect(list.json().items[0]).toMatchObject({
      requests_7d: 10,
      tokens_7d: 12,
    })
    expect(await service.repo.summary()).toMatchObject({
      tokens: 12,
      requests: 10,
      failed: 9,
    })
    const next = {
      id: `billing-${scope}-next`,
      model: 'public-model',
      protocol: 'openai',
      reserved_tokens: 89,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    }
    expect(await service.repo.reserve(key.id, next)).toBe(
      scope === 'key' ? 'quota_exceeded' : 'user_quota_exceeded',
    )
    expect(
      await service.repo.reserve(key.id, { ...next, reserved_tokens: 88 }),
    ).toBeNull()
    expect(await service.repo.quotaSummary(key.owner_id)).toMatchObject({
      used_today: 12,
    })
    expect(await service.repo.summary()).toMatchObject({
      tokens: 12,
      active: 1,
    })
    expect(
      await service.repo.reserve(key.id, {
        ...next,
        id: next.id + '-overflow',
        reserved_tokens: 1,
      }),
    ).toBe(scope === 'key' ? 'quota_exceeded' : 'user_quota_exceeded')
  },
)

test.each([401, 429, 503])(
  'ledger stores final gateway status separately from upstream %i',
  async (upstreamStatus) => {
    const key = await setup()
    behavior = 'failure'
    failureStatus = upstreamStatus
    const response = await invoke(key.token)
    const row = (await service.repo.listRequests()).items[0]!
    expect(response.statusCode).toBe(upstreamStatus)
    expect(row).toMatchObject({
      status: 'upstream_error',
      http_status: response.statusCode,
    })
    expect((await service.repo.attempts(row.id))[0]!.status).toBe(
      upstreamStatus,
    )
    const usage = await session.inject({
      method: 'GET',
      url: `/api/agent/auth/pat/${key.id}/usage`,
    })
    expect(usage.json().items[0]).toMatchObject({
      status: 'upstream_error',
      http_status: response.statusCode,
    })
  },
)
test('stream failure keeps HTTP 200 and unknown historical HTTP status remains null', async () => {
  const key = await setup()
  behavior = 'truncated'
  const response = await invoke(key.token, {
    model: 'public-model',
    stream: true,
  })
  expect(response.statusCode).toBe(200)
  expect((await service.repo.listRequests()).items[0]).toMatchObject({
    status: 'stream_error',
    http_status: 200,
  })
  await handle.db.execute(sql`UPDATE gw_requests SET http_status=NULL`)
  const usage = await session.inject({
    method: 'GET',
    url: `/api/agent/auth/pat/${key.id}/usage`,
  })
  expect(usage.json().items[0].http_status).toBeNull()
})

test.each(['route', 'cooldown', 'quota', 'stateful'])(
  'pre-admission %s failure writes a correlated zero-charge record without upstream attempts',
  async (reason) => {
    const key = await setup(
      'openai',
      reason === 'quota' ? { daily_limit: 1 } : {},
    )
    if (reason === 'route')
      await handle.db.execute(sql`UPDATE gw_routes SET enabled=false`)
    if (reason === 'cooldown')
      await handle.db.execute(
        sql`UPDATE gw_upstreams SET cooldown_until=now()+interval '1 hour'`,
      )
    const response = await invoke(key.token, {
      model: 'public-model',
      ...(reason === 'stateful' ? { previous_response_id: 'unavailable' } : {}),
    })
    const status =
      reason === 'quota'
        ? 429
        : reason === 'route'
          ? 404
          : reason === 'cooldown'
            ? 503
            : 400
    expect(response.statusCode, response.body).toBe(status)
    const records = (await service.repo.listRequests()).items
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: response.json().request_id,
      status:
        reason === 'quota'
          ? 'quota_exceeded'
          : reason === 'stateful'
            ? 'protocol_error'
            : 'routing_error',
      http_status: status,
      reserved_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
    })
    expect(await service.repo.attempts(records[0]!.id)).toHaveLength(0)
    expect(await service.repo.quotaSummary(key.owner_id)).toMatchObject({
      used_today: 0,
    })
    expect(await service.repo.summary()).toMatchObject({
      tokens: 0,
      active: 0,
      failed: 1,
    })
    expect(await service.repo.recoverExpired()).toHaveLength(0)
    expect(calls).toBe(0)
    const usage = await session.inject({
      method: 'GET',
      url: `/api/agent/auth/pat/${key.id}/usage`,
    })
    expect(usage.json().items[0]).toMatchObject({
      request_id: response.json().request_id,
      http_status: status,
      attempt_count: 0,
    })
  },
)
test('rejection-log persistence failure preserves original response and never calls upstream', async () => {
  const key = await setup('openai', { daily_limit: 1 })
  const persist = vi
    .spyOn(GatewayRepository.prototype, 'recordRejected')
    .mockRejectedValue(new Error('fixture audit unavailable'))
  try {
    const response = await invoke(key.token)
    expect(response.statusCode).toBe(429)
    expect(response.json().error.code).toBe('quota_exceeded')
    expect(response.json().request_id).toBeTruthy()
    expect(calls).toBe(0)
  } finally {
    persist.mockRestore()
  }
})

for (const image of [false, true]) {
  test(`coati-auto selects ${image ? 'vision' : 'text'} target and retains public alias`, async () => {
    const key = await setup('openai', { models: ['coati-auto'] })
    await handle.db.execute(
      sql`UPDATE gw_routes SET model='coati-auto', upstream_model='text-target', vision_model='vision-target'`,
    )
    const response = await invoke(key.token, {
      model: 'coati-auto',
      messages: [
        {
          role: 'user',
          content: image
            ? [
                {
                  type: 'image_url',
                  image_url: { url: 'https://example.invalid/image.png' },
                },
              ]
            : 'hello',
        },
      ],
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(observed.model).toBe(image ? 'vision-target' : 'text-target')
    expect(response.json().model).toBe('coati-auto')
    expect((await service.repo.listRequests()).items[0]).toMatchObject({
      model: 'coati-auto',
      status: 'ok',
      execution: { upstream_model: image ? 'vision-target' : 'text-target' },
    })
  })
}
for (const missingRoute of [false, true]) {
  test(`coati-auto missing ${missingRoute ? 'route' : 'vision target'} refuses without upstream traffic`, async () => {
    const key = await setup('openai', { models: ['coati-auto'] })
    if (!missingRoute)
      await handle.db.execute(sql`UPDATE gw_routes SET model='coati-auto'`)
    const response = await invoke(key.token, {
      model: 'coati-auto',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'https://example.invalid/a.png' },
            },
          ],
        },
      ],
    })
    expect(response.statusCode, response.body).toBe(503)
    expect(calls).toBe(0)
    expect((await service.repo.listRequests()).items[0]).toMatchObject({
      status: 'routing_error',
      input_tokens: 0,
      output_tokens: 0,
    })
  })
}
test('vision target removed after candidate selection never acquires a lease or binds the session', async () => {
  const key = await setup('openai', { models: ['coati-auto'] })
  await handle.db.execute(
    sql`UPDATE gw_routes SET model='coati-auto', vision_model='vision-target'`,
  )
  const original = GatewayRepository.prototype.acquireUpstream
  const spy = vi
    .spyOn(GatewayRepository.prototype, 'acquireUpstream')
    .mockImplementationOnce(async function (this: GatewayRepository, ...args) {
      await handle.db.execute(sql`UPDATE gw_routes SET vision_model=NULL`)
      return original.apply(this, args)
    })
  try {
    const response = await invoke(key.token, {
      model: 'coati-auto',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'https://example.invalid/a.png' },
            },
          ],
        },
      ],
      session_id: 'auto-test',
    })
    expect(response.statusCode, response.body).toBe(503)
    expect(calls).toBe(0)
    const counts = await handle.db.execute(
      sql`SELECT (SELECT count(*)::int FROM gw_upstream_leases) AS leases, (SELECT count(*)::int FROM gw_session_bindings) AS bindings`,
    )
    expect(counts.rows[0]).toEqual({ leases: 0, bindings: 0 })
  } finally {
    spy.mockRestore()
  }
})
test('ordinary model ignores vision override and route API persists and clears it', async () => {
  const key = await setup()
  const routes = await handle.db.execute(sql`SELECT * FROM gw_routes`)
  const route = routes.rows[0]!
  const update = (vision_model: string) =>
    session.inject({
      method: 'PUT',
      url: `/api/admin/gateway/routes/${route.id}`,
      payload: {
        model: 'public-model',
        upstream_id: route.upstream_id,
        upstream_model: 'openai',
        vision_model,
      },
    })
  expect((await update('vision-target')).statusCode).toBe(200)
  expect(
    (
      await invoke(key.token, {
        model: 'public-model',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'https://example.invalid/a.png' },
              },
            ],
          },
        ],
      })
    ).statusCode,
  ).toBe(200)
  expect(observed.model).toBe('openai')
  expect((await update('')).statusCode).toBe(200)
  expect(
    (await handle.db.execute(sql`SELECT vision_model FROM gw_routes`)).rows[0]!
      .vision_model,
  ).toBeNull()
})

for (const reason of ['idle', 'deadline', 'client'] as const) {
  test(`paused stream ${reason} releases admission before the consumer resumes`, async () => {
    const k = await setup()
    behavior = 'slow'
    const short = new GatewayService(handle.db, {
      ...service.options,
      idleTimeoutMs: reason === 'idle' ? 40 : 5000,
      timeoutMs: reason === 'deadline' ? 150 : 5000,
    })
    await short.repo.saveUpstream(
      {
        name: 'fixture',
        protocol: 'openai',
        base_url: base,
        secret: short.vault.encrypt('secret-test-key'),
      },
      1,
    )
    const controller = new AbortController()
    const persist = vi.spyOn(short.repo, 'finish')
    let iterator: AsyncGenerator<string> | undefined
    try {
      const result = await short.execute(
        await short.authenticate(k.token),
        { model: 'public-model', stream: true },
        'openai',
        controller.signal,
      )
      iterator = result.stream!
      expect((await iterator.next()).done).toBe(false)
      // No next()/return() while waiting: the consumer is suspended on a yield.
      if (reason === 'client') controller.abort()
      await expect
        .poll(async () => (await short.repo.listRequests()).items[0]?.status, {
          timeout: 1000,
        })
        .toBe(reason === 'client' ? 'client_error' : 'stream_error')
      expect(
        (
          await handle.db.execute(
            sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
          )
        ).rows[0]?.n,
      ).toBe(0)
      let remaining = ''
      for await (const chunk of iterator) remaining += chunk
      expect(remaining).not.toContain('[DONE]')
      if (reason !== 'client') expect(remaining).toContain('stream_error')
      expect(persist).toHaveBeenCalledTimes(1)
    } finally {
      controller.abort()
      await iterator?.return(undefined as never)
      persist.mockRestore()
      await short.transport.close()
    }
  })
}

for (const prefix of ['/api/admin/gateway/device', '/api/agent/auth/device']) {
  test(`${prefix}: device decisions preserve conflicts, denial and expiry`, async () => {
    const start = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent/auth/device/start',
        })
      ).json()
    const poll = (code: string) =>
      app.inject({
        method: 'POST',
        url: '/api/agent/auth/device/poll',
        payload: { device_code: code },
      })
    if (prefix === '/api/agent/auth/device') {
      for (const [user_code, status, message] of [
        ['', 400, '用户码 必填'],
        ['x'.repeat(33), 400, '用户码 不能超过 32 个字符'],
        ['missing', 404, '用户码无效'],
      ] as const) {
        const response = await session.inject({ method: 'POST', url: prefix + '/confirm', payload: { user_code } })
        expect(response.statusCode).toBe(status)
        expect(response.json()).toEqual({ error: message })
      }
      const approved = await start()
      const confirmation = await session.inject({ method: 'POST', url: prefix + '/confirm', payload: { user_code: ` ${approved.user_code.toLowerCase()} ` } })
      expect(confirmation.json()).toEqual({ ok: true, user_code: approved.user_code })
      const repeated = await session.inject({ method: 'POST', url: prefix + '/confirm', payload: { user_code: approved.user_code } })
      expect(repeated.statusCode).toBe(409)
      expect(repeated.json()).toEqual({ error: '该登录请求已确认，请返回发起登录的应用继续' })
    }
    const denied = await start()
    expect(denied.verification_uri_complete).toBe(
      `/agent/device-confirm?user_code=${denied.user_code}`,
    )
    expect(
      (
        await session.inject({
          method: 'POST',
          url: prefix + '/deny',
          payload: { user_code: denied.user_code.toLowerCase() },
        })
      ).statusCode,
    ).toBe(200)
    expect((await poll(denied.device_code)).json().error_code).toBe('access_denied')
    expect(
      (
        await session.inject({
          method: 'POST',
          url: prefix + '/confirm',
          payload: { user_code: denied.user_code },
        })
      ).statusCode,
    ).toBe(409)
    const expired = await start()
    await handle.db.execute(
      sql`UPDATE gw_devices SET expires_at=clock_timestamp()-interval '1 second' WHERE user_code=${expired.user_code}`,
    )
    expect(
      (
        await session.inject({
          method: 'POST',
          url: prefix + '/confirm',
          payload: { user_code: expired.user_code },
        })
      ).statusCode,
    ).toBe(410)
    expect((await poll(expired.device_code)).json().error_code).toBe('expired_token')
    expect((await poll('missing-code')).statusCode).toBe(404)
    expect(
      (await handle.db.execute(sql`SELECT count(*)::int AS n FROM gw_keys`))
        .rows[0]?.n,
    ).toBe(0)
  })
  test(`${prefix}: confirmation and denial race has one winner and stays CSRF protected`, async () => {
    const codes = (
      await app.inject({ method: 'POST', url: '/api/agent/auth/device/start' })
    ).json()
    const payload = { user_code: codes.user_code }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: prefix + '/confirm',
          cookies: { coati_session: session.cookie },
          payload,
        })
      ).statusCode,
    ).toBe(403)
    const decisions = await Promise.all(
      ['confirm', 'deny'].map((action) =>
        session.inject({ method: 'POST', url: prefix + '/' + action, payload }),
      ),
    )
    expect(decisions.map((r) => r.statusCode).sort()).toEqual([200, 409])
    const polls = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/agent/auth/device/poll',
          payload: { device_code: codes.device_code },
        }),
      ),
    )
    if (decisions[0]!.statusCode === 200) {
      expect(polls.filter((r) => r.statusCode === 200)).toHaveLength(1)
      expect(
        polls.filter(
          (r) => r.statusCode === 409 && r.json().error_code === 'already_consumed',
        ),
      ).toHaveLength(2)
    } else
      expect(polls.every((r) => r.json().error_code === 'access_denied')).toBe(true)
  })
}

test('device start admission is shared across independent database pools', async () => {
  const other = openTestDb()
  const repositories = [service.repo, new GatewayRepository(other.db)]
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        repositories[i % 2]!.createDevice(
          {
            device_hash: `device-hash-${i}`,
            user_code: `DEVICE-${i}`,
            expires_at: '2099-01-01T00:00:00Z',
          },
          { startsPerMinute: 3, maxActive: 100, retentionHours: 24 },
        ),
      ),
    )
    expect(results.filter((r) => r === 'created')).toHaveLength(3)
    expect(results.filter((r) => r === 'rate_limited')).toHaveLength(9)
    expect(
      (
        await handle.db.execute(
          sql`SELECT count(*)::int AS n FROM gw_devices WHERE expires_at BETWEEN clock_timestamp()+interval '599 seconds' AND clock_timestamp()+interval '601 seconds'`,
        )
      ).rows[0]?.n,
    ).toBe(3)
  } finally {
    await other.pool.end()
  }
})
test('device capacity includes approved requests, expires stale requests and retains recent history', async () => {
  const policy = { startsPerMinute: 100, maxActive: 1, retentionHours: 24 }
  const insert = (n: number) =>
    service.repo.createDevice(
      {
        device_hash: `capacity-hash-${n}`,
        user_code: `CAPACITY-${n}`,
        expires_at: '2099-01-01T00:00:00Z',
      },
      policy,
    )
  expect(await insert(1)).toBe('created')
  await handle.db.execute(sql`UPDATE gw_devices SET status='approved'`)
  expect(await insert(2)).toBe('capacity_exceeded')
  await handle.db.execute(
    sql`UPDATE gw_devices SET expires_at=clock_timestamp()-interval '1 second'`,
  )
  expect(await insert(3)).toBe('created')
  expect(
    (
      await handle.db.execute(
        sql`SELECT status FROM gw_devices WHERE user_code='CAPACITY-1'`,
      )
    ).rows[0]?.status,
  ).toBe('expired')
  await handle.db.execute(
    sql`UPDATE gw_devices SET created_at=clock_timestamp()-interval '25 hours', expires_at=clock_timestamp()-interval '24 hours'`,
  )
  expect(await insert(4)).toBe('created')
  expect(
    (await handle.db.execute(sql`SELECT count(*)::int AS n FROM gw_devices`))
      .rows[0]?.n,
  ).toBe(1)
})
test('device start endpoint reports shared rate limit and retry time', async () => {
  vi.stubEnv('AGENT_DEVICE_STARTS_PER_MINUTE', '1')
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agent/auth/device/start',
        })
      ).statusCode,
    ).toBe(200)
    const result = await app.inject({
      method: 'POST',
      url: '/api/agent/auth/device/start',
      headers: { 'x-forwarded-for': '198.51.100.2' },
    })
    expect(result.statusCode).toBe(429)
    expect(result.headers['retry-after']).toBe('60')
    expect(result.json().error.code).toBe('rate_limited')
  } finally {
    vi.unstubAllEnvs()
  }
})

test('redeemed device token returns safe user details and inherits shared governance', async () => {
  const codes = await service.startDevice()
  await service.decideDevice(
    session.userId,
    { user_code: codes.user_code },
    'approved',
  )
  const grant = await service.pollDevice(codes.device_code)
  expect(grant.user).toMatchObject({
    id: session.userId,
    username: 'ck_test_super',
  })
  expect(Array.isArray(grant.user.roles)).toBe(true)
  expect(Array.isArray(grant.user.menu_codes)).toBe(true)
  expect(JSON.stringify(grant.user)).not.toContain('password')
  expect(grant.scope).toBe('chat profile')
  const key = await service.authenticate(grant.access_token)
  expect(key).toMatchObject({
    kind: 'device',
    scopes: ['chat', 'profile'],
    daily_limit: 0,
    concurrency_limit: 0,
    rpm_limit: 0,
  })
  expect(Date.parse(key.expires_at!) - Date.now()).toBeGreaterThan(
    29 * 86400000,
  )
  const value = (id: string, tokens: number) => ({
    id,
    model: 'public-model',
    protocol: 'openai',
    reserved_tokens: tokens,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  })
  await service.saveUserLimits(key.owner_id, {
    daily_limit: 200000,
    concurrency_limit: 1,
    rpm_limit: 2,
  })
  expect(
    await service.repo.reserve(key.id, value('device-shared-first', 120000)),
  ).toBeNull()
  expect(
    await service.repo.reserve(key.id, value('device-shared-busy', 1)),
  ).toBe('user_concurrency_limit')
  await service.repo.finish('device-shared-first', {
    status: 'ok',
    input_tokens: 120000,
    output_tokens: 0,
  })
  expect(
    await service.repo.reserve(key.id, value('device-shared-quota', 90000)),
  ).toBe('user_quota_exceeded')
  expect(
    await service.repo.reserve(key.id, value('device-shared-second', 1)),
  ).toBeNull()
  await service.repo.finish('device-shared-second', {
    status: 'ok',
    input_tokens: 1,
    output_tokens: 0,
  })
  expect(
    await service.repo.reserve(key.id, value('device-shared-rate', 1)),
  ).toBe('user_rate_limit')
})

test('failed device profile loading does not consume authorization or issue an orphan key', async () => {
  const codes = await service.startDevice()
  await service.decideDevice(
    session.userId,
    { user_code: codes.user_code },
    'approved',
  )
  const lookup = vi
    .spyOn(authHelpers, 'loadAdminsWithRolesByIds')
    .mockRejectedValueOnce(new Error('fixture profile query failure'))
  try {
    await expect(service.pollDevice(codes.device_code)).rejects.toThrow(
      'fixture profile query failure',
    )
    expect(
      (
        await handle.db.execute(
          sql`SELECT status FROM gw_devices WHERE user_code=${codes.user_code}`,
        )
      ).rows[0]?.status,
    ).toBe('approved')
    expect(
      (await handle.db.execute(sql`SELECT count(*)::int AS n FROM gw_keys`))
        .rows[0]?.n,
    ).toBe(0)
  } finally {
    lookup.mockRestore()
  }
  expect((await service.pollDevice(codes.device_code)).user.id).toBe(
    session.userId,
  )
})

test('device request admission is atomic across database connections', async () => {
  const other = openTestDb()
  try {
    const replica = new GatewayRepository(other.db)
    const results = await Promise.all(
      Array.from({ length: 80 }, (_, i) =>
        (i % 2 ? service.repo : replica).admitDeviceRequest(
          'fixture-shared-ip',
        ),
      ),
    )
    expect(results.filter((value) => value === 0)).toHaveLength(60)
    expect(results.filter((value) => value > 0)).toHaveLength(20)
    const state = await handle.db.execute(
      sql`select count from gw_device_rate_limits where identity = 'fixture-shared-ip'`,
    )
    expect(state.rows[0]?.count).toBe(60)
    await handle.db.execute(
      sql`update gw_device_rate_limits set started_at = clock_timestamp() - interval '61 seconds'`,
    )
    expect(await replica.admitDeviceRequest('fixture-shared-ip')).toBe(0)
    const reset = await handle.db.execute(
      sql`select count from gw_device_rate_limits`,
    )
    expect(reset.rows).toEqual([{ count: 1 }])
  } finally {
    await other.pool.end()
  }
})

test('device request identity capacity is bounded and expired entries are reclaimed', async () => {
  await handle.db.execute(sql`insert into gw_device_rate_limits (identity)
    select 'fixture-' || generate_series(1,10000)`)
  expect(await service.repo.admitDeviceRequest('new-identity')).toBe(60)
  expect(await service.repo.admitDeviceRequest('fixture-1')).toBe(0)
  await handle.db.execute(
    sql`update gw_device_rate_limits set started_at = clock_timestamp() - interval '61 seconds'`,
  )
  expect(await service.repo.admitDeviceRequest('new-identity')).toBe(0)
  const count = await handle.db.execute(
    sql`select count(*)::integer as count from gw_device_rate_limits`,
  )
  expect(count.rows[0]?.count).toBe(1)
})

test('device polling shares IP limits across app replicas and ignores untrusted forwarded addresses', async () => {
  const replica = await buildTestApp()
  try {
    for (let i = 0; i < 60; i++) {
      const response = await (i % 2 ? replica : app).inject({
        method: 'POST',
        url: '/api/agent/auth/device/poll',
        remoteAddress: '192.0.2.88',
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
        payload: { device_code: 'unknown' },
      })
      expect(response.statusCode).toBe(404)
    }
    for (const target of [app, replica]) {
      const response = await target.inject({
        method: 'POST',
        url: '/api/agent/auth/device/poll',
        remoteAddress: '192.0.2.88',
        payload: { device_code: 'unknown' },
      })
      expect(response.statusCode).toBe(429)
      expect(response.json()).toEqual({ error: 'slow_down' })
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    }
    const separate = await replica.inject({
      method: 'POST',
      url: '/api/agent/auth/device/poll',
      remoteAddress: '192.0.2.89',
      payload: { device_code: 'unknown' },
    })
    expect(separate.statusCode).toBe(404)
  } finally {
    await replica.close()
  }
})

test('trusted proxy uses the nearest untrusted address for shared device limits', async () => {
  const proxyApp = await buildTestApp({ trustedProxies: ['192.0.2.10'] })
  try {
    await Promise.all(
      Array.from({ length: 60 }, () =>
        service.admitDeviceRequest('198.51.100.8'),
      ),
    )
    const limited = await proxyApp.inject({
      method: 'POST',
      url: '/api/agent/auth/device/poll',
      remoteAddress: '192.0.2.10',
      headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.8' },
      payload: { device_code: 'unknown' },
    })
    expect(limited.statusCode).toBe(429)
    const separate = await proxyApp.inject({
      method: 'POST',
      url: '/api/agent/auth/device/poll',
      remoteAddress: '192.0.2.10',
      headers: { 'x-forwarded-for': '198.51.100.9' },
      payload: { device_code: 'unknown' },
    })
    expect(separate.statusCode).toBe(404)
  } finally {
    await proxyApp.close()
  }
})

test('personal usage spans rotated keys, scopes PAT filters and preserves safe usage fields', async () => {
  const key = await setup()
  await invoke(key.token)
  const rotated = await service.rotateKey(key.owner_id, key.id)
  await invoke(rotated.token)
  await handle.db.execute(
    sql`update gw_requests set cache_read_tokens=0, cache_write_tokens=null where key_id=${key.id}`,
  )
  const passwordHash = await generatePasswordHash(
    'usage-fixture-password',
    1000,
  )
  const foreign = await handle.db
    .execute(sql`insert into admin_users (username,password_hash)
    values ('usage-isolation-fixture',${passwordHash}) returning id`)
  const foreignOwner = Number(foreign.rows[0]?.id)
  let foreignKey = 0
  try {
    const other = await service.createKey(foreignOwner, {
      name: 'foreign-private-key',
      models: ['*'],
    })
    foreignKey = other.id
    await invoke(other.token)
    const url = '/api/agent/me/usage'
    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: {
        username: 'usage-isolation-fixture',
        password: 'usage-fixture-password',
      },
    })
    expect(login.statusCode).toBe(200)
    for (const entry of [
      {
        method: 'GET' as const,
        url: '/api/admin/gateway/route-migration/history',
      },
      {
        method: 'POST' as const,
        url: '/api/admin/gateway/route-migration/apply',
        payload: { model: 'public-model', version: 'a'.repeat(64) },
      },
      {
        method: 'POST' as const,
        url: '/api/admin/gateway/route-migration/00000000-0000-4000-8000-000000000000/rollback',
        payload: {},
      },
    ]) {
      const denied = await app.inject({
        ...entry,
        cookies: {
          coati_session: login.cookies.find(
            (cookie) => cookie.name === 'coati_session',
          )!.value,
        },
        headers: { 'x-csrf-token': login.json().csrf_token },
      })
      expect(denied.statusCode, denied.body).toBe(403)
    }
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/agent/routes',
          cookies: {
            coati_session: login.cookies.find(
              (cookie) => cookie.name === 'coati_session',
            )!.value,
          },
        })
      ).statusCode,
    ).toBe(403)
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const denied = await app.inject({
        method,
        url: '/api/admin/agent/routes' + (method === 'POST' ? '' : '/999999'),
        ...(method === 'DELETE'
          ? {}
          : { payload: { model_name: 'forbidden' } }),
        cookies: {
          coati_session: login.cookies.find(
            (cookie) => cookie.name === 'coati_session',
          )!.value,
        },
        headers: { 'x-csrf-token': login.json().csrf_token },
      })
      expect(denied.statusCode, denied.body).toBe(403)
    }
    const own = await app.inject({
      method: 'GET',
      url: url + `?user_id=${key.owner_id}`,
      cookies: {
        coati_session: login.cookies.find(
          (cookie) => cookie.name === 'coati_session',
        )!.value,
      },
    })
    expect(own.statusCode).toBe(200)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/gateway/route-migration/preflight',
          cookies: {
            coati_session: login.cookies.find(
              (cookie) => cookie.name === 'coati_session',
            )!.value,
          },
        })
      ).statusCode,
    ).toBe(403)

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/gateway/public-routes',
          cookies: {
            coati_session: login.cookies.find(
              (cookie) => cookie.name === 'coati_session',
            )!.value,
          },
        })
      ).statusCode,
    ).toBe(403)

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/gateway/requests/00000000-0000-4000-8000-000000000000',
          cookies: {
            coati_session: login.cookies.find(
              (cookie) => cookie.name === 'coati_session',
            )!.value,
          },
        })
      ).statusCode,
    ).toBe(403)

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/agent/quotas',
          cookies: {
            coati_session: login.cookies.find(
              (cookie) => cookie.name === 'coati_session',
            )!.value,
          },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/admin/agent/quotas/${foreignOwner}`,
          cookies: {
            coati_session: login.cookies.find(
              (cookie) => cookie.name === 'coati_session',
            )!.value,
          },
          headers: { 'x-csrf-token': login.json().csrf_token },
          payload: { daily_token_quota: 0 },
        })
      ).statusCode,
    ).toBe(403)

    const analytics = await app.inject({
      method: 'GET',
      url: '/api/agent/me/usage/analytics?user_id=' + key.owner_id,
      cookies: {
        coati_session: login.cookies.find(
          (cookie) => cookie.name === 'coati_session',
        )!.value,
      },
    })
    expect(analytics.statusCode).toBe(200)
    const adminListUrl = '/api/admin/agent/usage'
    const adminList = await session.inject({ method: 'GET', url: adminListUrl })
    expect(adminList.statusCode).toBe(200)
    expect(adminList.json().total).toBe(3)
    const foreignList = await session.inject({
      method: 'GET',
      url: adminListUrl + '?user_id=' + foreignOwner,
    })
    expect(foreignList.json()).toMatchObject({
      total: 1,
      items: [
        {
          user_id: foreignOwner,
          username: 'usage-isolation-fixture',
          pat_id: other.id,
        },
      ],
    })
    expect(
      (
        await app.inject({
          method: 'GET',
          url: adminListUrl,
          cookies: {
            coati_session: login.cookies.find(
              (cookie) => cookie.name === 'coati_session',
            )!.value,
          },
        })
      ).statusCode,
    ).toBe(403)
    const adminUrl = '/api/admin/agent/usage/analytics'
    expect(
      (
        await app.inject({
          method: 'GET',
          url: adminUrl,
          cookies: {
            coati_session: login.cookies.find(
              (cookie) => cookie.name === 'coati_session',
            )!.value,
          },
        })
      ).statusCode,
    ).toBe(403)
    const allStats = await session.inject({ method: 'GET', url: adminUrl })
    expect(allStats.statusCode, allStats.body).toBe(200)
    expect(allStats.json().summary).toMatchObject({
      requests: 3,
      tokens: 39,
      active_users: 2,
    })
    expect(allStats.json().users).toEqual([
      expect.objectContaining({
        user_id: key.owner_id,
        requests: 2,
        tokens: 26,
      }),
      expect.objectContaining({
        user_id: foreignOwner,
        requests: 1,
        tokens: 13,
      }),
    ])
    expect(allStats.json()).not.toHaveProperty('quota')
    const oneUser = await session.inject({
      method: 'GET',
      url: adminUrl + '?user_id=' + foreignOwner,
    })
    expect(oneUser.json().summary).toMatchObject({
      requests: 1,
      tokens: 13,
      active_users: 1,
    })
    expect(oneUser.json().users).toHaveLength(1)
    expect(oneUser.json().filter_options.users).toHaveLength(2)
    const byPat = await session.inject({
      method: 'GET',
      url: adminUrl + '?pat_id=' + key.id,
    })
    expect(byPat.json().summary.requests).toBe(1)

    expect(analytics.json().summary.requests).toBe(1)
    expect(analytics.json().filter_options.pats).toEqual([
      { value: other.id, label: 'foreign-private-key' },
    ])
    const foreignAnalytics = await app.inject({
      method: 'GET',
      url: '/api/agent/me/usage/analytics?pat_id=' + key.id,
      cookies: {
        coati_session: login.cookies.find(
          (cookie) => cookie.name === 'coati_session',
        )!.value,
      },
    })
    expect(foreignAnalytics.json().summary.requests).toBe(0)

    const deniedExport = await app.inject({
      method: 'POST',
      url: '/api/agent/me/usage/export',
      cookies: {
        coati_session: login.cookies.find(
          (cookie) => cookie.name === 'coati_session',
        )!.value,
      },
      headers: { 'X-CSRF-Token': login.json().csrf_token },
      payload: { file_type: 'csv' },
    })
    expect(deniedExport.statusCode).toBe(403)
    const ownedIds = (
      await service.repo.legacyMineUsage(key.owner_id, {
        page: 1,
        per_page: 20,
        days: 7,
      })
    ).rows.map((item) => item.row.id)
    const foreignIds = (
      await service.repo.legacyMineUsage(foreignOwner, {
        page: 1,
        per_page: 20,
        days: 7,
      })
    ).rows.map((item) => item.row.id)
    const selectedExport = await session.inject({
      method: 'POST',
      url: '/api/agent/me/usage/export',
      payload: {
        file_type: 'csv',
        export_mode: 'selected',
        fields: ['request_id'],
        ids: [...ownedIds, ...foreignIds],
        filters: { user_id: foreignOwner },
      },
    })
    expect(selectedExport.statusCode).toBe(200)
    for (const id of ownedIds) expect(selectedExport.body).toContain(id)
    for (const id of foreignIds) expect(selectedExport.body).not.toContain(id)

    expect(own.json()).toMatchObject({
      total: 1,
      items: [{ pat_name: 'foreign-private-key' }],
    })
    const response = await session.inject({
      method: 'GET',
      url: url + `?user_id=${foreignOwner}`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ total: 2, page: 1, per_page: 20 })
    expect(response.body).not.toContain('foreign-private-key')
    const names = response.json().items.map((item: any) => item.pat_name)
    expect(names).toContain(key.name)
    for (const row of response.json().items) {
      expect(row).toMatchObject({ total_tokens: 13, status: 'ok' })
      for (const field of [
        'user_id',
        'owner_id',
        'key_id',
        'pat_id',
        'upstream_id',
        'route_id',
        'raw_usage',
        'request_context',
      ])
        expect(row).not.toHaveProperty(field)
    }
    const filtered = await session.inject({
      method: 'GET',
      url: url + `?pat_id=${key.id}`,
    })
    expect(filtered.json()).toMatchObject({
      total: 1,
      items: [{ cache_read_tokens: 0, cache_write_tokens: null }],
    })
    expect(
      (
        await session.inject({
          method: 'GET',
          url: url + `?pat_id=${other.id}`,
        })
      ).json().total,
    ).toBe(0)
    expect(
      (
        await session.inject({ method: 'GET', url: url + '?pat_id=999999999' })
      ).json().items,
    ).toEqual([])
    const page = await session.inject({
      method: 'GET',
      url: url + '?page=2&per_page=1',
    })
    expect(page.json()).toMatchObject({ total: 2, page: 2, per_page: 1 })
    expect(page.json().items).toHaveLength(1)
    expect(
      (
        await session.inject({ method: 'GET', url: url + '?model=unknown' })
      ).json().total,
    ).toBe(0)
    expect(
      (
        await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${rotated.token}` },
        })
      ).statusCode,
    ).toBe(401)
    for (const query of [
      'pat_id=0',
      'pat_id=oops',
      'days=366',
      'status=invalid',
    ])
      expect(
        (await session.inject({ method: 'GET', url: url + '?' + query }))
          .statusCode,
      ).toBe(400)
  } finally {
    await handle.db.execute(
      sql`delete from gw_attempts where request_id in (select id from gw_requests where key_id=${foreignKey})`,
    )
    await handle.db.execute(
      sql`delete from gw_requests where key_id=${foreignKey}`,
    )
    await handle.db.execute(
      sql`delete from gw_keys where owner_id=${foreignOwner}`,
    )
    await handle.db.execute(
      sql`delete from login_logs where username='usage-isolation-fixture'`,
    )
    await handle.db.execute(
      sql`delete from admin_users where id=${foreignOwner}`,
    )
  }
})

test('personal usage applies time/status filters and hides internal fallback traces', async () => {
  const key = await setup()
  const id = 'mine-usage-reservation'
  await service.repo.reserve(key.id, {
    id,
    model: 'public-model',
    protocol: 'openai',
    reserved_tokens: 40,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  })
  const url = '/api/agent/me/usage'
  expect((await session.inject({ method: 'GET', url })).json().total).toBe(0)
  expect(
    (
      await session.inject({ method: 'GET', url: url + '?status=reserved' })
    ).json().total,
  ).toBe(1)
  const upstreamId = (await service.repo.upstreams())[0]!.id
  for (let i = 0; i < 2; i++)
    await service.repo.attempt({
      request_id: id,
      upstream_id: upstreamId,
      status: 503,
      duration_ms: 1,
    })
  await service.repo.finish(id, {
    status: 'cancelled',
    input_tokens: 2,
    error: '账号调用链：private-account-details',
  })
  const response = await session.inject({
    method: 'GET',
    url: url + '?status=client_error',
  })
  expect(response.json().items[0]).toMatchObject({
    error_summary: '请求过程中已自动切换备用账号',
    fallback_used: true,
    attempt_count: 2,
  })
  expect(response.body).not.toContain('private-account-details')
  await handle.db.execute(
    sql`update gw_requests set created_at=now()-interval '8 days' where id=${id}`,
  )
  expect((await session.inject({ method: 'GET', url })).json().total).toBe(0)
  expect(
    (await session.inject({ method: 'GET', url: url + '?days=9' })).json()
      .total,
  ).toBe(1)
})

test.each(['csv', 'xlsx', 'xls'])(
  'personal usage export writes %s with safe selected fields and cache blanks',
  async (fileType) => {
    const key = await setup()
    await invoke(key.token)
    await handle.db.execute(
      sql`update gw_requests set model='=HYPERLINK("fixture")',cache_read_tokens=0,cache_write_tokens=null,error='账号调用链：private'`,
    )
    const response = await session.inject({
      method: 'POST',
      url: '/api/agent/me/usage/export',
      payload: {
        file_type: fileType,
        fields: [
          'model',
          'cache_read_tokens',
          'cache_write_tokens',
          'status',
          'credential_id',
        ],
        filters: { days: 7 },
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-disposition']).toContain(
      'my_usage_export.' + fileType,
    )
    if (fileType === 'xls')
      expect(response.rawPayload.subarray(0, 8).toString('hex')).toBe(
        'd0cf11e0a1b11ae1',
      )
    const workbook = read(response.rawPayload, { type: 'buffer', raw: true })
    const values = utils.sheet_to_json(
      workbook.Sheets[workbook.SheetNames[0]!]!,
      { header: 1, defval: '' },
    )
    expect(values).toEqual([
      ['模型', '缓存读取 Token', '缓存写入 Token', '状态'],
      ['\'=HYPERLINK("fixture")', '0', '', '成功'],
    ])
  },
)

test('personal usage selected export ignores filter window, validates selection and requires CSRF', async () => {
  const key = await setup()
  await invoke(key.token)
  const result = await service.repo.legacyMineUsage(key.owner_id, {
    page: 1,
    per_page: 20,
    days: 7,
  })
  const id = result.rows[0]!.row.id
  await handle.db.execute(
    sql`update gw_requests set created_at=now()-interval '10 days' where id=${id}`,
  )
  const url = '/api/agent/me/usage/export'
  const response = await session.inject({
    method: 'POST',
    url,
    payload: {
      export_mode: 'selected',
      ids: [id, id],
      fields: ['request_id'],
      filters: { days: 1, model: 'does-not-match' },
    },
  })
  expect(response.statusCode).toBe(200)
  expect(response.headers['content-disposition']).toContain('.xlsx')
  const wb = read(response.rawPayload, { type: 'buffer' })
  expect(
    utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]!]!, { header: 1 }),
  ).toEqual([['请求 ID'], [id]])
  expect(
    (
      await session.inject({
        method: 'POST',
        url,
        payload: { export_mode: 'selected', ids: [] },
      })
    ).statusCode,
  ).toBe(400)
  expect(
    (
      await session.inject({
        method: 'POST',
        url,
        payload: { filters: { days: 366 } },
      })
    ).statusCode,
  ).toBe(400)
  expect(
    (
      await app.inject({
        method: 'POST',
        url,
        cookies: { coati_session: session.cookie },
        payload: {},
      })
    ).statusCode,
  ).toBe(403)
  expect(
    (await app.inject({ method: 'POST', url, payload: {} })).statusCode,
  ).toBe(401)
})

test('personal analytics preserves billing, latency, model scope and nullable cache semantics', async () => {
  const key = await setup()
  await handle.db
    .execute(sql`insert into gw_requests (id,key_id,model,protocol,status,reserved_tokens,input_tokens,output_tokens,duration_ms,cache_read_tokens,created_at,expires_at)
 values ('stats-ok',${key.id},'alpha','openai','ok',0,100,10,100,0,now(),now()),
 ('stats-partial',${key.id},'beta','openai','client_error',0,20,2,300,null,now(),now()),
 ('stats-failed',${key.id},'alpha','openai','upstream_error',0,999,999,null,null,now(),now()),
 ('stats-reserved',${key.id},'reserved-only','openai','reserved',20,888,888,null,null,now(),now())`)
  const url = '/api/agent/me/usage/analytics'
  const response = await session.inject({ method: 'GET', url })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json()).toMatchObject({
    summary: {
      requests: 3,
      successful_requests: 1,
      prompt_tokens: 120,
      completion_tokens: 12,
      tokens: 132,
      errors: 2,
      success_rate: 33.3,
      avg_latency_ms: 200,
      p95_latency_ms: 290,
      active_users: 1,
      active_models: 2,
      cache_read_tokens: 0,
      cache_write_tokens: null,
      cache_read_reported_requests: 1,
    },
    users: [],
    daily_quota_per_user: null,
  })
  expect(response.json().trend).toHaveLength(1)
  expect(response.json().trend[0]).toMatchObject({
    requests: 3,
    tokens: 132,
    errors: 2,
    avg_latency_ms: 200,
  })
  expect(response.json().trend[0].bucket).toMatch(/T00:00:00\+08:00$/)
  const filtered = await session.inject({
    method: 'GET',
    url: url + '?model=alpha&user_id=99999',
  })
  expect(filtered.json().summary).toMatchObject({ requests: 2, tokens: 110 })
  expect(filtered.json().models.tokens).toBe(132)
  expect(filtered.json().models.items.map((item: any) => item.model)).toEqual([
    'alpha',
    'beta',
  ])
  expect(
    filtered.json().filter_options.models.map((item: any) => item.value),
  ).toEqual(['alpha', 'beta', 'reserved-only'])
  const hourly = await session.inject({ method: 'GET', url: url + '?days=1' })
  expect(hourly.json().trend[0].bucket).toMatch(/T\d{2}:00:00\+08:00$/)
  expect(
    (
      await session.inject({ method: 'GET', url: url + '?status=reserved' })
    ).json().summary,
  ).toMatchObject({ requests: 1, tokens: 0 })
  for (const query of ['days=366', 'status=invalid', 'pat_id=0'])
    expect(
      (await session.inject({ method: 'GET', url: url + '?' + query }))
        .statusCode,
    ).toBe(400)
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
})

test('personal analytics keeps full-model denominator beyond top eight and handles empty scope', async () => {
  const key = await setup()
  await handle.db
    .execute(sql`insert into gw_requests (id,key_id,model,protocol,status,reserved_tokens,input_tokens,output_tokens,expires_at)
 select 'stats-'||n,${key.id},'model-'||n,'openai','ok',0,10,0,now() from generate_series(1,10) n`)
  const url = '/api/agent/me/usage/analytics'
  const response = await session.inject({ method: 'GET', url })
  expect(response.json().models).toMatchObject({ tokens: 100 })
  expect(response.json().models.items).toHaveLength(8)
  expect(
    response
      .json()
      .models.items.every((item: any) => item.share_percent === 10),
  ).toBe(true)
  const empty = await session.inject({
    method: 'GET',
    url: url + '?pat_id=99999999',
  })
  expect(empty.json()).toMatchObject({
    summary: {
      requests: 0,
      tokens: 0,
      p95_latency_ms: 0,
      cache_read_tokens: null,
    },
    trend: [],
    models: { tokens: 0, items: [] },
  })
})

test('admin analytics validates user filters and exposes no data without session authorization', async () => {
  const key = await setup()
  await invoke(key.token)
  const url = '/api/admin/agent/usage/analytics'
  for (const query of [
    'user_id=0',
    'user_id=oops',
    'user_id=1.5',
    'days=366',
    'status=invalid',
  ])
    expect(
      (await session.inject({ method: 'GET', url: url + '?' + query }))
        .statusCode,
    ).toBe(400)
  const missing = await session.inject({
    method: 'GET',
    url: url + '?user_id=99999999',
  })
  expect(missing.statusCode).toBe(200)
  expect(missing.json()).toMatchObject({
    summary: { requests: 0, tokens: 0 },
    users: [],
    models: { tokens: 0, items: [] },
  })
  expect(missing.json().filter_options.users).toHaveLength(1)
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
  expect(
    (
      await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${key.token}` },
      })
    ).statusCode,
  ).toBe(401)
})

test('admin usage exposes diagnostics without secrets and preserves list filtering', async () => {
  const key = await setup()
  await invoke(key.token)
  const rows = await service.repo.legacyMineUsage(key.owner_id, {
    days: 7,
    page: 1,
    per_page: 20,
  })
  const id = rows.rows[0]!.row.id
  const account = (await service.repo.upstreams())[0]!
  await service.repo.attempt({
    request_id: id,
    upstream_id: account.id,
    status: 503,
    duration_ms: 1,
  })
  await handle.db.execute(
    sql`update gw_requests set error='账号调用链：fixture internal trace',cache_read_tokens=0,cache_write_tokens=null where id=${id}`,
  )
  const url = '/api/admin/agent/usage'
  const response = await session.inject({
    method: 'GET',
    url: url + '?pat_id=' + key.id,
  })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json()).toMatchObject({
    total: 1,
    page: 1,
    per_page: 20,
    items: [
      {
        request_id: id,
        user_id: key.owner_id,
        pat_id: key.id,
        credential_id: account.id,
        credential_name: account.name,
        cache_read_tokens: 0,
        cache_write_tokens: null,
        attempt_count: 2,
        fallback_used: true,
        error_summary: '账号调用链：fixture internal trace',
        upstream_model: 'openai',
        route_id: expect.any(Number),
        route_name: 'public-model',
        provider: 'openai-compatible',
      },
    ],
  })
  for (const field of ['secret', 'digest', 'raw_usage', 'request_context'])
    expect(response.json().items[0]).not.toHaveProperty(field)
  expect(response.body).not.toContain(key.token)
  await handle.db.execute(
    sql`update gw_upstreams set name='Renamed',provider='changed-provider'`,
  )
  await handle.db.execute(
    sql`update gw_routes set upstream_model='changed',model='changed-alias'`,
  )
  const historical = (await session.inject({ method: 'GET', url })).json()
    .items[0]
  expect(historical).toMatchObject({
    credential_name: account.name,
    upstream_model: 'openai',
    route_name: 'public-model',
    provider: 'openai-compatible',
  })
  await handle.db.execute(
    sql`update gw_requests set execution=null where id=${id}`,
  )
  const legacy = (await session.inject({ method: 'GET', url })).json().items[0]
  expect(legacy).toMatchObject({
    credential_name: null,
    upstream_model: null,
    route_id: null,
    provider: null,
    route_name: null,
  })
  const mine = await session.inject({
    method: 'GET',
    url: '/api/agent/me/usage',
  })
  expect(mine.body).not.toContain('fixture internal trace')
  expect(mine.json().items[0]).not.toHaveProperty('credential_name')
  expect(
    (
      await session.inject({ method: 'GET', url: url + '?page=2&per_page=1' })
    ).json(),
  ).toMatchObject({ total: 1, items: [] })
  expect(
    (
      await session.inject({ method: 'GET', url: url + '?model=missing' })
    ).json().total,
  ).toBe(0)
  expect(
    (
      await session.inject({
        method: 'GET',
        url: url + '?status=upstream_error',
      })
    ).json().total,
  ).toBe(0)
  await handle.db.execute(
    sql`update gw_requests set created_at=now()-interval '8 days' where id=${id}`,
  )
  expect((await session.inject({ method: 'GET', url })).json().total).toBe(0)
  expect(
    (await session.inject({ method: 'GET', url: url + '?days=9' })).json()
      .total,
  ).toBe(1)
  for (const query of ['user_id=0', 'pat_id=0', 'days=366', 'status=invalid'])
    expect(
      (await session.inject({ method: 'GET', url: url + '?' + query }))
        .statusCode,
    ).toBe(400)
  expect(
    (
      await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${key.token}` },
      })
    ).statusCode,
  ).toBe(401)
})

test('execution snapshot failure prevents upstream traffic and releases reservation', async () => {
  const key = await setup()
  const failure = vi
    .spyOn(GatewayRepository.prototype, 'recordExecution')
    .mockRejectedValueOnce(new Error('snapshot unavailable'))
  try {
    const result = await invoke(key.token)
    expect(result.statusCode).toBeGreaterThanOrEqual(500)
    expect(calls).toBe(0)
    const row = (await service.repo.listRequests()).items[0]!
    expect(row.status).not.toBe('reserved')
    expect(row.execution).toBeNull()
    expect(
      (await handle.db.execute(sql`select * from gw_upstream_leases`)).rows,
    ).toHaveLength(0)
  } finally {
    failure.mockRestore()
  }
})

test('provider classification is independent of transport and survives omitted update fields', async () => {
  const key = await setup()
  const account = (await service.repo.upstreams())[0]!
  expect(account.provider).toBe('openai-compatible')
  const update = (provider?: string) =>
    session.inject({
      method: 'PUT',
      url: `/api/admin/gateway/upstreams/${account.id}`,
      payload: {
        name: account.name,
        protocol: 'openai',
        base_url: base,
        ...(provider === undefined ? {} : { provider }),
      },
    })
  const saved = await update('  custom-provider  ')
  expect(saved.statusCode, saved.body).toBe(200)
  expect(saved.json()).toMatchObject({
    provider: 'custom-provider',
    protocol: 'openai',
  })
  expect((await update()).json().provider).toBe('custom-provider')
  for (const value of ['', '   ', 'x'.repeat(65)])
    expect((await update(value)).statusCode).toBe(400)
  expect((await invoke(key.token)).statusCode).toBe(200)
  expect(observed.model).toBe('openai')
  const row = (await service.repo.listRequests()).items[0]!
  expect(row.execution).toMatchObject({
    provider: 'custom-provider',
    upstream_protocol: 'openai',
    route_name: 'public-model',
  })
  expect((await service.repo.attempts(row.id))[0]!.execution).toEqual(
    row.execution,
  )
})

test('legacy quota editing preserves rate policy and immediately governs admission', async () => {
  const key = await setup()
  await invoke(key.token)
  await service.saveUserLimits(key.owner_id, {
    daily_limit: 20000,
    concurrency_limit: 7,
    rpm_limit: 80,
  })
  const url = `/api/admin/agent/quotas/${key.owner_id}`
  const put = (daily_token_quota: unknown) =>
    session.inject({ method: 'PUT', url, payload: { daily_token_quota } })
  const limited = await put('13')
  expect(limited.statusCode, limited.body).toBe(200)
  expect(limited.json()).toMatchObject({
    daily_quota: 13,
    quota_override: 13,
    quota_source: 'user',
    used_today: 13,
    remaining: 0,
    usage_percent: 100,
    exhausted: true,
  })
  expect((await invoke(key.token)).statusCode).toBe(429)
  expect((await put(0)).json()).toMatchObject({
    daily_quota: null,
    quota_override: 0,
    quota_source: 'user',
    remaining: null,
  })
  expect((await invoke(key.token)).statusCode).toBe(200)
  expect(await service.repo.userLimits(key.owner_id)).toMatchObject({
    concurrency_limit: 7,
    rpm_limit: 80,
  })
  const listed = await session.inject({
    method: 'GET',
    url: '/api/admin/agent/quotas',
  })
  const item = listed
    .json()
    .items.find((row: any) => row.user_id === key.owner_id)
  expect(item).toMatchObject({
    daily_token_quota: 0,
    effective_quota: null,
    used_today: 26,
    quota_source: 'user',
  })
  expect(Number.isFinite(Date.parse(item.updated_at))).toBe(true)
  expect(item.updated_at).toMatch(/T.*Z$/)
  for (const value of [null, '']) {
    expect((await put(value)).json()).toMatchObject({
      quota_override: null,
      quota_source: 'default',
    })
    expect(await service.repo.userLimits(key.owner_id)).toMatchObject({
      daily_limit: null,
      concurrency_limit: 7,
      rpm_limit: 80,
    })
  }
  const repo = new GatewayRepository(handle.db, 'Asia/Shanghai', 100)
  const withDefault = await listQuotas(repo, { search: item.username })
  expect(withDefault).toMatchObject({
    total: 1,
    default_daily_quota: 100,
    items: [
      {
        effective_quota: 100,
        remaining: 74,
        usage_percent: 26,
        updated_at: null,
      },
    ],
  })
  expect((await listQuotas(repo, { search: 'missing-user' })).items).toEqual([])
  expect(
    (await listQuotas(repo, { page: 2, per_page: 1, search: item.username }))
      .items,
  ).toEqual([])
  expect((await listQuotas(repo, { page: 0, per_page: 999 })).per_page).toBe(
    100,
  )
  for (const value of [-1, 1.5, 1_000_000_001, 'bad', true])
    expect((await put(value)).statusCode).toBe(400)
  expect(
    (await session.inject({ method: 'PUT', url, payload: {} })).statusCode,
  ).toBe(400)
  expect(
    (
      await session.inject({
        method: 'PUT',
        url: '/api/admin/agent/quotas/2147483647',
        payload: { daily_token_quota: 1 },
      })
    ).statusCode,
  ).toBe(404)
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/admin/agent/quotas',
        headers: { authorization: `Bearer ${key.token}` },
      })
    ).statusCode,
  ).toBe(401)
  expect(
    (
      await app.inject({
        method: 'PUT',
        url,
        cookies: { coati_session: session.cookie },
        payload: { daily_token_quota: 0 },
      })
    ).statusCode,
  ).toBe(403)
})

test('administrator request detail preserves full usage and immutable execution with session protection', async () => {
  const key = await setup()
  await invoke(key.token)
  const row = (await service.repo.listRequests()).items[0]!
  const url = `/api/admin/gateway/requests/${row.id}`
  const response = await session.inject({ method: 'GET', url })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json()).toMatchObject({
    id: row.id,
    input_tokens: 10,
    output_tokens: 3,
    execution: { upstream_model: 'openai', route_name: 'public-model' },
    raw_usage: expect.any(Object),
  })
  expect(response.body).not.toContain('secret-test-key')
  expect(response.body).not.toContain(key.token)
  await handle.db.execute(
    sql`update gw_requests set status='interrupted' where id=${row.id}`,
  )
  const interrupted = await session.inject({
    method: 'GET',
    url: '/api/admin/agent/usage?status=interrupted',
  })
  expect(interrupted.statusCode).toBe(200)
  expect(interrupted.json().items[0].id).toBe(row.id)
  expect(
    (
      await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${key.token}` },
      })
    ).statusCode,
  ).toBe(401)
  expect(
    (
      await session.inject({
        method: 'GET',
        url: '/api/admin/gateway/requests/00000000-0000-4000-8000-000000000000',
      })
    ).statusCode,
  ).toBe(404)
  expect(
    (
      await session.inject({
        method: 'GET',
        url: '/api/admin/gateway/requests/not-a-uuid',
      })
    ).statusCode,
  ).toBe(400)
})

test('route override preserves optional fields and sends to the same-origin alternate path', async () => {
  const key = await setup()
  const route = (await service.repo.routes())[0]!
  const payload = {
    model: route.model,
    upstream_id: route.upstream_id,
    upstream_model: route.upstream_model,
  }
  const update = (extra: object) =>
    session.inject({
      method: 'PUT',
      url: `/api/admin/gateway/routes/${route.id}`,
      payload: { ...payload, ...extra },
    })
  const saved = await update({
    description: '  alternate path  ',
    upstream_base: `${base}/alternate/`,
  })
  expect(saved.statusCode, saved.body).toBe(200)
  expect(saved.json()).toMatchObject({
    description: 'alternate path',
    upstream_base: `${base}/alternate`,
  })
  expect((await update({})).json()).toMatchObject({
    description: 'alternate path',
    upstream_base: `${base}/alternate`,
  })
  const send = vi.spyOn(GatewayTransport.prototype, 'send')
  try {
    expect((await invoke(key.token)).statusCode).toBe(200)
    expect(send.mock.calls[0]?.[0]).toBe(`${base}/alternate/chat/completions`)
    expect(calls).toBe(1)
    expect(
      (await update({ description: '', upstream_base: '' })).json(),
    ).toMatchObject({ description: null, upstream_base: null })
    expect((await invoke(key.token)).statusCode).toBe(200)
    expect(send.mock.calls[1]?.[0]).toBe(`${base}/chat/completions`)
  } finally {
    send.mockRestore()
  }
})

test('route override rejects a changed origin or invalid URL before saving', async () => {
  await setup()
  const route = (await service.repo.routes())[0]!
  for (const override of [
    base.replace('127.0.0.1', 'localhost'),
    base.replace('http:', 'https:'),
    'http://127.0.0.1:1/v1',
  ]) {
    const result = await session.inject({
      method: 'PUT',
      url: `/api/admin/gateway/routes/${route.id}`,
      payload: { ...route, upstream_base: override },
    })
    expect(result.statusCode, result.body).toBe(422)
  }
  for (const override of [
    'broken',
    `${base}?token=x`,
    `${base}#x`,
    base.replace('127.0.0.1', 'name:secret@127.0.0.1'),
  ]) {
    const result = await session.inject({
      method: 'PUT',
      url: `/api/admin/gateway/routes/${route.id}`,
      payload: { ...route, upstream_base: override },
    })
    expect(result.statusCode, result.body).toBe(400)
  }
  expect(
    (
      await session.inject({
        method: 'PUT',
        url: `/api/admin/gateway/routes/${route.id}`,
        payload: { ...route, description: 'x'.repeat(256) },
      })
    ).statusCode,
  ).toBe(400)
  expect((await service.repo.routes())[0]!.upstream_base).toBeNull()
  expect(calls).toBe(0)
  expect(
    routeBase(
      'https://example.com:443/v1',
      'https://example.com/custom/',
      false,
    ),
  ).toBe('https://example.com/custom')
})

test('route override revalidates account origin at execution and releases resources without traffic', async () => {
  const key = await setup()
  const route = (await service.repo.routes())[0]!
  await service.saveRoute(
    { ...route, upstream_base: `${base}/alternate` },
    route.id,
  )
  await handle.db.execute(
    sql`update gw_upstreams set base_url='http://127.0.0.1:1/v1' where id=${route.upstream_id}`,
  )
  const send = vi.spyOn(GatewayTransport.prototype, 'send')
  try {
    const result = await invoke(key.token)
    expect(result.statusCode, result.body).toBe(422)
    expect(send).not.toHaveBeenCalled()
    expect(calls).toBe(0)
    const row = (await service.repo.listRequests()).items[0]!
    expect(row.status).not.toBe('reserved')
    expect(row.execution).toBeNull()
    expect(
      (await handle.db.execute(sql`select * from gw_upstream_leases`)).rows,
    ).toHaveLength(0)
  } finally {
    send.mockRestore()
  }
})

test('account model declarations preserve defaults, normalize duplicates, and survive omitted updates', async () => {
  await setup()
  const account = (await service.repo.upstreams())[0]!
  const update = (extra: object) =>
    session.inject({
      method: 'PUT',
      url: `/api/admin/gateway/upstreams/${account.id}`,
      payload: {
        name: account.name,
        protocol: account.protocol,
        base_url: account.base_url,
        ...extra,
      },
    })
  expect(account.supported_models).toEqual([
    'openai',
    'text-target',
    'vision-target',
  ])
  expect(account.default_model).toBe('')
  const saved = await update({
    supported_models: [' text ', 'vision', 'text'],
    default_model: ' default ',
  })
  expect(saved.statusCode, saved.body).toBe(200)
  expect(saved.json()).toMatchObject({
    supported_models: ['default', 'text', 'vision'],
    default_model: 'default',
  })
  expect(saved.body).not.toContain('secret-test-key')
  expect((await update({})).json().supported_models).toEqual([
    'default',
    'text',
    'vision',
  ])
  expect((await service.upstreams())[0]!.supported_models).toEqual([
    'default',
    'text',
    'vision',
  ])
  expect(
    (await update({ supported_models: ['default', 'text'] })).json()
      .supported_models,
  ).toEqual(['default', 'text'])
  expect(
    (await update({ supported_models: [] })).json().supported_models,
  ).toEqual(['default'])
  expect((await update({ default_model: '' })).json().supported_models).toEqual(
    [],
  )
  for (const input of [
    { supported_models: 'text' },
    { supported_models: [4] },
    { default_model: 'x'.repeat(129) },
    { supported_models: ['x'.repeat(129)] },
    { supported_models: Array.from({ length: 51 }, (_, i) => `model-${i}`) },
  ])
    expect((await update(input)).statusCode).toBe(400)
  expect(
    (
      await update({ supported_models: [' ', ...Array(51).fill('same')] })
    ).json().supported_models,
  ).toEqual(['same'])
  expect(
    (await update({ supported_models: null, default_model: null })).json(),
  ).toMatchObject({ supported_models: [], default_model: '' })
  expect(
    (await update({ supported_models: '' })).json().supported_models,
  ).toEqual([])
})

test('account model discovery never changes administrator declarations', async () => {
  await setup()
  const account = (await service.repo.upstreams())[0]!
  await service.saveUpstream(
    {
      ...account,
      api_key: 'secret-test-key',
      supported_models: ['configured'],
      default_model: 'chosen',
    },
    account.id,
  )
  const probe = await service.probeUpstream(account.id)
  expect(probe.models).toEqual(['fixture-a', 'fixture-b'])
  const stored = (await service.repo.upstreams())[0]!
  expect(stored.supported_models).toEqual(['configured'])
  expect(stored.default_model).toBe('chosen')
})

test('account models migration backfills actual and vision models without inventing a default', async () => {
  const migration = readFileSync(
    new URL('../drizzle/0024_gateway_account_models.sql', import.meta.url),
    'utf8',
  )
  await handle.db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`CREATE TEMP TABLE gw_upstreams (id integer primary key) ON COMMIT DROP;
      CREATE TEMP TABLE gw_routes (upstream_id integer, upstream_model text, vision_model text, enabled boolean) ON COMMIT DROP;
      INSERT INTO gw_upstreams VALUES (1),(2);
      INSERT INTO gw_routes VALUES (1,'text','vision',true),(1,'text','',true),(1,' retired ',null,false);`),
    )
    for (const statement of migration.split('--> statement-breakpoint'))
      await tx.execute(sql.raw(statement))
    const rows = (await tx.execute(sql`select * from gw_upstreams order by id`))
      .rows
    expect(rows).toEqual([
      {
        id: 1,
        supported_models: ['retired', 'text', 'vision'],
        default_model: '',
      },
      { id: 2, supported_models: [], default_model: '' },
    ])
  })
})

test('route model validation requires declared actual and vision models and an enabled binding', async () => {
  await setup()
  const route = (await service.repo.routes())[0]!
  const update = (extra: object) =>
    session.inject({
      method: 'PUT',
      url: `/api/admin/gateway/routes/${route.id}`,
      payload: { ...route, ...extra },
    })
  expect((await update({ upstream_model: 'undeclared' })).statusCode).toBe(422)
  expect((await update({ vision_model: 'undeclared' })).statusCode).toBe(422)
  await handle.db.execute(
    sql`update gw_upstreams set supported_models='[]',default_model='default-only' where id=${route.upstream_id}`,
  )
  expect((await update({ upstream_model: 'default-only' })).statusCode).toBe(
    200,
  )
  await handle.db.execute(
    sql`update gw_upstreams set enabled=false where id=${route.upstream_id}`,
  )
  expect((await update({ upstream_model: 'default-only' })).statusCode).toBe(
    422,
  )
  expect(
    (await update({ upstream_model: 'default-only', enabled: false }))
      .statusCode,
  ).toBe(200)
  expect(calls).toBe(0)
})

test('empty account declaration is not a wildcard and default-only models remain eligible', async () => {
  const key = await setup()
  await handle.db.execute(
    sql`update gw_upstreams set supported_models='[]',default_model=''`,
  )
  const rejected = await invoke(key.token)
  expect(rejected.statusCode, rejected.body).toBe(422)
  expect(rejected.body).toContain('unsupported_upstream_model')
  expect(calls).toBe(0)
  await handle.db.execute(sql`update gw_upstreams set default_model='openai'`)
  expect((await invoke(key.token)).statusCode).toBe(200)
  expect(calls).toBe(1)
})

test('model declaration changes after reservation block transport and release resources', async () => {
  const key = await setup()
  const original = GatewayRepository.prototype.reserve
  const spy = vi
    .spyOn(GatewayRepository.prototype, 'reserve')
    .mockImplementation(async function (this: GatewayRepository, ...args) {
      const reserved = await original.apply(this, args)
      await handle.db.execute(
        sql`update gw_upstreams set supported_models='[]',default_model=''`,
      )
      return reserved
    })
  try {
    expect((await invoke(key.token)).statusCode).toBe(503)
    expect(calls).toBe(0)
    const row = (await service.repo.listRequests()).items[0]!
    expect(row).toMatchObject({
      status: 'routing_error',
      input_tokens: 0,
      output_tokens: 0,
      execution: null,
    })
    expect(await service.repo.attempts(row.id)).toHaveLength(0)
    expect(
      (await handle.db.execute(sql`select * from gw_upstream_leases`)).rows,
    ).toHaveLength(0)
  } finally {
    spy.mockRestore()
  }
})

test('candidate filtering skips an account that no longer declares the wire model', async () => {
  const key = await setup()
  const route = (await service.repo.routes())[0]!
  const account = (await service.repo.upstreams())[0]!
  const second = await service.repo.saveUpstream({
    ...account,
    id: undefined,
    name: 'declared backup',
  })
  await service.repo.saveRoute({
    ...route,
    id: undefined,
    upstream_id: second!.id,
    priority: 200,
  })
  await handle.db.execute(
    sql`update gw_upstreams set supported_models='[]',default_model='' where id=${account.id}`,
  )
  expect((await invoke(key.token)).statusCode).toBe(200)
  expect(calls).toBe(1)
  const row = (await service.repo.listRequests()).items[0]!
  expect(row.execution?.upstream_id).toBe(second!.id)
  expect(await service.repo.attempts(row.id)).toHaveLength(1)
})

test.each([
  'models',
  'disabled',
  'cooldown',
  'route-disabled',
  'vision',
] as const)(
  'session binding reselects after %s changes during reservation',
  async (change) => {
    const key = await setup()
    const route = (await service.repo.routes())[0]!
    const account = (await service.repo.upstreams())[0]!
    const second = await service.repo.saveUpstream({
      ...account,
      id: undefined,
      name: 'live fallback',
    })
    await service.repo.saveRoute({
      ...route,
      id: undefined,
      upstream_id: second!.id,
      priority: 200,
    })
    if (change === 'vision') {
      await handle.db.execute(
        sql`update gw_routes set model='coati-auto',vision_model='vision-target'`,
      )
      await handle.db.execute(sql`update gw_keys set models='["coati-auto"]'`)
    }
    const call = () =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${key.token}`,
          'x-coati-session-id': 'declaration-race',
        },
        payload:
          change === 'vision'
            ? {
                model: 'coati-auto',
                messages: [
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'image_url',
                        image_url: { url: 'https://example.invalid/image.png' },
                      },
                    ],
                  },
                ],
              }
            : { model: 'public-model' },
      })
    expect((await call()).statusCode).toBe(200)
    expect(
      (
        await handle.db.execute(
          sql`select upstream_id from gw_session_bindings`,
        )
      ).rows[0]!.upstream_id,
    ).toBe(account.id)
    calls = 0
    const original = GatewayRepository.prototype.reserve
    const spy = vi
      .spyOn(GatewayRepository.prototype, 'reserve')
      .mockImplementation(async function (this: GatewayRepository, ...args) {
        const result = await original.apply(this, args)
        if (change === 'models')
          await handle.db.execute(
            sql`update gw_upstreams set supported_models='[]',default_model='' where id=${account.id}`,
          )
        if (change === 'disabled')
          await handle.db.execute(
            sql`update gw_upstreams set enabled=false where id=${account.id}`,
          )
        if (change === 'cooldown')
          await handle.db.execute(
            sql`update gw_upstreams set cooldown_until=now()+interval '1 minute' where id=${account.id}`,
          )
        if (change === 'route-disabled')
          await handle.db.execute(
            sql`update gw_routes set enabled=false where id=${route.id}`,
          )
        if (change === 'vision')
          await handle.db.execute(
            sql`update gw_routes set vision_model=null where id=${route.id}`,
          )
        return result
      })
    try {
      const result = await call()
      expect(result.statusCode, result.body).toBe(200)
      expect(calls).toBe(1)
      expect(
        (
          await handle.db.execute(
            sql`select upstream_id from gw_session_bindings`,
          )
        ).rows[0]!.upstream_id,
      ).toBe(second!.id)
      expect(
        (await handle.db.execute(sql`select * from gw_upstream_leases`)).rows,
      ).toHaveLength(0)
      const row = (await service.repo.listRequests()).items[0]!
      expect(row.execution?.upstream_id).toBe(second!.id)
      expect(await service.repo.attempts(row.id)).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  },
)

async function configurePublicPool(
  bound: boolean,
  fallback = false,
  override = false,
) {
  const key = await setup()
  const account = (await service.repo.upstreams())[0]!
  const backup = await service.repo.saveUpstream({
    ...account,
    id: undefined,
    name: 'pool backup',
    priority: 900,
  })
  const response = await session.inject({
    method: 'POST',
    url: '/api/admin/gateway/public-routes',
    payload: {
      model: 'pool-alias',
      upstream_model: 'openai',
      upstream_id: bound ? account.id : null,
      fallback_enabled: fallback,
      upstream_base: override ? `${base}/alternate` : null,
    },
  })
  expect(response.statusCode, response.body).toBe(201)
  await handle.db.execute(
    sql`update gw_keys set models='["pool-alias"]' where id=${key.id}`,
  )
  return { key, account, backup: backup!, route: response.json() }
}

test('public automatic pool selects by declared wire model and descending account priority', async () => {
  const { key, backup, account } = await configurePublicPool(false)
  const result = await invoke(key.token, { model: 'pool-alias' })
  expect(result.statusCode, result.body).toBe(200)
  expect(observed.model).toBe('openai')
  expect((await service.repo.listRequests()).items[0]!.execution).toMatchObject(
    { route_kind: 'public', upstream_id: backup.id, upstream_model: 'openai' },
  )
  expect(calls).toBe(1)
  await handle.db.execute(sql`update gw_upstreams set last_error_at=clock_timestamp(),health_status='unhealthy' where id=${backup.id}`)
  expect((await invoke(key.token, {model:'pool-alias'})).statusCode).toBe(200)
  const latest=(await handle.db.execute(sql`select upstream_id from gw_attempts order by id desc limit 1`)).rows[0]
  expect(latest!.upstream_id).toBe(account.id)
  await handle.db.execute(sql`update gw_upstreams set last_error_at=clock_timestamp(),health_status='unhealthy'`)
  expect((await invoke(key.token, {model:'pool-alias'})).statusCode).toBe(200)
  const models = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: { authorization: `Bearer ${key.token}` },
  })
  expect(models.body).toContain('pool-alias')
})

test.each([false, true])(
  'public bound pool fallback=%s keeps primary first and honors the switch',
  async (fallback) => {
    const { key, account, backup } = await configurePublicPool(
      true,
      fallback,
      true,
    )
    await handle.db.execute(sql`update gw_upstreams set priority=10000 where id=${backup.id}`)
    behavior = 'fail-once'
    const send = vi.spyOn(GatewayTransport.prototype, 'send')
    try {
      const result = await invoke(key.token, { model: 'pool-alias' })
      expect(result.statusCode, result.body).toBe(fallback ? 200 : 503)
      expect(calls).toBe(fallback ? 2 : 1)
      expect(send.mock.calls[0]![0]).toBe(`${base}/alternate/chat/completions`)
      if (fallback)
        expect(send.mock.calls[1]![0]).toBe(`${base}/chat/completions`)
      const row = (await service.repo.listRequests()).items[0]!
      const attempts = await service.repo.attempts(row.id)
      expect(attempts.map((a) => a.upstream_id).sort()).toEqual(
        (fallback ? [account.id, backup.id] : [account.id]).sort(),
      )
      expect(row.execution?.upstream_id).toBe(fallback ? backup.id : account.id)
    } finally {
      send.mockRestore()
    }
  },
)

test.each([false, true])(
  'public bound pool fallback=%s handles an unavailable primary',
  async (fallback) => {
    const { key, account, backup } = await configurePublicPool(true, fallback)
    await handle.db.execute(
      sql`update gw_upstreams set enabled=false where id=${account.id}`,
    )
    const result = await invoke(key.token, { model: 'pool-alias' })
    expect(result.statusCode, result.body).toBe(fallback ? 200 : 503)
    expect(calls).toBe(fallback ? 1 : 0)
    if (fallback)
      expect(
        (await service.repo.listRequests()).items[0]!.execution?.upstream_id,
      ).toBe(backup.id)
  },
)

test('public pool rechecks a fallback switch changed after reservation', async () => {
  const { key, route } = await configurePublicPool(true, true)
  behavior = 'fail-once'
  const original = GatewayRepository.prototype.reserve
  const spy = vi
    .spyOn(GatewayRepository.prototype, 'reserve')
    .mockImplementation(async function (this: GatewayRepository, ...args) {
      const value = await original.apply(this, args)
      await handle.db.execute(
        sql`update gw_public_routes set fallback_enabled=false where id=${route.id}`,
      )
      return value
    })
  try {
    expect((await invoke(key.token, { model: 'pool-alias' })).statusCode).toBe(
      503,
    )
    expect(calls).toBe(1)
    expect(
      (await handle.db.execute(sql`select * from gw_upstream_leases`)).rows,
    ).toHaveLength(0)
    expect((await service.repo.listRequests()).items[0]!.status).not.toBe(
      'reserved',
    )
  } finally {
    spy.mockRestore()
  }
})

test('public route administration preserves alias uniqueness and requires disabling before deletion', async () => {
  const { route, account } = await configurePublicPool(false)
  const post = (body: object) =>
    session.inject({
      method: 'POST',
      url: '/api/admin/gateway/public-routes',
      payload: body,
    })
  expect((await post({ model: 'pool-alias' })).statusCode).toBe(409)
  expect((await post({ model: 'public-model' })).statusCode).toBe(409)
  expect(
    (await post({ model: 'invalid-override', upstream_base: base })).statusCode,
  ).toBe(422)
  expect(
    (
      await post({
        model: 'unsupported',
        upstream_id: account.id,
        upstream_model: 'unknown',
      })
    ).statusCode,
  ).toBe(422)
  expect(
    (
      await session.inject({
        method: 'POST',
        url: '/api/admin/gateway/routes',
        payload: {
          model: 'pool-alias',
          upstream_id: account.id,
          upstream_model: 'openai',
        },
      })
    ).statusCode,
  ).toBe(409)
  const url = `/api/admin/gateway/public-routes/${route.id}`
  expect((await session.inject({ method: 'DELETE', url })).statusCode).toBe(409)
  expect(
    (await session.inject({ method: 'PUT', url, payload: { enabled: false } }))
      .statusCode,
  ).toBe(200)
  expect((await session.inject({ method: 'DELETE', url })).statusCode).toBe(200)
  expect(
    (await session.inject({ method: 'PUT', url, payload: { enabled: true } }))
      .statusCode,
  ).toBe(404)
})

test('public automatic pool invalidates stale affinity during reservation', async () => {
  const { key, backup, account } = await configurePublicPool(false)
  const call = () =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${key.token}`,
        'x-coati-session-id': 'public-pool-session',
      },
      payload: { model: 'pool-alias' },
    })
  expect((await call()).statusCode).toBe(200)
  expect(
    (await handle.db.execute(sql`select upstream_id from gw_session_bindings`))
      .rows[0]!.upstream_id,
  ).toBe(backup.id)
  calls = 0
  const original = GatewayRepository.prototype.reserve
  const spy = vi
    .spyOn(GatewayRepository.prototype, 'reserve')
    .mockImplementation(async function (this: GatewayRepository, ...args) {
      const result = await original.apply(this, args)
      await handle.db.execute(
        sql`update gw_upstreams set supported_models='[]' where id=${backup.id}`,
      )
      return result
    })
  try {
    expect((await call()).statusCode).toBe(200)
    expect(calls).toBe(1)
    expect(
      (
        await handle.db.execute(
          sql`select upstream_id from gw_session_bindings`,
        )
      ).rows[0]!.upstream_id,
    ).toBe(account.id)
    expect(
      (await handle.db.execute(sql`select * from gw_upstream_leases`)).rows,
    ).toHaveLength(0)
  } finally {
    spy.mockRestore()
  }
})

const preflightUrl = '/api/admin/gateway/route-migration/preflight'
test('route migration preflight is read only and proposes a closed single-account route', async () => {
  const empty = await session.inject({ method: 'GET', url: preflightUrl })
  expect(empty.json()).toMatchObject({
    read_only: true,
    items: [],
    summary: { total: 0 },
  })
  const key = await setup()
  const before = await service.repo.routeMigrationSnapshot()
  const result = await session.inject({ method: 'GET', url: preflightUrl })
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json()).toMatchObject({
    schema_version: 1,
    read_only: true,
    summary: { total: 1, ready_for_review: 1, manual_review: 0, blocked: 0 },
  })
  expect(result.json().items[0]).toMatchObject({
    model: 'public-model',
    status: 'ready_for_review',
    source_ids: [before.routes[0]!.id],
    reasons: [],
    proposal: {
      model: 'public-model',
      upstream_id: before.accounts[0]!.id,
      upstream_model: 'openai',
      fallback_enabled: false,
      enabled: true,
    },
  })
  expect(result.body).not.toContain('secret-test-key')
  expect(JSON.stringify(before.accounts)).not.toMatch(/secret|probe_token/)
  expect(await service.repo.routeMigrationSnapshot()).toEqual(before)
  expect(
    (await session.inject({ method: 'GET', url: preflightUrl })).json(),
  ).toEqual(result.json())
  expect(
    (await app.inject({ method: 'GET', url: preflightUrl })).statusCode,
  ).toBe(401)
  expect(
    (
      await app.inject({
        method: 'GET',
        url: preflightUrl,
        headers: { authorization: `Bearer ${key.token}` },
      })
    ).statusCode,
  ).toBe(401)
  expect(calls).toBe(0)
})

test('route migration fingerprint changes with configuration but not secrets or temporary health', async () => {
  await setup()
  const version = async () =>
    (await service.routeMigrationPreflight()).items[0]!.version
  const initial = await version()
  await handle.db.execute(
    sql`update gw_upstreams set secret='rotated-test-ciphertext', cooldown_until=now()+interval '1 hour'`,
  )
  expect(await version()).toBe(initial)
  await handle.db.execute(
    sql`update gw_upstreams set supported_models='["openai", "new-model"]'::jsonb`,
  )
  const changed = await version()
  expect(changed).not.toBe(initial)
  await handle.db.execute(
    sql`update gw_routes set description='changed during review'`,
  )
  expect(await version()).not.toBe(changed)
  expect(calls).toBe(0)
})

test('route migration preflight reports candidate ordering, target, override and expanded-pool differences', async () => {
  await setup()
  const account = (await service.repo.upstreams())[0]!
  for (const name of ['second-candidate', 'outside-candidate-set']) {
    const response = await session.inject({
      method: 'POST',
      url: '/api/admin/gateway/upstreams',
      payload: {
        name,
        protocol: 'openai',
        base_url: base,
        api_key: 'private-fixture',
        supported_models: ['openai', 'text-target'],
      },
    })
    expect(response.statusCode).toBe(201)
    if (name === 'second-candidate') {
      const route = await session.inject({
        method: 'POST',
        url: '/api/admin/gateway/routes',
        payload: {
          model: 'public-model',
          upstream_id: response.json().id,
          upstream_model: 'text-target',
          upstream_base: base + '/alternate',
        },
      })
      expect(route.statusCode, route.body).toBe(201)
    }
  }
  const report = await service.routeMigrationPreflight()
  expect(report.summary).toMatchObject({ manual_review: 1, blocked: 0 })
  const item = report.items[0]!
  expect(item.proposal).toBeNull()
  expect(item.candidates).toHaveLength(2)
  expect(item.candidates[0]!.account_id).toBe(account.id)
  expect(item.reasons.map((reason) => reason.code)).toEqual([
    'multiple_candidates',
    'different_targets',
    'candidate_overrides',
    'expanded_pool',
  ])
  expect(item.additional_accounts).toEqual([
    expect.objectContaining({ name: 'outside-candidate-set' }),
  ])
  expect(JSON.stringify(report)).not.toContain('private-fixture')
  expect(await service.repo.publicRoutes()).toEqual([])
})

test.each(['unsupported', 'disabled', 'override', 'length', 'conflict'])(
  'route migration preflight blocks invalid legacy configuration: %s',
  async (kind) => {
    await setup()
    const codes = {
      unsupported: 'unsupported_target',
      disabled: 'disabled_binding',
      override: 'invalid_override',
      length: 'invalid_public_shape',
      conflict: 'alias_conflict',
    }
    if (kind === 'unsupported')
      await handle.db.execute(
        sql`update gw_upstreams set supported_models='[]'::jsonb, default_model=''`,
      )
    if (kind === 'disabled')
      await handle.db.execute(sql`update gw_upstreams set enabled=false`)
    if (kind === 'override')
      await handle.db.execute(
        sql`update gw_routes set upstream_base='https://username:private-password@example.invalid/v1'`,
      )
    if (kind === 'length')
      await handle.db.execute(
        sql`update gw_routes set model=${'x'.repeat(129)}`,
      )
    if (kind === 'conflict')
      await handle.db.execute(
        sql`insert into gw_public_routes (model,enabled) values ('public-model',false)`,
      )
    const response = await session.inject({ method: 'GET', url: preflightUrl })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().items[0]).toMatchObject({
      status: 'blocked',
      proposal: null,
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: codes[kind as keyof typeof codes] }),
      ]),
    })
    expect(response.body).not.toContain('private-password')
    expect(calls).toBe(0)
  },
)

async function migrationProposal() {
  const response = await session.inject({ method: 'GET', url: preflightUrl })
  expect(response.statusCode).toBe(200)
  const { model, version } = response.json().items[0]
  return { model, version }
}
const applyMigration = (payload: object) =>
  session.inject({
    method: 'POST',
    url: '/api/admin/gateway/route-migration/apply',
    payload,
  })
const rollbackMigration = (id: string) =>
  session.inject({
    method: 'POST',
    url: `/api/admin/gateway/route-migration/${id}/rollback`,
    payload: {},
  })

test('route migration round trip retains IDs, history, model access and accounting', async () => {
  const key = await setup()
  expect((await invoke(key.token)).statusCode).toBe(200)
  const original = await service.repo.routes()
  const proposal = await migrationProposal()
  const applied = await applyMigration(proposal)
  expect(applied.statusCode, applied.body).toBe(200)
  const journal = applied.json()
  expect(journal.source_routes).toEqual(original)
  expect(journal.public_route).toMatchObject({
    model: 'public-model',
    upstream_id: original[0]!.upstream_id,
    fallback_enabled: false,
  })
  expect(journal.actor_id).toBe(key.owner_id)
  expect(applied.body).not.toContain('secret-test-key')
  expect(await service.repo.routes()).toEqual([])
  expect((await invoke(key.token)).statusCode).toBe(200)
  const second = await applyMigration(proposal)
  expect(second.statusCode).toBe(200)
  expect(second.json().id).toBe(journal.id)
  const history = await session.inject({
    method: 'GET',
    url: '/api/admin/gateway/route-migration/history',
  })
  expect(history.json().items).toHaveLength(1)
  const reverted = await rollbackMigration(journal.id)
  expect(reverted.statusCode, reverted.body).toBe(200)
  expect(reverted.json().rolled_back_at).toBeTruthy()
  expect(reverted.json().rolled_back_by).toBe(key.owner_id)
  expect(await service.repo.routes()).toEqual(original)
  expect(await service.repo.publicRoutes()).toEqual([])
  expect((await rollbackMigration(journal.id)).json()).toEqual(reverted.json())
  expect((await invoke(key.token)).statusCode).toBe(200)
  const logs = (await service.repo.listRequests()).items
  expect(logs).toHaveLength(3)
  expect(
    logs.every(
      (row) =>
        row.status === 'ok' &&
        row.input_tokens === 10 &&
        row.output_tokens === 3,
    ),
  ).toBe(true)
  expect(logs.map((row) => row.execution?.route_kind).sort()).toEqual([
    'explicit',
    'explicit',
    'public',
  ])
  const reapplied = await applyMigration(await migrationProposal())
  expect(reapplied.statusCode).toBe(200)
  expect(reapplied.json().id).not.toBe(journal.id)
})

test('route migration rejects stale fingerprints and manual candidates without changing configuration', async () => {
  await setup()
  const proposal = await migrationProposal()
  await handle.db.execute(
    sql`update gw_routes set description='changed after preflight'`,
  )
  expect((await applyMigration(proposal)).statusCode).toBe(409)
  const account = (await service.repo.upstreams())[0]!
  await service.repo.saveRoute({
    model: 'public-model',
    upstream_id: account.id,
    upstream_model: 'openai',
    priority: 200,
  })
  const manual = await migrationProposal()
  expect((await applyMigration(manual)).statusCode).toBe(409)
  expect(await service.repo.publicRoutes()).toEqual([])
  expect(await service.repo.routeMigrations()).toEqual([])
  expect(await service.repo.routes()).toHaveLength(2)
})

test.each(['edit', 'delete', 'id-conflict'])(
  'route migration rollback refuses changed destination: %s',
  async (kind) => {
    await setup()
    const applied = (await applyMigration(await migrationProposal())).json()
    if (kind === 'edit')
      await handle.db.execute(
        sql`update gw_public_routes set description='later user change'`,
      )
    if (kind === 'delete')
      await handle.db.execute(sql`delete from gw_public_routes`)
    if (kind === 'id-conflict')
      await handle.db.execute(
        sql`insert into gw_routes (id, model, upstream_id, upstream_model) values (${applied.source_routes[0].id},'other-alias',${applied.source_routes[0].upstream_id},'openai')`,
      )
    const before = await service.repo.routeMigrationSnapshot()
    expect((await rollbackMigration(applied.id)).statusCode).toBe(409)
    expect(await service.repo.routeMigrationSnapshot()).toEqual(before)
    expect((await service.repo.routeMigrations())[0]!.rolled_back_at).toBeNull()
  },
)

test('route migration concurrent duplicate submissions create one archive and rollback once', async () => {
  await setup()
  const proposal = await migrationProposal()
  const results = await Promise.all([
    applyMigration(proposal),
    applyMigration(proposal),
  ])
  expect(results.map((response) => response.statusCode)).toEqual([200, 200])
  expect(results[0]!.json().id).toBe(results[1]!.json().id)
  expect(await service.repo.routeMigrations()).toHaveLength(1)
  expect(await service.repo.publicRoutes()).toHaveLength(1)
  const rollbacks = await Promise.all([
    rollbackMigration(results[0]!.json().id),
    rollbackMigration(results[0]!.json().id),
  ])
  expect(rollbacks.map((response) => response.statusCode)).toEqual([200, 200])
  expect(await service.repo.routes()).toHaveLength(1)
  expect(await service.repo.publicRoutes()).toHaveLength(0)
})

test('route migration reports lock contention as retryable conflict and performs no partial write', async () => {
  await setup()
  const proposal = await migrationProposal()
  const connection = await handle.pool.connect()
  try {
    await connection.query('begin')
    await connection.query('lock table gw_upstreams in row exclusive mode')
    const response = await applyMigration(proposal)
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error).toBeTruthy()
  } finally {
    await connection.query('rollback')
    connection.release()
  }
  expect(await service.repo.routeMigrations()).toEqual([])
  expect(await service.repo.publicRoutes()).toEqual([])
  expect(await service.repo.routes()).toHaveLength(1)
})

test('route migration validates payloads and requires browser CSRF on writes', async () => {
  const key = await setup()
  expect(
    (await applyMigration({ model: 'public-model', version: 'bad' }))
      .statusCode,
  ).toBe(400)
  expect((await rollbackMigration('invalid')).statusCode).toBe(400)
  expect(
    (await rollbackMigration('00000000-0000-4000-8000-000000000000'))
      .statusCode,
  ).toBe(404)
  const proposal = await migrationProposal()
  // Use the already-authenticated helper's cookie but deliberately remove CSRF.
  const denied = await session.inject({
    method: 'POST',
    url: '/api/admin/gateway/route-migration/apply',
    payload: proposal,
    headers: { 'x-csrf-token': '' },
  })
  expect(denied.statusCode).toBe(403)
  const bearer = await app.inject({
    method: 'POST',
    url: '/api/admin/gateway/route-migration/apply',
    payload: proposal,
    headers: { authorization: `Bearer ${key.token}` },
  })
  expect([401, 403]).toContain(bearer.statusCode)
  expect(await service.repo.routeMigrations()).toEqual([])
})

test('legacy route list filters and paginates public configs while summary remains global', async () => {
  const { route, account } = await configurePublicPool(true)
  await session.inject({
    method: 'POST',
    url: '/api/admin/gateway/public-routes',
    payload: { model: 'auto-z', upstream_model: 'text-target', enabled: false },
  })
  const url = '/api/admin/agent/routes'
  const response = await session.inject({
    method: 'GET',
    url: url + '?search=pool&per_page=1&include_summary=true',
  })
  expect(response.statusCode, response.body).toBe(200)
  const body = response.json()
  expect(body).toMatchObject({
    total: 1,
    page: 1,
    per_page: 1,
    summary: { total: 2, enabled: 1, disabled: 1, attention: 0 },
  })
  expect(body.items[0]).toMatchObject({
    id: route.id,
    model_name: 'pool-alias',
    credential_id: account.id,
    effective_model: 'openai',
    selection_mode: 'bound',
    readiness: 'ready',
    warnings: [],
    credential: {
      id: account.id,
      upstream_protocol: 'openai-chat',
      provider: 'openai-compatible',
    },
    usage_7d: { requests: 0, tokens: 0, last_used_at: null },
  })
  expect(body.items[0].created_at).toMatch(/Z$/)
  expect(body.items[0].updated_at).toMatch(/Z$/)
  expect(response.body).not.toContain('secret-test-key')
  expect(response.body).not.toContain('supported_models')
  const byCredential = await session.inject({
    method: 'GET',
    url: url + `?credential_id=${account.id}&provider=openai-compatible`,
  })
  expect(byCredential.json().total).toBe(1)
  const automatic = await session.inject({
    method: 'GET',
    url: url + '?enabled=off&search=TEXT-TARGET',
  })
  expect(automatic.json()).toMatchObject({
    total: 1,
    items: [
      expect.objectContaining({
        model_name: 'auto-z',
        selection_mode: 'automatic',
        credential: null,
        readiness: 'ready',
      }),
    ],
  })
  expect(automatic.json().summary).toBeUndefined()
  const paging = await session.inject({
    method: 'GET',
    url: url + '?page=2&per_page=1',
  })
  expect(paging.json().items[0].model_name).toBe('pool-alias')
  expect(
    (
      await session.inject({
        method: 'GET',
        url: url + '?page=nonsense&per_page=9999',
      })
    ).json(),
  ).toMatchObject({ page: 1, per_page: 100 })
  expect(
    (
      await session.inject({ method: 'GET', url: url + '?provider=missing' })
    ).json().total,
  ).toBe(0)
  expect(
    (await session.inject({ method: 'GET', url: url + '?credential_id=abc' }))
      .statusCode,
  ).toBe(400)
})

test('legacy route readiness reflects account state and both declared targets without probing', async () => {
  const { route } = await configurePublicPool(true)
  await handle.db.execute(
    sql`update gw_public_routes set vision_model='missing-vision', updated_at=null where id=${route.id}`,
  )
  await handle.db.execute(
    sql`update gw_upstreams set enabled=false, health_status='cooldown', supported_models='[]'::jsonb, default_model=''`,
  )
  const response = await session.inject({
    method: 'GET',
    url: '/api/admin/agent/routes?include_summary=1',
  })
  expect(response.json()).toMatchObject({
    summary: { attention: 1 },
    items: [
      expect.objectContaining({
        readiness: 'attention',
        updated_at: null,
        warnings: [
          '绑定的 Key 已停用',
          '绑定的 Key 当前cooldown',
          '上游模型不在该 Key 已发现的模型列表中',
          '含图时模型不在该 Key 已发现的模型列表中',
        ],
      }),
    ],
  })
  expect(calls).toBe(0)
})

test('legacy route seven-day usage counts failures but only bills consumed tokens and excludes reservations', async () => {
  const { key } = await configurePublicPool(true)
  for (let i = 0; i < 4; i++)
    expect((await invoke(key.token, { model: 'pool-alias' })).statusCode).toBe(
      200,
    )
  const rows = (await service.repo.listRequests()).items
  await handle.db.execute(
    sql`update gw_requests set status='upstream_error',input_tokens=90,output_tokens=10 where id=${rows[1]!.id}`,
  )
  await handle.db.execute(
    sql`update gw_requests set status='reserved' where id=${rows[2]!.id}`,
  )
  await handle.db.execute(
    sql`update gw_requests set created_at=now()-interval '8 days' where id=${rows[3]!.id}`,
  )
  const response = await session.inject({
    method: 'GET',
    url: '/api/admin/agent/routes',
  })
  expect(response.json().items[0].usage_7d).toMatchObject({
    requests: 2,
    tokens: 13,
  })
  expect(response.json().items[0].usage_7d.last_used_at).toMatch(/Z$/)
})

test('native public-route updates advance legacy updated_at and list is cookie/RBAC protected', async () => {
  const { key, route } = await configurePublicPool(false)
  await handle.db.execute(
    sql`update gw_public_routes set updated_at='2020-01-01' where id=${route.id}`,
  )
  const update = await session.inject({
    method: 'PUT',
    url: `/api/admin/gateway/public-routes/${route.id}`,
    payload: { description: 'updated' },
  })
  expect(update.statusCode).toBe(200)
  const response = await session.inject({
    method: 'GET',
    url: '/api/admin/agent/routes',
  })
  expect(
    new Date(response.json().items[0].updated_at).getUTCFullYear(),
  ).toBeGreaterThan(2020)
  for (const headers of [{}, { authorization: `Bearer ${key.token}` }])
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/admin/agent/routes',
          headers,
        })
      ).statusCode,
    ).toBe(401)
})

test('public route timestamp migration keeps unknown history null and defaults only new records', async () => {
  await handle.db.transaction(async (tx) => {
    await tx.execute(
      sql`create temporary table gw_public_routes (id integer primary key) on commit drop`,
    )
    await tx.execute(sql`insert into gw_public_routes (id) values (1)`)
    const migration = readFileSync(
      new URL('../drizzle/0027_gateway_route_updated_at.sql', import.meta.url),
      'utf8',
    )
    await tx.execute(sql.raw(migration))
    await tx.execute(sql`insert into gw_public_routes (id) values (2)`)
    const rows = (
      await tx.execute(
        sql`select id,updated_at from gw_public_routes order by id`,
      )
    ).rows
    expect(rows[0]!.updated_at).toBeNull()
    expect(rows[1]!.updated_at).toBeTruthy()
  })
})

const legacyRouteUrl = '/api/admin/agent/routes'
const createLegacyRoute = (payload: unknown) =>
  session.inject({
    method: 'POST',
    url: legacyRouteUrl,
    payload: payload as any,
  })
test('legacy route writes normalize defaults and partial updates into the native public configuration', async () => {
  const response = await createLegacyRoute({
    model_name: '  legacy-route  ',
    description: ' note ',
    enabled: 'off',
    fallback_enabled: 'yes',
    credential_id: '',
    ignored: 'discard',
  })
  expect(response.statusCode, response.body).toBe(201)
  const row = response.json()
  expect(Object.keys(row).sort()).toEqual(
    [
      'id',
      'model_name',
      'upstream_base',
      'upstream_model',
      'vision_model',
      'credential_id',
      'description',
      'fallback_enabled',
      'enabled',
      'created_at',
      'updated_at',
    ].sort(),
  )
  expect(row).toMatchObject({
    model_name: 'legacy-route',
    credential_id: null,
    upstream_model: null,
    enabled: false,
    fallback_enabled: true,
    description: 'note',
  })
  const updated = await session.inject({
    method: 'PUT',
    url: `${legacyRouteUrl}/${row.id}`,
    payload: {
      description: ' ',
      fallback_enabled: null,
      enabled: null,
      model_name: 'renamed-route',
      updated_at: '2000-01-01',
      id: 999,
    },
  })
  expect(updated.statusCode, updated.body).toBe(200)
  expect(updated.json()).toMatchObject({
    id: row.id,
    model_name: 'renamed-route',
    description: null,
    fallback_enabled: false,
    enabled: true,
  })
  expect(updated.json().updated_at).not.toBe('2000-01-01')
  const stored = (await service.repo.publicRoutes())[0]!
  expect(stored).toMatchObject({
    model: 'renamed-route',
    description: null,
    enabled: true,
  })
  expect(
    (
      await session.inject({
        method: 'DELETE',
        url: `${legacyRouteUrl}/${row.id}`,
      })
    ).json().error,
  ).toBe('启用中的模型路由不能删除，请先停用后再删除')
  await session.inject({
    method: 'PUT',
    url: `${legacyRouteUrl}/${row.id}`,
    payload: { enabled: false },
  })
  const deleted = await session.inject({
    method: 'DELETE',
    url: `${legacyRouteUrl}/${row.id}`,
  })
  expect(deleted.statusCode).toBe(200)
  expect(deleted.json()).toEqual({ ok: true })
  expect(await service.repo.publicRoutes()).toEqual([])
  expect(
    (
      await session.inject({
        method: 'DELETE',
        url: `${legacyRouteUrl}/${row.id}`,
      })
    ).statusCode,
  ).toBe(404)
  expect(
    (
      await session.inject({
        method: 'PUT',
        url: `${legacyRouteUrl}/${row.id}`,
        payload: {},
      })
    ).statusCode,
  ).toBe(404)
})

test('legacy bound route serves requests through the same runtime and supports clearing overrides', async () => {
  const key = await setup()
  const account = (await service.repo.upstreams())[0]!
  const response = await createLegacyRoute({
    model_name: 'legacy-model',
    credential_id: String(account.id),
    upstream_model: ' openai ',
    vision_model: 'vision-target',
    upstream_base: base + '/alternate///',
    description: 'keep',
    fallback_enabled: 'true',
  })
  expect(response.statusCode, response.body).toBe(201)
  expect(response.json().upstream_base).toBe(base + '/alternate')
  await handle.db.execute(
    sql`update gw_keys set models='["legacy-model"]' where id=${key.id}`,
  )
  expect((await invoke(key.token, { model: 'legacy-model' })).statusCode).toBe(
    200,
  )
  expect(observed.model).toBe('openai')
  const partial = await session.inject({
    method: 'PUT',
    url: `${legacyRouteUrl}/${response.json().id}`,
    payload: { description: null },
  })
  expect(partial.json()).toMatchObject({
    upstream_model: 'openai',
    vision_model: 'vision-target',
    credential_id: account.id,
    fallback_enabled: true,
    description: null,
  })
  const cleared = await session.inject({
    method: 'PUT',
    url: `${legacyRouteUrl}/${response.json().id}`,
    payload: { upstream_base: '', credential_id: null, vision_model: ' ' },
  })
  expect(cleared.json()).toMatchObject({
    upstream_base: null,
    credential_id: null,
    vision_model: null,
  })
  expect(calls).toBe(1)
})

test('legacy route credential validation preserves implicit-target readiness and rejects explicit unsupported models', async () => {
  await setup()
  const account = (await service.repo.upstreams())[0]!
  const implicit = await createLegacyRoute({
    model_name: 'undeclared-alias',
    credential_id: account.id,
  })
  expect(implicit.statusCode, implicit.body).toBe(201)
  const listed = await session.inject({
    method: 'GET',
    url: legacyRouteUrl + '?search=undeclared-alias',
  })
  expect(listed.json().items[0].readiness).toBe('attention')
  expect(
    (
      await createLegacyRoute({
        model_name: 'missing-account',
        credential_id: 999999,
      })
    ).json().error,
  ).toBe('选择的上游凭证不存在')
  const unsupported = await createLegacyRoute({
    model_name: 'explicit-bad',
    credential_id: account.id,
    upstream_model: 'bad',
  })
  expect(unsupported.statusCode).toBe(422)
  expect(unsupported.json().error).toBe(
    '绑定的模型账号不支持实际模型「bad」，请修改模型配置或更换账号',
  )
  const vision = await createLegacyRoute({
    model_name: 'vision-bad',
    credential_id: account.id,
    vision_model: 'bad',
  })
  expect(vision.statusCode).toBe(422)
  await handle.db.execute(sql`update gw_upstreams set enabled=false`)
  expect(
    (
      await createLegacyRoute({
        model_name: 'disabled',
        credential_id: account.id,
      })
    ).statusCode,
  ).toBe(422)
  expect(
    (
      await createLegacyRoute({
        model_name: 'disabled-ok',
        credential_id: account.id,
        enabled: 'no',
      })
    ).statusCode,
  ).toBe(201)
})

test('legacy route duplicate and URL validation keeps account credentials within the original origin', async () => {
  await setup()
  const account = (await service.repo.upstreams())[0]!
  expect(
    (await createLegacyRoute({ model_name: 'duplicate' })).statusCode,
  ).toBe(201)
  const duplicate = await createLegacyRoute({ model_name: 'duplicate' })
  expect(duplicate.statusCode).toBe(409)
  expect(duplicate.json().error).toBe('模型名称已存在')
  expect(
    (await createLegacyRoute({ model_name: 'coati-auto' })).statusCode,
  ).toBe(422)
  expect(
    (
      await createLegacyRoute({
        model_name: 'unbound-url',
        upstream_base: base,
      })
    ).statusCode,
  ).toBe(422)
  expect(
    (
      await createLegacyRoute({
        model_name: 'cross-origin',
        credential_id: account.id,
        upstream_base: 'https://elsewhere.invalid/v1',
      })
    ).statusCode,
  ).toBe(422)
  expect(
    (
      await createLegacyRoute({
        model_name: 'credential-url',
        credential_id: account.id,
        upstream_base: base.replace('://', '://user:password@'),
      })
    ).statusCode,
  ).toBe(400)
  expect(
    (
      await createLegacyRoute({
        model_name: 'bad-url',
        upstream_base: 'file:///tmp/key',
      })
    ).statusCode,
  ).toBe(400)
  expect(
    (await createLegacyRoute({ model_name: 'public-model' })).statusCode,
  ).toBe(409)
  expect(calls).toBe(0)
})

test.each([
  [{}, '模型名称 必填'],
  [{ model_name: 'x'.repeat(129) }, '模型名称 不能超过 128 个字符'],
  [{ model_name: 'x', credential_id: '1.2' }, '上游凭证 必须是整数'],
  [{ model_name: 'x', credential_id: 0 }, '上游凭证 不能小于 1'],
  [
    { model_name: 'x', description: 'x'.repeat(256) },
    '路由说明 不能超过 255 个字符',
  ],
])(
  'legacy route field validation returns Python-compatible messages (%j)',
  async (payload, message) => {
    const result = await createLegacyRoute(payload)
    expect(result.statusCode).toBe(400)
    expect(result.json().error).toBe(message)
  },
)

test('legacy writes reject PATs and missing CSRF and concurrent duplicate creation is atomic', async () => {
  const key = await setup()
  const payload = { model_name: 'concurrent-legacy' }
  expect(
    (
      await app.inject({
        method: 'POST',
        url: legacyRouteUrl,
        payload,
        headers: { authorization: `Bearer ${key.token}` },
      })
    ).statusCode,
  ).toBe(401)
  expect(
    (
      await session.inject({
        method: 'POST',
        url: legacyRouteUrl,
        payload,
        headers: { 'x-csrf-token': '' },
      })
    ).statusCode,
  ).toBe(403)
  const results = await Promise.all([
    createLegacyRoute(payload),
    createLegacyRoute(payload),
  ])
  expect(results.map((row) => row.statusCode).sort()).toEqual([201, 409])
  expect(
    (await service.repo.publicRoutes()).filter(
      (row) => row.model === 'concurrent-legacy',
    ),
  ).toHaveLength(1)
})

async function personalScopeFixture() {
  const secret = service.vault.encrypt('personal-scope-secret')
  const [row] = (
    await handle.db.execute(sql`
    insert into gw_upstreams(name,protocol,base_url,secret,supported_models,scope,owner_user_id,model_prefix)
    values ('personal-private-name','openai',${base},${secret},'["openai"]','personal',${session.userId},'private-prefix') returning id
  `)
  ).rows
  return Number(row!.id)
}

test('personal scope is absent from platform administration, probes and migration account snapshots', async () => {
  await setup()
  const id = await personalScopeFixture()
  const listed = await session.inject({
    method: 'GET',
    url: '/api/admin/gateway/upstreams',
  })
  expect(listed.statusCode).toBe(200)
  expect(listed.body).not.toContain('personal-private-name')
  expect(listed.body).not.toContain('private-prefix')
  expect(
    (await service.repo.routeMigrationSnapshot()).accounts.map((row) => row.id),
  ).not.toContain(id)
  expect(
    (await service.repo.probeCandidates(5, 0)).map((row) => row.id),
  ).not.toContain(id)
  for (const method of ['PUT', 'DELETE', 'POST'] as const) {
    const response = await session.inject({
      method,
      url: `/api/admin/gateway/upstreams/${id}${method === 'POST' ? '/probe' : ''}`,
      ...(method === 'PUT'
        ? {
            payload: {
              name: 'overwrite',
              protocol: 'openai',
              base_url: base,
              api_key: 'replacement',
            },
          }
        : {}),
    })
    expect(response.statusCode, response.body).toBe(404)
  }
  expect(calls).toBe(0)
  expect(
    (
      await handle.db.execute(
        sql`select scope,owner_user_id,enabled,name from gw_upstreams where id=${id}`,
      )
    ).rows,
  ).toEqual([
    {
      scope: 'personal',
      owner_user_id: session.userId,
      enabled: true,
      name: 'personal-private-name',
    },
  ])
})

test('personal scope cannot enter explicit or public platform route bindings', async () => {
  await setup()
  const id = await personalScopeFixture()
  await expect(
    service.repo.saveRoute({
      model: 'invalid-explicit',
      upstream_id: id,
      upstream_model: 'openai',
    }),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    service.repo.savePublicRoute({ model: 'invalid-public', upstream_id: id }),
  ).rejects.toMatchObject({ status: 400 })
  for (const resource of ['routes', 'public-routes']) {
    const response = await session.inject({
      method: 'POST',
      url: `/api/admin/gateway/${resource}`,
      payload: {
        model: 'invalid-' + resource,
        upstream_id: id,
        upstream_model: 'openai',
      },
    })
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400)
    expect(response.statusCode).toBeLessThan(500)
  }
  expect((await service.repo.routes()).map((row) => row.model)).toEqual([
    'public-model',
  ])
  expect(await service.repo.publicRoutes()).toEqual([])
})

test('personal scope is excluded from automatic pool and invalid legacy explicit references', async () => {
  const { key, account, backup, route } = await configurePublicPool(false)
  const id = await personalScopeFixture()
  await handle.db.execute(
    sql`update gw_upstreams set enabled=false where id in (${account.id},${backup.id})`,
  )
  await handle.db.execute(
    sql`insert into gw_routes(model,upstream_id,upstream_model) values('private-leak',${id},'openai')`,
  )
  expect(await service.repo.candidates('pool-alias', true)).toEqual([])
  expect(await service.repo.candidates('private-leak', true)).toEqual([])
  expect(await service.repo.models()).toEqual([])
  expect(
    await service.repo.acquireUpstream(
      route.id,
      'pool-alias',
      'unused',
      new Date(Date.now() + 60000).toISOString(),
      undefined,
      false,
      id,
    ),
  ).toBeNull()
  const response = await invoke(key.token, { model: 'pool-alias' })
  expect(response.statusCode).toBe(503)
  expect(calls).toBe(0)
})

test('personal scope changed after candidate selection cannot acquire a platform lease', async () => {
  await setup()
  const [candidate] = await service.repo.candidates('public-model')
  await handle.db.execute(
    sql`update gw_upstreams set scope='personal',owner_user_id=${session.userId},model_prefix='private' where id=${candidate!.upstream.id}`,
  )
  expect(
    await service.repo.acquireUpstream(
      candidate!.route.id,
      'public-model',
      'unused',
      new Date(Date.now() + 60000).toISOString(),
    ),
  ).toBeNull()
  expect(
    (await handle.db.execute(sql`select * from gw_upstream_leases`)).rows,
  ).toEqual([])
  expect(calls).toBe(0)
})

test('personal scope database constraints reject malformed ownership and preserve existing platform defaults', async () => {
  await setup()
  const account = (await service.repo.upstreams())[0]!
  expect(account).toMatchObject({
    scope: 'platform',
    owner_user_id: null,
    model_prefix: '',
  })
  for (const change of [
    sql`scope='personal'`,
    sql`owner_user_id=${session.userId}`,
    sql`model_prefix='private'`,
    sql`scope='unknown'`,
    sql`scope='personal',owner_user_id=${session.userId},model_prefix='   '`,
  ]) {
    await expect(
      handle.db.execute(
        sql`update gw_upstreams set ${change} where id=${account.id}`,
      ),
    ).rejects.toThrow()
  }
  const id = await personalScopeFixture()
  expect(await service.repo.claimProbe(id, 0)).toBeUndefined()
  const [after] = (
    await handle.db.execute(
      sql`select scope,owner_user_id,model_prefix from gw_upstreams where id=${account.id}`,
    )
  ).rows
  expect(after).toEqual({
    scope: 'platform',
    owner_user_id: null,
    model_prefix: '',
  })
})

async function personalRuntimeSetup(prefix = 'mine') {
  const key = await setup('openai', { models: ['*'] })
  const [account] = await service.repo.upstreams()
  await handle.db.execute(
    sql`update gw_upstreams set scope='personal',owner_user_id=${session.userId},model_prefix=${prefix} where id=${account!.id}`,
  )
  return { key, account: account! }
}

test.each(['mine', 'mine/', 'mine-'])(
  'personal runtime prefix %s resolves declared models without exposing raw targets',
  async (prefix) => {
    const { key } = await personalRuntimeSetup(prefix)
    const model = (/[/-]$/.test(prefix) ? prefix : prefix + '/') + 'openai'
    const result = await invoke(key.token, { model })
    expect(result.statusCode, result.body).toBe(200)
    expect(observed.model).toBe('openai')
    expect(result.json().model).toBe(model)
    expect((await invoke(key.token, { model: 'openai' })).statusCode).toBe(404)
    expect(
      (await invoke(key.token, { model: model + '-undeclared' })).statusCode,
    ).toBe(404)
    expect(calls).toBe(1)
  },
)

test('personal runtime cannot fall back to a platform route when the matched personal pool cools', async () => {
  const { key, account } = await personalRuntimeSetup()
  const platform = await service.repo.saveUpstream({
    ...account,
    id: undefined,
    name: 'platform fallback',
  })
  await service.repo.saveRoute({
    model: 'mine/openai',
    upstream_id: platform!.id,
    upstream_model: 'openai',
  })
  await handle.db.execute(
    sql`update gw_upstreams set cooldown_until=now()+interval '5 minutes' where id=${account.id}`,
  )
  const result = await invoke(key.token, { model: 'mine/openai' })
  expect(result.statusCode, result.body).toBe(503)
  expect(calls).toBe(0)
  expect(
    await service.repo.candidates('mine/openai', false, false, session.userId),
  ).toEqual([])
  expect(
    (
      await service.repo.candidates('mine/openai', true, false, session.userId)
    ).map((row) => row.upstream.id),
  ).toEqual([account.id])
})

test('personal runtime retains model grants and user budget admission before upstream I/O', async () => {
  const { key } = await personalRuntimeSetup()
  await handle.db.execute(
    sql`update gw_keys set models='["different-model"]' where id=${key.id}`,
  )
  expect((await invoke(key.token, { model: 'mine/openai' })).statusCode).toBe(
    403,
  )
  await handle.db.execute(
    sql`update gw_keys set models='["*"]',daily_limit=1 where id=${key.id}`,
  )
  expect((await invoke(key.token, { model: 'mine/openai' })).statusCode).toBe(
    429,
  )
  expect(calls).toBe(0)
})

test('personal runtime owner, prefix and declaration are rechecked at lease acquisition', async () => {
  const { account } = await personalRuntimeSetup()
  expect(
    await service.repo.acquireUpstream(
      account.id,
      'mine/openai',
      'unused',
      new Date(Date.now() + 60000).toISOString(),
      undefined,
      false,
      undefined,
      session.userId + 99999,
    ),
  ).toBeNull()
  await handle.db.execute(
    sql`update gw_upstreams set model_prefix='changed' where id=${account.id}`,
  )
  expect(
    await service.repo.acquireUpstream(
      account.id,
      'mine/openai',
      'unused',
      new Date(Date.now() + 60000).toISOString(),
      undefined,
      false,
      undefined,
      session.userId,
    ),
  ).toBeNull()
  expect(await service.repo.models(session.userId + 99999)).toEqual([])
  expect(
    await service.repo.candidates(
      'changed/openai',
      true,
      false,
      session.userId + 99999,
    ),
  ).toEqual([])
  expect(calls).toBe(0)
})

test('personal runtime isolates identical model names and session IDs between two real owners', async () => {
  const { key, account } = await personalRuntimeSetup()
  const [other] = (
    await handle.db.execute(
      sql`insert into admin_users(username,password_hash) values('personal-runtime-owner','not-a-login-hash') returning id`,
    )
  ).rows
  const owner = Number(other!.id)
  try {
    const [second] = (
      await handle.db.execute(
        sql`insert into gw_upstreams(name,protocol,base_url,secret,supported_models,scope,owner_user_id,model_prefix) select 'other-private','openai',base_url,secret,'["openai"]','personal',${owner},'mine' from gw_upstreams where id=${account.id} returning id`,
      )
    ).rows
    const secondKey = await service.createKey(owner, {
      name: 'personal-runtime-other',
      models: ['mine/openai'],
    })
    for (const token of [key.token, secondKey.token]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${token}`,
          'x-coati-session-id': 'same-session',
        },
        payload: {
          model: 'mine/openai',
          messages: [{ role: 'user', content: 'hello' }],
        },
      })
      expect(response.statusCode, response.body).toBe(200)
    }
    const records = (
      await handle.db.execute(
        sql`select k.owner_id,r.execution->>'upstream_id' as upstream_id from gw_requests r join gw_keys k on k.id=r.key_id order by r.created_at`,
      )
    ).rows
    expect(records).toEqual([
      { owner_id: session.userId, upstream_id: String(account.id) },
      { owner_id: owner, upstream_id: String(second!.id) },
    ])
    const bindings = (
      await handle.db.execute(
        sql`select owner_id,upstream_id from gw_session_bindings order by owner_id`,
      )
    ).rows
    // Python personal affinity is stateless; owner isolation is checked above.
    expect(bindings).toEqual([])
    expect(
      (await service.repo.candidates('mine/openai', true, false, owner)).map(
        (row) => row.upstream.id,
      ),
    ).toEqual([second!.id])
  } finally {
    await handle.db.execute(
      sql`truncate gw_upstreams,gw_keys restart identity cascade`,
    )
    await handle.db.execute(sql`delete from admin_users where id=${owner}`)
  }
})

test('personal runtime retries within the owned pool then reapplies Python stateless affinity', async () => {
  const { key, account } = await personalRuntimeSetup()
  const [backup] = (
    await handle.db.execute(
      sql`insert into gw_upstreams(name,protocol,base_url,secret,supported_models,scope,owner_user_id,model_prefix,priority) select 'personal-backup','openai',base_url,secret,'["openai"]','personal',owner_user_id,'mine',1 from gw_upstreams where id=${account.id} returning id`,
    )
  ).rows
  behavior = 'fail-once'
  for (let index = 0; index < 2; index++) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${key.token}`,
        'x-coati-session-id': 'personal-retry',
      },
      payload: {
        model: 'mine/openai',
        messages: [{ role: 'user', content: 'hello' }],
      },
    })
    expect(response.statusCode, response.body).toBe(200)
  }
  expect(calls).toBe(3)
  expect(
    (
      await handle.db.execute(
        sql`select upstream_id from gw_attempts order by id`,
      )
    ).rows.map((row) => row.upstream_id),
  ).toEqual([account.id, backup!.id, account.id])
  expect(
    (await handle.db.execute(sql`select upstream_id from gw_session_bindings`))
      .rows,
  ).toEqual([])
  expect(
    (await handle.db.execute(sql`select * from gw_upstream_leases`)).rows,
  ).toEqual([])
})

const personalChannelUrl = '/api/admin/gateway/my-channels'
const personalChannelPayload = (name = 'My channel') => ({
  name,
  protocol: 'openai',
  base_url: base,
  api_key: 'personal-api-secret',
  model_prefix: 'mine',
  supported_models: ['openai'],
  default_model: 'openai',
  priority: 200,
  weight: 100,
})

test('personal channel API creates, partially edits and deletes while retaining settled history', async () => {
  const created = await session.inject({
    method: 'POST',
    url: personalChannelUrl,
    payload: personalChannelPayload(),
  })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id
  expect(created.json()).toMatchObject({
    scope: 'personal',
    owner_user_id: session.userId,
    display_models: ['mine/openai'],
    has_secret: true,
  })
  expect(created.body).not.toContain('personal-api-secret')
  expect(created.json().secret).toBeUndefined()
  const persisted = (
    await handle.db.execute(sql`select secret from gw_upstreams where id=${id}`)
  ).rows[0]!.secret
  expect(persisted).not.toBe('personal-api-secret')
  const edits = await Promise.all([
    session.inject({
      method: 'PUT',
      url: `${personalChannelUrl}/${id}`,
      payload: { name: 'Renamed' },
    }),
    session.inject({
      method: 'PUT',
      url: `${personalChannelUrl}/${id}`,
      payload: { priority: 500 },
    }),
  ])
  expect(edits.map((row) => row.statusCode)).toEqual([200, 200])
  const list = await session.inject({
    method: 'GET',
    url: personalChannelUrl + '?search=renamed&per_page=1',
  })
  expect(list.json()).toMatchObject({
    total: 1,
    page: 1,
    per_page: 1,
    limit: 5,
    items: [{ id, name: 'Renamed', priority: 500, weight: 100 }],
  })
  expect(
    (
      await handle.db.execute(
        sql`select secret from gw_upstreams where id=${id}`,
      )
    ).rows[0]!.secret,
  ).toBe(persisted)
  const key = await service.createKey(session.userId, {
    name: 'personal-crud',
    models: ['mine/openai'],
  })
  expect((await invoke(key.token, { model: 'mine/openai' })).statusCode).toBe(
    200,
  )
  expect(
    (
      await session.inject({
        method: 'DELETE',
        url: `${personalChannelUrl}/${id}`,
      })
    ).statusCode,
  ).toBe(409)
  expect(
    (
      await session.inject({
        method: 'PUT',
        url: `${personalChannelUrl}/${id}`,
        payload: { enabled: false },
      })
    ).statusCode,
  ).toBe(200)
  expect(
    (
      await session.inject({
        method: 'DELETE',
        url: `${personalChannelUrl}/${id}`,
      })
    ).json(),
  ).toEqual({ ok: true })
  const attempts = (
    await handle.db.execute(sql`select upstream_id,execution from gw_attempts`)
  ).rows
  expect(attempts).toHaveLength(1)
  expect(attempts[0]).toMatchObject({
    upstream_id: null,
    execution: { upstream_id: id, route_kind: 'personal' },
  })
  expect(
    (
      await handle.db.execute(
        sql`select status,input_tokens,output_tokens from gw_requests`,
      )
    ).rows,
  ).toEqual([{ status: 'ok', input_tokens: '10', output_tokens: '3' }])
  expect(
    (await session.inject({ method: 'GET', url: personalChannelUrl })).json()
      .total,
  ).toBe(0)
})

test('personal channel API enforces five rows under concurrent creation including disabled rows', async () => {
  const results = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      session.inject({
        method: 'POST',
        url: personalChannelUrl,
        payload: {
          ...personalChannelPayload(`parallel-${index}`),
          enabled: false,
        },
      }),
    ),
  )
  expect(results.filter((row) => row.statusCode === 201)).toHaveLength(5)
  expect(results.filter((row) => row.statusCode === 400)).toHaveLength(2)
  const list = (
    await session.inject({
      method: 'GET',
      url: personalChannelUrl + '?enabled=false',
    })
  ).json()
  expect(list.total).toBe(5)
  expect(
    (
      await session.inject({
        method: 'DELETE',
        url: `${personalChannelUrl}/${list.items[0].id}`,
      })
    ).statusCode,
  ).toBe(200)
  expect(
    (
      await session.inject({
        method: 'POST',
        url: personalChannelUrl,
        payload: personalChannelPayload('replacement'),
      })
    ).statusCode,
  ).toBe(201)
})

test.each([
  { scope: 'platform' },
  { owner_user_id: 99999 },
  { model_prefix: ' ' },
  { model_prefix: 'bad prefix' },
  { model_prefix: 'bad\\prefix' },
  { model_prefix: 'a'.repeat(65) },
  { proxy_url: 'socks5://example.test:1080' },
])(
  'personal channel API rejects invalid prefix or unimplemented/untrusted fields %j',
  async (extra) => {
    const response = await session.inject({
      method: 'POST',
      url: personalChannelUrl,
      payload: { ...personalChannelPayload(), ...extra },
    })
    expect(response.statusCode, response.body).toBe(400)
    expect(await service.repo.personalChannelRows(session.userId)).toHaveLength(
      0,
    )
  },
)

test('personal channel API rejects PAT authentication and missing CSRF', async () => {
  const key = await setup()
  expect(
    (
      await app.inject({
        method: 'POST',
        url: personalChannelUrl,
        headers: { authorization: `Bearer ${key.token}` },
        payload: personalChannelPayload(),
      })
    ).statusCode,
  ).toBe(401)
  expect(
    (
      await session.inject({
        method: 'POST',
        url: personalChannelUrl,
        headers: { 'x-csrf-token': '' },
        payload: personalChannelPayload(),
      })
    ).statusCode,
  ).toBe(403)
})

test('personal channel API hides foreign and platform IDs even from another administrator', async () => {
  const key = await setup()
  const platform = (await service.repo.upstreams())[0]!
  const password = 'channel-owner-password'
  const hash = await generatePasswordHash(password, 1000)
  const [other] = (
    await handle.db.execute(
      sql`insert into admin_users(username,password_hash) values('channel-crud-owner',${hash}) returning id`,
    )
  ).rows
  const owner = Number(other!.id)
  try {
    // With no role, all four operations must fail permission checks.
    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { username: 'channel-crud-owner', password },
    })
    expect(login.statusCode).toBe(200)
    const cookies = {
      coati_session: login.cookies.find((row) => row.name === 'coati_session')!
        .value,
    }
    const headers = { 'x-csrf-token': login.json().csrf_token }
    for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url:
          personalChannelUrl + (['PUT', 'DELETE'].includes(method) ? '/1' : ''),
        cookies,
        headers,
        ...(['POST', 'PUT'].includes(method)
          ? { payload: personalChannelPayload() }
          : {}),
      })
      expect(response.statusCode, response.body).toBe(403)
    }
    await handle.db.execute(
      sql`insert into user_roles(user_id,role_id) select ${owner},id from roles where code='super_admin'`,
    )
    const own = await app.inject({
      method: 'POST',
      url: personalChannelUrl,
      cookies,
      headers,
      payload: personalChannelPayload('Other private'),
    })
    expect(own.statusCode, own.body).toBe(201)
    const foreign = own.json().id
    for (const [url, payload] of [
      [`${personalChannelUrl}/${foreign}/check`, {}],
      [
        personalChannelUrl + '/discover-models',
        { credential_id: foreign, base_url: base, api_key: 'must-not-send' },
      ],
    ] as const) {
      const prior = calls
      const result = await session.inject({ method: 'POST', url, payload })
      expect(result.statusCode, result.body).toBe(404)
      expect(calls).toBe(prior)
    }
    for (const id of [foreign, platform.id])
      for (const method of ['PUT', 'DELETE'] as const) {
        const response = await session.inject({
          method,
          url: `${personalChannelUrl}/${id}`,
          ...(method === 'PUT' ? { payload: { name: 'steal' } } : {}),
        })
        expect(response.statusCode, response.body).toBe(404)
      }
    expect(
      (await session.inject({ method: 'GET', url: personalChannelUrl })).json()
        .items,
    ).toEqual([])
    expect(
      (
        await app.inject({
          method: 'GET',
          url: personalChannelUrl,
          cookies,
          headers,
        })
      )
        .json()
        .items.map((row: any) => row.id),
    ).toEqual([foreign])
    expect((await invoke(key.token, { model: 'mine/openai' })).statusCode).toBe(
      403,
    )
  } finally {
    await handle.db.execute(
      sql`delete from gw_upstreams where owner_user_id=${owner}`,
    )
    await handle.db.execute(sql`delete from user_roles where user_id=${owner}`)
    await handle.db.execute(sql`delete from admin_users where id=${owner}`)
  }
})

test('personal channel API rejects deletion while an admitted request holds a lease', async () => {
  const created = await session.inject({
    method: 'POST',
    url: personalChannelUrl,
    payload: personalChannelPayload(),
  })
  expect(created.statusCode).toBe(201)
  const id = created.json().id
  const key = await service.createKey(session.userId, {
    name: 'inflight',
    models: ['mine/openai'],
  })
  await service.repo.reserve(key.id, {
    id: 'personal-delete-lease',
    model: 'mine/openai',
    protocol: 'openai',
    reserved_tokens: 1,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  })
  await service.repo.acquireUpstream(
    id,
    'mine/openai',
    'personal-delete-lease',
    new Date(Date.now() + 60000).toISOString(),
    undefined,
    false,
    undefined,
    session.userId,
  )
  await session.inject({
    method: 'PUT',
    url: `${personalChannelUrl}/${id}`,
    payload: { enabled: false },
  })
  expect(
    (
      await session.inject({
        method: 'DELETE',
        url: `${personalChannelUrl}/${id}`,
      })
    ).statusCode,
  ).toBe(409)
  await service.repo.releaseUpstream('personal-delete-lease')
  expect(
    (
      await session.inject({
        method: 'DELETE',
        url: `${personalChannelUrl}/${id}`,
      })
    ).statusCode,
  ).toBe(200)
})

test.each([
  'normal',
  'discovery-failure',
  'discovery-unsupported',
  'discovery-html',
])(
  'personal probe creation retains saved configuration after %s observation',
  async (behaviorName) => {
    behavior = behaviorName
    const result = await session.inject({
      method: 'POST',
      url: personalChannelUrl,
      payload: personalChannelPayload(),
    })
    expect(result.statusCode, result.body).toBe(201)
    expect(result.json().health_probe).toMatchObject({
      attempted: true,
      verified: behaviorName === 'normal',
    })
    expect(result.body).not.toContain('personal-api-secret')
    expect(result.body).not.toContain('secret-test-key')
    const rows = await service.repo.personalChannelRows(session.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      supported_models: ['openai'],
      probe_token: null,
      health_status: behaviorName === 'normal' ? 'healthy' : 'unknown',
      consecutive_failures: 0,
      cooldown_until: null,
    })
    expect(calls).toBe(1)
    expect(
      (await handle.db.execute(sql`select * from gw_requests`)).rows,
    ).toEqual([])
  },
)

test('personal probe Messages model discovery does not claim conversation health', async () => {
  const result = await session.inject({
    method: 'POST',
    url: personalChannelUrl,
    payload: { ...personalChannelPayload(), protocol: 'anthropic' },
  })
  expect(result.statusCode).toBe(201)
  expect(result.json()).toMatchObject({
    health_status: 'unknown',
    health_probe: {
      verified: false,
      health_updated: false,
      models: ['fixture-a', 'fixture-b'],
    },
  })
  expect(
    (await service.repo.personalChannelRows(session.userId))[0]!
      .last_probe_status,
  ).toBe('unverified')
})

test('personal probe discovery reuses only unchanged owned credentials and does not mutate health or models', async () => {
  const created = await session.inject({
    method: 'POST',
    url: personalChannelUrl,
    payload: personalChannelPayload(),
  })
  const id = created.json().id
  await handle.db.execute(
    sql`update gw_upstreams set health_status='cooldown',cooldown_until=now()+interval '5 minutes' where id=${id}`,
  )
  const before = (await service.repo.personalChannelRows(session.userId))[0]!
  const discovered = await session.inject({
    method: 'POST',
    url: personalChannelUrl + '/discover-models',
    payload: { credential_id: id },
  })
  expect(discovered.statusCode, discovered.body).toBe(200)
  expect(discovered.json()).toMatchObject({
    models: ['fixture-a', 'fixture-b'],
    model_count: 2,
  })
  expect(observed.authorization).toBe('Bearer personal-api-secret')
  expect(await service.repo.personalChannelRows(session.userId)).toEqual([
    before,
  ])
  const callsBefore = calls
  for (const extra of [
    { base_url: base + '/changed' },
    { protocol: 'responses' },
  ]) {
    const rejected = await session.inject({
      method: 'POST',
      url: personalChannelUrl + '/discover-models',
      payload: { credential_id: id, ...extra },
    })
    expect(rejected.statusCode, rejected.body).toBe(400)
  }
  expect(calls).toBe(callsBefore)
  const draft = await session.inject({
    method: 'POST',
    url: personalChannelUrl + '/discover-models',
    payload: {
      base_url: base,
      api_key: 'new-draft-secret',
      protocol: 'openai',
    },
  })
  expect(draft.statusCode, draft.body).toBe(200)
  expect(observed.authorization).toBe('Bearer new-draft-secret')
  expect(draft.body).not.toContain('new-draft-secret')
  expect(await service.repo.personalChannelRows(session.userId)).toEqual([
    before,
  ])
})

test('personal probe claims serialize HTTP checks, reject deletion while active and discard edited snapshots', async () => {
  const created = await session.inject({
    method: 'POST',
    url: personalChannelUrl,
    payload: personalChannelPayload(),
  })
  const id = created.json().id
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = GatewayTransport.prototype.discover
  const mock = vi
    .spyOn(GatewayTransport.prototype, 'discover')
    .mockImplementationOnce(async function (this: GatewayTransport, ...args) {
      entered()
      await blocked
      return original.apply(this, args)
    })
  let checking: Promise<any> | undefined
  try {
    checking = session.inject({
      method: 'POST',
      url: `${personalChannelUrl}/${id}/check`,
    })
    await ready
    expect(
      (
        await session.inject({
          method: 'POST',
          url: `${personalChannelUrl}/${id}/check`,
        })
      ).statusCode,
    ).toBe(409)
    await session.inject({
      method: 'PUT',
      url: `${personalChannelUrl}/${id}`,
      payload: { enabled: false },
    })
    expect(
      (
        await session.inject({
          method: 'DELETE',
          url: `${personalChannelUrl}/${id}`,
        })
      ).statusCode,
    ).toBe(409)
    release()
    const result = await checking
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().health_updated).toBe(false)
    const row = (await service.repo.personalChannelRows(session.userId))[0]!
    expect(row).toMatchObject({
      enabled: false,
      last_probe_status: 'stale',
      probe_token: null,
    })
    expect(
      (
        await session.inject({
          method: 'DELETE',
          url: `${personalChannelUrl}/${id}`,
        })
      ).statusCode,
    ).toBe(200)
  } finally {
    release()
    await checking
    mock.mockRestore()
  }
})

test('personal probe redacts plaintext, encrypted credentials and claim tokens from returned and saved errors', async () => {
  const created = await session.inject({
    method: 'POST',
    url: personalChannelUrl,
    payload: personalChannelPayload(),
  })
  const id = created.json().id
  let leakedCipher = '',
    leakedClaim = ''
  const mock = vi
    .spyOn(GatewayTransport.prototype, 'discover')
    .mockImplementationOnce(async () => {
      const row = (await service.repo.personalChannelRows(session.userId))[0]!
      leakedCipher = row.secret
      leakedClaim = row.probe_token!
      throw new Error(
        `probe failure personal-api-secret ${leakedCipher} ${leakedClaim}`,
      )
    })
  try {
    const result = await session.inject({
      method: 'POST',
      url: `${personalChannelUrl}/${id}/check`,
    })
    expect(result.statusCode, result.body).toBe(502)
    const listed = await session.inject({
      method: 'GET',
      url: personalChannelUrl,
    })
    expect(listed.statusCode).toBe(200)
    for (const secret of ['personal-api-secret', leakedCipher, leakedClaim]) {
      expect(secret).not.toBe('')
      expect(result.body).not.toContain(secret)
      expect(listed.body).not.toContain(secret)
    }
    expect(listed.json().items[0]).toMatchObject({
      last_probe_status: 'failed',
    })
    expect(listed.json().items[0]).not.toHaveProperty('probe_token')
    expect(
      (await service.repo.personalChannelRows(session.userId))[0]!.last_error,
    ).toContain('[redacted]')
  } finally {
    mock.mockRestore()
  }
})

test('personal background recovery uses owned claims across service instances and clears cooldown', async () => {
  const id = await personalScopeFixture()
  await handle.db.execute(
    sql`update gw_upstreams set health_status='cooldown',consecutive_failures=3,cooldown_until=now()+interval '10 minutes' where id=${id}`,
  )
  expect(await service.repo.probeCandidates(5, 600)).toEqual([])
  const other = new GatewayService(handle.db, service.options)
  try {
    const results = (
      await Promise.all([runProbeBatch(service), runProbeBatch(other)])
    ).flat()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id,
      verified: true,
      health_updated: true,
    })
    expect(calls).toBe(1)
    expect(
      (await service.repo.personalChannelRows(session.userId))[0],
    ).toMatchObject({
      health_status: 'healthy',
      consecutive_failures: 0,
      cooldown_until: null,
      probe_token: null,
    })
    expect(await runProbeBatch(other)).toEqual([])
    expect(await service.repo.upstreams()).toEqual([])
  } finally {
    await other.transport.close()
  }
})

test('personal background recovery bounds the shared batch and skips disabled or recently checked accounts', async () => {
  const id = await personalScopeFixture()
  for (let index = 0; index < 6; index++)
    await service.repo.saveUpstream({
      name: `platform-${index}`,
      base_url: base,
      protocol: 'openai',
      secret: service.vault.encrypt('platform-test-secret'),
    })
  await handle.db.execute(
    sql`update gw_upstreams set enabled=false where name='platform-0'`,
  )
  await handle.db.execute(
    sql`update gw_upstreams set last_probe_at=now() where name='platform-1'`,
  )
  const batch = await runProbeBatch(service)
  expect(batch).toHaveLength(5)
  expect(batch.some((row) => row.id === id)).toBe(true)
  expect(calls).toBe(5)
  expect(await runProbeBatch(service)).toEqual([])
  expect(calls).toBe(5)
})

test('personal background recovery retains unverified Messages health and durable quiet period', async () => {
  const id = await personalScopeFixture()
  await handle.db.execute(
    sql`update gw_upstreams set protocol='anthropic',health_status='cooldown',cooldown_until=now()+interval '10 minutes' where id=${id}`,
  )
  const before = (await service.repo.personalChannelRows(session.userId))[0]!
  expect(await runProbeBatch(service)).toEqual([
    expect.objectContaining({ id, verified: false, health_updated: false }),
  ])
  expect(await runProbeBatch(service)).toEqual([])
  expect(calls).toBe(1)
  const after = (await service.repo.personalChannelRows(session.userId))[0]!
  expect(after.health_status).toBe('cooldown')
  expect(after.cooldown_until).toBe(before.cooldown_until)
  await handle.db.execute(
    sql`update gw_upstreams set last_probe_at=now()-interval '11 minutes',last_checked_at=now()-interval '11 minutes' where id=${id}`,
  )
  expect(await runProbeBatch(service)).toHaveLength(1)
  expect(calls).toBe(2)
})

test('personal background recovery cannot reuse a candidate after its ownership changes', async () => {
  const id = await personalScopeFixture()
  const candidates = await service.repo.probeCandidates(5, 600, true)
  expect(candidates).toEqual([{ id, owner_user_id: session.userId }])
  await handle.db.execute(
    sql`update gw_upstreams set scope='platform',owner_user_id=null,model_prefix='' where id=${id}`,
  )
  const selected = vi
    .spyOn(service.repo, 'probeCandidates')
    .mockResolvedValueOnce(candidates)
  try {
    expect(await runProbeBatch(service)).toEqual([{ id, verified: false }])
    expect(calls).toBe(0)
    expect((await service.repo.upstreams())[0]!.probe_token).toBeNull()
  } finally {
    selected.mockRestore()
  }
})

test('account headers persist with notes and apply to personal runtime, checks and read-only draft discovery', async () => {
  const created = await session.inject({
    method: 'POST',
    url: personalChannelUrl,
    payload: {
      ...personalChannelPayload(),
      note: '  personal note  ',
      extra_headers: JSON.stringify({
        'X-Fixture': 'header-secret',
        'User-Agent': 'coati-fixture',
        'X-Number': 7,
        'X-Boolean': true,
      }),
    },
  })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id
  expect(created.json()).toMatchObject({
    note: 'personal note',
    extra_headers: { 'X-Number': '7', 'X-Boolean': 'True' },
  })
  expect(observed).toMatchObject({
    'x-fixture': 'header-secret',
    'user-agent': 'coati-fixture',
    authorization: 'Bearer personal-api-secret',
  })
  const key = await service.createKey(session.userId, {
    name: 'custom-headers',
    models: ['mine/openai'],
  })
  expect((await invoke(key.token, { model: 'mine/openai' })).statusCode).toBe(
    200,
  )
  expect(observedWireHeaders).toMatchObject({
    'x-fixture': 'header-secret',
    'user-agent': 'coati-fixture',
    authorization: 'Bearer personal-api-secret',
  })
  const renamed = await session.inject({
    method: 'PUT',
    url: `${personalChannelUrl}/${id}`,
    payload: { name: 'renamed' },
  })
  expect(renamed.json()).toMatchObject({
    note: 'personal note',
    extra_headers: { 'X-Fixture': 'header-secret' },
  })
  const drafted = await session.inject({
    method: 'POST',
    url: personalChannelUrl + '/discover-models',
    payload: {
      credential_id: id,
      extra_headers: { 'X-Fixture': 'draft-value' },
    },
  })
  expect(drafted.statusCode, drafted.body).toBe(200)
  expect(observed['x-fixture']).toBe('draft-value')
  expect(
    (await service.repo.personalChannelRows(session.userId))[0]!.extra_headers[
      'X-Fixture'
    ],
  ).toBe('header-secret')
  const cleared = await session.inject({
    method: 'PUT',
    url: `${personalChannelUrl}/${id}`,
    payload: { extra_headers: {}, note: null },
  })
  expect(cleared.json()).toMatchObject({ extra_headers: {}, note: null })
  expect((await invoke(key.token, { model: 'mine/openai' })).statusCode).toBe(
    200,
  )
  expect(observedWireHeaders['x-fixture']).toBeUndefined()
})

test.each([
  { Authorization: 'steal' },
  { 'X-API-Key': 'steal' },
  { Host: 'elsewhere' },
  { 'Content-Length': '1' },
  { Connection: 'close' },
  { 'Transfer-Encoding': 'chunked' },
  { Cookie: 'session' },
  { 'invalid header': 'x' },
  { 'x-fixture': 'internal\r\ninjection' },
  { 'x-fixture': 'x'.repeat(513) },
  Object.fromEntries(Array.from({ length: 21 }, (_, i) => ['x-' + i, 'v'])),
])(
  'account headers reject unsafe fields before creation and network activity %j',
  async (extra_headers) => {
    const response = await session.inject({
      method: 'POST',
      url: personalChannelUrl,
      payload: { ...personalChannelPayload(), extra_headers },
    })
    expect(response.statusCode, response.body).toBe(400)
    expect(calls).toBe(0)
    expect(await service.repo.personalChannelRows(session.userId)).toEqual([])
  },
)

test('account headers edits fence previous health observations and redact custom values in upstream failures', async () => {
  const created = await session.inject({
    method: 'POST',
    url: personalChannelUrl,
    payload: {
      ...personalChannelPayload(),
      extra_headers: { 'X-Fixture': 'header-secret' },
    },
  })
  const id = created.json().id
  const claim = (await service.repo.claimProbe(id, 0, session.userId))!
  await session.inject({
    method: 'PUT',
    url: `${personalChannelUrl}/${id}`,
    payload: { extra_headers: { 'X-Fixture': 'new-header-secret' } },
  })
  expect(await service.repo.completeProbe(claim, true, 1)).toBe(false)
  expect(
    (await service.repo.personalChannelRows(session.userId))[0]!
      .last_probe_status,
  ).toBe('stale')
  const key = await service.createKey(session.userId, {
    name: 'header-errors',
    models: ['mine/openai'],
  })
  behavior = 'failure'
  failureBody = 'failed new-header-secret'
  const response = await invoke(key.token, { model: 'mine/openai' })
  expect(response.statusCode).toBe(503)
  expect(response.body).not.toContain('new-header-secret')
  const saved = JSON.stringify(
    (
      await handle.db.execute(
        sql`select error from gw_requests union all select error from gw_attempts`,
      )
    ).rows,
  )
  expect(saved).not.toContain('new-header-secret')
})

test('account headers platform management preserves omitted metadata and sends it during probes and model calls', async () => {
  const key = await setup()
  const id = (await service.repo.upstreams())[0]!.id
  const payload = {
    name: 'platform-headers',
    protocol: 'openai',
    base_url: base,
    extra_headers: { 'X-Fixture': 'platform-header' },
    note: 'platform note',
  }
  const saved = await session.inject({
    method: 'PUT',
    url: `/api/admin/gateway/upstreams/${id}`,
    payload,
  })
  expect(saved.statusCode, saved.body).toBe(200)
  expect(saved.json()).toMatchObject({
    extra_headers: payload.extra_headers,
    note: payload.note,
  })
  const partial = await session.inject({
    method: 'PUT',
    url: `/api/admin/gateway/upstreams/${id}`,
    payload: { name: 'renamed', protocol: 'openai', base_url: base },
  })
  expect(partial.json()).toMatchObject({
    extra_headers: payload.extra_headers,
    note: payload.note,
  })
  expect((await invoke(key.token)).statusCode).toBe(200)
  expect(observedWireHeaders['x-fixture']).toBe('platform-header')
  expect(
    (
      await session.inject({
        method: 'POST',
        url: `/api/admin/gateway/upstreams/${id}/probe`,
      })
    ).statusCode,
  ).toBe(200)
  expect(observed['x-fixture']).toBe('platform-header')
})

test.each(['headers', 'body', 'stream'])(
  'account timeout %s releases quota and leases without a successful terminal response',
  async (mode) => {
    const key = await setup()
    const row = (await service.repo.upstreams())[0]!
    expect(row.request_timeout_seconds).toBe(120)
    const payload = {
      name: row.name,
      protocol: row.protocol,
      base_url: row.base_url,
      request_timeout_seconds: 5,
    }
    expect(
      (
        await session.inject({
          method: 'PUT',
          url: `/api/admin/gateway/upstreams/${row.id}`,
          payload,
        })
      ).statusCode,
    ).toBe(200)
    const preserved = await session.inject({
      method: 'PUT',
      url: `/api/admin/gateway/upstreams/${row.id}`,
      payload: {
        name: row.name,
        protocol: row.protocol,
        base_url: row.base_url,
      },
    })
    expect(preserved.json().request_timeout_seconds).toBe(5)
    behavior = `account-timeout-${mode}`
    const started = Date.now()
    const response = await invoke(key.token, {
      model: 'public-model',
      stream: mode === 'stream',
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500)
    expect(Date.now() - started).toBeLessThan(10000)
    if (mode === 'stream') {
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('stream_error')
      expect(response.body).not.toContain('[DONE]')
    } else expect(response.statusCode, response.body).toBe(504)
    expect(calls).toBe(1)
    await expect.poll(() => clientClosed).toBe(true)
    const requests = (
      await handle.db.execute(
        sql`select status,reserved_tokens from gw_requests`,
      )
    ).rows
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      status: mode === 'stream' ? 'stream_error' : 'upstream_error',
    })
    expect(
      (
        await handle.db.execute(
          sql`select count(*)::int as n from gw_requests where status='reserved'`,
        )
      ).rows[0]!.n,
    ).toBe(0)
    behavior = 'normal'
    expect((await invoke(key.token)).statusCode).toBe(200)
    expect(
      (
        await handle.db.execute(
          sql`select count(*)::int as n from gw_upstream_leases`,
        )
      ).rows[0]!.n,
    ).toBe(0)
  },
)

test('account timeout before headers retries another account before settling once', async () => {
  const key = await setup()
  const first = (await service.repo.upstreams())[0]!
  await service.saveUpstream(
    {
      name: first.name,
      protocol: first.protocol,
      base_url: first.base_url,
      request_timeout_seconds: 5,
    },
    first.id,
  )
  const created = await session.inject({
    method: 'POST',
    url: '/api/admin/gateway/upstreams',
    payload: {
      name: 'timeout-backup',
      protocol: 'openai',
      base_url: base,
      api_key: 'fixture-backup',
      request_timeout_seconds: 10,
      supported_models: ['openai'],
    },
  })
  expect(created.statusCode, created.body).toBe(201)
  const second = created.json()
  await service.saveRoute({
    model: 'public-model',
    upstream_id: second.id,
    upstream_model: 'openai',
    priority: 200,
  })
  behavior = 'account-timeout-retry'
  const response = await invoke(key.token)
  expect(response.statusCode, response.body).toBe(200)
  expect(calls).toBe(2)
  const attempts = (
    await handle.db.execute(
      sql`select upstream_id,error from gw_attempts order by id`,
    )
  ).rows
  expect(attempts).toHaveLength(2)
  expect(attempts[0]!.upstream_id).toBe(first.id)
  expect(attempts[0]!.error).toContain('timeout')
  expect(attempts[1]!.upstream_id).toBe(second.id)
  expect(
    (await handle.db.execute(sql`select status from gw_requests`)).rows,
  ).toEqual([{ status: 'ok' }])
  expect(
    (
      await handle.db.execute(
        sql`select count(*)::int as n from gw_upstream_leases`,
      )
    ).rows[0]!.n,
  ).toBe(0)
})

test('account proxy personal saves encrypt and preserve credentials; discovery overrides are transient and clear is explicit', async () => {
  const proxy = await startProxyFixture()
  try {
    const created = await session.inject({
      method: 'POST',
      url: personalChannelUrl,
      payload: { ...personalChannelPayload(), proxy_url: proxy.url },
    })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().id
    expect(created.json()).toMatchObject({
      has_proxy: true,
      proxy_hint: new URL(proxy.url).origin,
    })
    expect(created.body).not.toContain('proxy-fixture-password')
    expect(created.json()).not.toHaveProperty('proxy_secret')
    expect(proxy.calls).toHaveLength(1)
    const stored = (await service.repo.personalChannelRows(session.userId))[0]!
    expect(stored.proxy_secret).toMatch(/^v2\./)
    expect(stored.proxy_secret).not.toContain('proxy-fixture-password')
    const updated = await session.inject({
      method: 'PUT',
      url: `${personalChannelUrl}/${id}`,
      payload: { note: 'retain proxy' },
    })
    expect(updated.json().has_proxy).toBe(true)
    expect(
      (await service.repo.personalChannelRows(session.userId))[0]!.proxy_secret,
    ).toBe(stored.proxy_secret)
    for (const payload of [
      { credential_id: id },
      { credential_id: id, proxy_url: null },
    ]) {
      const discovered = await session.inject({
        method: 'POST',
        url: `${personalChannelUrl}/discover-models`,
        payload,
      })
      expect(discovered.statusCode, discovered.body).toBe(200)
    }
    expect(proxy.calls).toHaveLength(2)
    expect(
      (await service.repo.personalChannelRows(session.userId))[0]!.proxy_secret,
    ).toBe(stored.proxy_secret)
    const cleared = await session.inject({
      method: 'PUT',
      url: `${personalChannelUrl}/${id}`,
      payload: { proxy_url: null },
    })
    expect(cleared.json()).toMatchObject({ has_proxy: false, proxy_hint: null })
    expect(
      (await service.repo.personalChannelRows(session.userId))[0]!.proxy_secret,
    ).toBeNull()
    const logs = (
      await handle.db.execute(
        sql`select payload from operation_logs where payload like '%proxy_url%'`,
      )
    ).rows
    expect(JSON.stringify(logs)).not.toContain('proxy-fixture-password')
  } finally {
    await proxy.close()
  }
})

test('account proxy configuration edits invalidate old health results and errors redact proxy credentials', async () => {
  const proxy = await startProxyFixture()
  try {
    const created = await session.inject({
      method: 'POST',
      url: personalChannelUrl,
      payload: { ...personalChannelPayload(), proxy_url: proxy.url },
    })
    const id = created.json().id
    const observed = (
      await service.repo.personalChannelRows(session.userId)
    )[0]!
    await session.inject({
      method: 'PUT',
      url: `${personalChannelUrl}/${id}`,
      payload: { proxy_url: null },
    })
    await service.repo.recordHealthFailure(
      id,
      new Date(Date.now() + 1000).toISOString(),
      'stale proxy failure',
      true,
      true,
      observed,
    )
    expect(
      (await service.repo.personalChannelRows(session.userId))[0]!.last_error,
    ).not.toBe('stale proxy failure')
    await session.inject({
      method: 'PUT',
      url: `${personalChannelUrl}/${id}`,
      payload: { proxy_url: proxy.url },
    })
    const spy = vi
      .spyOn(GatewayTransport.prototype, 'discover')
      .mockRejectedValueOnce(
        new Error(
          `proxy failure ${proxy.url} proxy-fixture-password ${Buffer.from('proxy-user:proxy-fixture-password').toString('base64')}`,
        ),
      )
    try {
      const checked = await session.inject({
        method: 'POST',
        url: `${personalChannelUrl}/${id}/check`,
      })
      expect(checked.statusCode).toBe(502)
      expect(checked.body).not.toContain('proxy-fixture-password')
      expect(checked.body).not.toContain(
        Buffer.from('proxy-user:proxy-fixture-password').toString('base64'),
      )
      expect(
        (await service.repo.personalChannelRows(session.userId))[0]!.last_error,
      ).not.toContain('proxy-fixture-password')
    } finally {
      spy.mockRestore()
    }
  } finally {
    await proxy.close()
  }
})

for (const [protocol, suffix] of [
  ['openai', ''],
  ['openai', '/chat/completions'],
  ['openai', '/chat/completions/'],
  ['responses', ''],
  ['responses', '/responses'],
  ['anthropic', ''],
  ['anthropic', '/messages'],
  ['anthropic', 'ROOT'],
] as const)
  for (const stream of [false, true]) {
    test(`upstream endpoint ${protocol} ${suffix || 'version-root'} ${stream ? 'SSE' : 'JSON'} matches Python without duplicated suffix`, async () => {
      const key = await setup(protocol)
      const row = (await service.repo.upstreams())[0]!
      const upstreamBase = suffix === 'ROOT' ? base.slice(0, -3) : base + suffix
      const saved = await session.inject({
        method: 'PUT',
        url: `/api/admin/gateway/upstreams/${row.id}`,
        payload: { name: row.name, protocol, base_url: upstreamBase },
      })
      expect(saved.statusCode, saved.body).toBe(200)
      const path =
        protocol === 'openai'
          ? '/v1/chat/completions'
          : protocol === 'anthropic'
            ? '/v1/messages'
            : '/v1/responses'
      const response = await invoke(
        key.token,
        { model: 'public-model', stream },
        path,
      )
      expect(response.statusCode, response.body).toBe(200)
      expect(calls).toBe(1)
      expect(
        (await handle.db.execute(sql`select status from gw_requests`)).rows,
      ).toEqual([{ status: 'ok' }])
    })
  }

test('account metadata platform credentials preserve fingerprints on edits and rotate with a replacement key', async () => {
  await setup()
  const row = (await service.repo.upstreams())[0]!
  expect(row).toMatchObject(credentialMetadata('secret-test-key'))
  const path = `/api/admin/gateway/upstreams/${row.id}`
  const payload = { name: 'metadata edit', protocol: 'openai', base_url: base }
  const preserved = await session.inject({ method: 'PUT', url: path, payload })
  expect(preserved.json()).toMatchObject({
    api_key_masked: 'secr…-key',
    key_fingerprint: row.key_fingerprint,
  })
  expect(preserved.body).not.toContain('secret-test-key')
  expect(Date.parse(preserved.json().updated_at)).toBeGreaterThanOrEqual(
    Date.parse(row.updated_at!),
  )
  const rotated = await session.inject({
    method: 'PUT',
    url: path,
    payload: { ...payload, api_key: 'replacement-key-value' },
  })
  expect(rotated.statusCode, rotated.body).toBe(200)
  expect(rotated.json().key_fingerprint).toBe(
    credentialMetadata('replacement-key-value').key_fingerprint,
  )
  expect(rotated.json().key_fingerprint).not.toBe(row.key_fingerprint)
  expect(rotated.body).not.toContain('replacement-key-value')
})

test('account metadata records actual request use, failures, later success and leaves check time independent', async () => {
  const key = await setup()
  const row = (await service.repo.upstreams())[0]!
  expect(row.last_used_at).toBeNull()
  expect(row.last_checked_at).toBeNull()
  behavior = 'failure'
  expect((await invoke(key.token)).statusCode).toBeGreaterThanOrEqual(500)
  const failed = (await service.repo.upstreams())[0]!
  expect(failed.last_used_at).not.toBeNull()
  expect(failed.last_error_at).not.toBeNull()
  expect(failed.last_success_at).toBeNull()
  expect(failed.last_checked_at).toBeNull()
  behavior = 'normal'
  expect((await invoke(key.token)).statusCode).toBe(200)
  const succeeded = (await service.repo.upstreams())[0]!
  expect(succeeded.last_success_at).not.toBeNull()
  expect(succeeded.last_error_at).toBeNull()
  expect(succeeded.last_latency_ms).toBeGreaterThanOrEqual(0)
  expect(succeeded.last_checked_at).toBeNull()
  await service.repo.recordHealthFailure(
    row.id,
    '2000-01-01T00:00:00Z',
    'stale',
    true,
    false,
    succeeded,
  )
  const after = (await service.repo.upstreams())[0]!
  expect(after.last_success_at).toBe(succeeded.last_success_at)
  expect(after.last_error_at).toBeNull()
})

test('account metadata personal probe observations return current timestamps without claiming model execution', async () => {
  const created = await session.inject({
    method: 'POST',
    url: personalChannelUrl,
    payload: personalChannelPayload(),
  })
  expect(created.statusCode, created.body).toBe(201)
  expect(created.json()).toMatchObject({
    api_key_masked: credentialMetadata('personal-api-secret').api_key_hint,
    last_used_at: null,
  })
  expect(created.json().last_checked_at).toMatch(/Z$/)
  expect(created.json().last_success_at).toMatch(/Z$/)
  expect(created.json().last_latency_ms).toBeGreaterThanOrEqual(0)
  const id = created.json().id
  const edited = await session.inject({
    method: 'PUT',
    url: `${personalChannelUrl}/${id}`,
    payload: { note: 'metadata retained' },
  })
  expect(edited.json().key_fingerprint).toBe(created.json().key_fingerprint)
  const rotated = await session.inject({
    method: 'PUT',
    url: `${personalChannelUrl}/${id}`,
    payload: { api_key: 'short' },
  })
  expect(rotated.json()).toMatchObject({
    api_key_masked: '****',
    key_fingerprint: credentialMetadata('short').key_fingerprint,
  })
  const unverified = await session.inject({
    method: 'POST',
    url: personalChannelUrl,
    payload: {
      ...personalChannelPayload('Messages unverified'),
      protocol: 'anthropic',
    },
  })
  expect(unverified.statusCode, unverified.body).toBe(201)
  expect(unverified.json().last_checked_at).toMatch(/Z$/)
  expect(unverified.json()).toMatchObject({
    last_success_at: null,
    last_used_at: null,
    health_status: 'unknown',
  })
})

test('account metadata unknown historical values stay unknown and stale probes cannot erase newer latency', async () => {
  await setup()
  const row = (await service.repo.upstreams())[0]!
  await handle.db.execute(
    sql`update gw_upstreams set api_key_hint=null,key_fingerprint=null,updated_at=null where id=${row.id}`,
  )
  const listed = await session.inject({ url: '/api/admin/gateway/upstreams' })
  expect(listed.json().items[0]).toMatchObject({
    api_key_masked: '****',
    key_fingerprint: null,
    updated_at: null,
  })
  const claimed = await service.repo.claimProbe(row.id, 0)
  expect(claimed).toBeTruthy()
  const before = (await service.repo.upstreams())[0]!
  await service.repo.recordHealthSuccess(
    row.id,
    new Date(Date.now() + 1000).toISOString(),
    before,
    123,
  )
  const observed = (await service.repo.upstreams())[0]!
  await service.repo.completeProbe(before, true, 999)
  const after = (await service.repo.upstreams())[0]!
  expect(after.last_success_at).toBe(observed.last_success_at)
  expect(after.last_latency_ms).toBe(123)
})

test('account credential hints count Unicode codepoints and never reveal short secrets', () => {
  expect(credentialMetadata('😀😀😀😀😀😀😀😀').api_key_hint).toBe('****')
  expect(credentialMetadata('😀😀😀😀😀😀😀😀😀').api_key_hint).toBe(
    '😀😀😀😀…😀😀😀😀',
  )
})

test('account metadata summary distinguishes active, expired and unset cooldown and excludes disabled health states', () => {
  const row = (
    health_status: string,
    cooldown_until: string | null = null,
    enabled = true,
    used = false,
  ) => ({
    enabled,
    health_status,
    cooldown_until,
    last_used_at: used ? '2020-01-01' : null,
  })
  expect(
    accountSummary(
      [
        row('healthy'),
        row('unhealthy'),
        row('cooldown', '2030-01-02'),
        row('cooldown', '2030-01-01'),
        row('cooldown'),
        row('unknown'),
        row('cooldown', '2030-01-02', false, true),
      ],
      Date.parse('2030-01-01'),
    ),
  ).toEqual({
    total: 7,
    enabled: 6,
    disabled: 1,
    used: 1,
    healthy: 1,
    unhealthy: 2,
    cooling: 1,
    recovering: 2,
    unknown: 1,
  })
})

test('account metadata summary follows ownership scope but does not shrink with list filters', async () => {
  await setup()
  for (const name of ['owned-one', 'owned-two']) {
    const saved = await session.inject({
      method: 'POST',
      url: personalChannelUrl,
      payload: personalChannelPayload(name),
    })
    expect(saved.statusCode).toBe(201)
  }
  const personal = await session.inject({
    url: personalChannelUrl + '?search=no-match',
  })
  expect(personal.json()).toMatchObject({
    items: [],
    total: 0,
    summary: { total: 2, healthy: 2, used: 0 },
  })
  const platform = await session.inject({ url: '/api/admin/gateway/upstreams' })
  expect(platform.json().summary).toMatchObject({
    total: 1,
    unknown: 1,
    used: 0,
  })
})

test('platform affinity honors disabled mode and configurable binding lifetime', async () => {
  const token = await setup()
  const key = await service.authenticate(token.token)
  const scoped = new GatewayService(handle.db, {...gatewayOptions(testConfig()), sessionAffinityTtlSeconds: 120})
  const disabled = new GatewayService(handle.db, {...gatewayOptions(testConfig()), sessionAffinityEnabled: false})
  try {
    await scoped.execute(key, {model: 'public-model'}, 'openai', new AbortController().signal, {'x-session-id':'custom-ttl'})
    const result = await handle.db.execute(sql`select extract(epoch from (expires_at-now())) as remaining from gw_session_bindings`)
    expect(Number(result.rows[0]?.remaining)).toBeGreaterThan(110)
    expect(Number(result.rows[0]?.remaining)).toBeLessThanOrEqual(120)
    await disabled.execute(key, {model: 'public-model'}, 'openai', new AbortController().signal, {'x-session-id':'disabled'})
    expect((await handle.db.execute(sql`select * from gw_session_bindings`)).rows).toHaveLength(1)
  } finally { await scoped.transport.close(); await disabled.transport.close() }
})

test('native key creation preserves Python unlimited defaults and supports explicit expiry', async () => {
  const key = await setup()
  expect(key).toMatchObject({expires_at: null, daily_limit: 0, concurrency_limit: 0, rpm_limit: 0})
  const explicit = await session.inject({method: 'POST', url: '/api/admin/gateway/keys', payload: {name:'explicit expiry', models:['public-model'], expires_days:3650, rpm_limit:5, concurrency_limit:2}})
  expect(explicit.statusCode).toBe(201)
  expect(explicit.json()).toMatchObject({rpm_limit:5,concurrency_limit:2})
  expect(Date.parse(explicit.json().expires_at)).toBeGreaterThan(Date.now()+3649*86400000)
})

test.each([
  ['json', '{"error":{"message":"bad request","code":"bad_model"},"extra":7}', {error:{message:'bad request',code:'bad_model'},extra:7}],
  ['sse', 'event: error\ndata: {"error":{"message":"bad SSE request"}}\n\n', {error:{message:'bad SSE request'}}],
  ['wrapped', JSON.stringify({message:'data: {"error":{"message":"unwrapped","code":"bad"}}'}), {message:'unwrapped',code:'bad'}],
  ['text', 'plain failure secret-test-key', {error:'plain failure [redacted]'}],
])('final upstream %s error preserves Python body and request identity', async (_, raw, expected) => {
  const key = await setup()
  behavior='raw-failure'; failureStatus=422; failureBody=raw as string
  const response=await invoke(key.token)
  expect(response.statusCode).toBe(422)
  expect(response.json()).toEqual(expected)
  expect(response.headers['x-request-id']).toBe((await service.repo.listRequests()).items[0]!.id)
})
test('expired reservations stop blocking quota and concurrency before background recovery', async () => {
  const key=await setup('openai',{daily_limit:10,concurrency_limit:1})
  const old={id:'expired-before-reaper',model:'public-model',protocol:'openai',reserved_tokens:8,expires_at:new Date(Date.now()-1000).toISOString()}
  expect(await service.repo.reserve(key.id,old)).toBeNull()
  expect(await service.repo.reserve(key.id,{...old,id:'new-after-expiry',reserved_tokens:9,expires_at:new Date(Date.now()+60000).toISOString()})).toBeNull()
  expect(await service.repo.reserve(key.id,{...old,id:'still-live',reserved_tokens:1,expires_at:new Date(Date.now()+60000).toISOString()})).toBe('concurrency_limit')
})

test('configured health threshold and cooldown are persisted without resetting failure history', async () => {
  await setup()
  const account=(await service.repo.upstreams())[0]!
  const repo=new GatewayRepository(handle.db,undefined,undefined,{...schedulingPolicy({}),failureThreshold:2,cooldownSeconds:90})
  await repo.recordHealthFailure(account.id,'2030-01-01T00:00:00Z','fixture',false,false)
  expect((await repo.upstreams())[0]).toMatchObject({health_status:'unhealthy',consecutive_failures:1})
  await repo.recordHealthFailure(account.id,'2030-01-01T00:00:01Z','fixture',false,false)
  let row=(await repo.upstreams())[0]!
  expect(row.consecutive_failures).toBe(2)
  expect(Date.parse(row.cooldown_until!)-Date.now()).toBeGreaterThan(85000)
  await repo.recordHealthFailure(account.id,'2030-01-01T00:00:02Z','fixture',true,false)
  row=(await repo.upstreams())[0]!
  expect(row.consecutive_failures).toBe(3)
  expect(Date.parse(row.cooldown_until!)-Date.now()).toBeGreaterThan(1795000)
})

test('environment fallback remains transient while preserving quota, usage and route policy', async () => {
  const k = await setup()
  await handle.db.execute(sql`DELETE FROM gw_routes`)
  const original = service.options.environmentFallback
  service.options.environmentFallback = { key: 'secret-test-key', base, model: 'public-model' }
  try {
    const key = await service.authenticate(k.token)
    const response = await service.execute(key, { model: 'public-model', messages: [{ role: 'user', content: 'hello' }] }, 'openai', AbortSignal.timeout(5000), { 'x-coati-session-id': 'env-session' })
    expect(response.json).toBeDefined()
    const rows = await handle.db.execute(sql`SELECT status,execution,input_tokens FROM gw_requests WHERE status='ok'`)
    expect(rows.rows[0]).toMatchObject({ status: 'ok', execution: { route_kind: 'environment', upstream_id: null, upstream_name: 'env-fallback' } })
    const attempts = await handle.db.execute(sql`SELECT upstream_id FROM gw_attempts`)
    expect(attempts.rows).toEqual([{ upstream_id: null }])
    expect((await handle.db.execute(sql`SELECT * FROM gw_session_bindings`)).rows).toHaveLength(0)
    expect((await service.repo.upstreams()).map(row => row.name)).not.toContain('env-fallback')
    expect((await service.models(key)).data.map(row => row.id)).toContain('public-model')
    await handle.db.execute(sql`INSERT INTO gw_public_routes(model,enabled) VALUES ('public-model',false)`)
    expect(await service.repo.environmentTarget('public-model', key.owner_id, 'public-model')).toBeNull()
    await expect(service.execute(key, { model: 'public-model' }, 'openai', AbortSignal.timeout(5000))).rejects.toMatchObject({ status: 404 })
  } finally { service.options.environmentFallback = original }
})

test('remaining quota atomically trims output allowance instead of rejecting a usable request', async () => {
  const k = await setup()
  const key = await service.authenticate(k.token)
  await service.repo.saveDailyQuota(key.owner_id, 100)
  const budget = { promptTokens: 20, outputTokens: 120, minHeadroom: 0 }
  const input = { id: 'budget-trim-1', model: 'public-model', protocol: 'openai', reserved_tokens: 140, expires_at: new Date(Date.now() + 60000).toISOString() }
  expect(await service.repo.reserve(key.id, input, budget)).toBeNull()
  expect(budget.outputTokens).toBe(80)
  expect((await service.repo.requestById(input.id))?.reserved_tokens).toBe(100)
  const denied = { promptTokens: 20, outputTokens: 120, minHeadroom: 0 }
  expect(await service.repo.reserve(key.id, { ...input, id: 'budget-trim-2' }, denied)).toBe('user_quota_exceeded')
  await service.repo.finish(input.id, { status: 'ok', input_tokens: 20, output_tokens: 10 })
  const headroom = { promptTokens: 20, outputTokens: 120, minHeadroom: 60 }
  expect(await service.repo.reserve(key.id, { ...input, id: 'budget-trim-3' }, headroom)).toBe('user_quota_exceeded')
})

test('a killed gateway process leaves recoverable reservations without charging invented usage', async () => {
  const k = await setup()
  await handle.db.execute(sql`UPDATE gw_keys SET concurrency_limit=1 WHERE id=${k.id}`)
  behavior = 'account-timeout-stream'
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { GatewayService, gatewayOptions } from './src/modules/gateway/service.ts';
    import { createDb } from './src/db/client.ts';
    import { testConfig, TEST_DATABASE_URL } from './test/helpers.ts';
    const handle = createDb(TEST_DATABASE_URL);
    const gateway = new GatewayService(handle.db, gatewayOptions(testConfig()));
    const key = await gateway.authenticate(process.env.COATI_CRASH_TEST_TOKEN);
    const result = await gateway.execute(key, { model: 'public-model', stream: true }, 'openai', AbortSignal.timeout(20000));
    for await (const chunk of result.stream) { /* drain until killed */ }
  `], { cwd: process.cwd(), env: { ...process.env, COATI_CRASH_TEST_TOKEN: k.token }, stdio: 'ignore' })
  const exited = once(child, 'exit')
  let competitor: ReturnType<typeof spawn> | undefined
  try {
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 7000 })
    expect((await handle.db.execute(sql`SELECT status FROM gw_requests`)).rows).toEqual([{ status: 'reserved' }])
    competitor = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { GatewayService, gatewayOptions } from './src/modules/gateway/service.ts';
      import { createDb } from './src/db/client.ts';
      import { testConfig, TEST_DATABASE_URL } from './test/helpers.ts';
      const handle = createDb(TEST_DATABASE_URL);
      const gateway = new GatewayService(handle.db, gatewayOptions(testConfig()));
      try {
        const key = await gateway.authenticate(process.env.COATI_CRASH_TEST_TOKEN);
        await gateway.execute(key, {model:'public-model'}, 'openai', AbortSignal.timeout(5000));
        process.send({code:'unexpected_success'});
      } catch(error) { process.send({code:error.code}); }
      finally { await gateway.transport.close(); await handle.pool.end(); process.disconnect(); }
    `], {cwd:process.cwd(),env:{...process.env,COATI_CRASH_TEST_TOKEN:k.token},stdio:['ignore','ignore','ignore','ipc']})
    const competingExit = once(competitor, 'exit')
    expect((await once(competitor, 'message'))[0]).toMatchObject({code:'concurrency_limit'})
    await competingExit
    expect(calls).toBe(1)
    child.kill('SIGKILL')
    await exited
    await handle.db.execute(sql`UPDATE gw_requests SET expires_at=now()-interval '1 second' WHERE status='reserved'`)
    await handle.db.execute(sql`UPDATE gw_upstream_leases SET expires_at=now()-interval '1 second'`)
    await service.repo.recoverExpired()
    const rows = await handle.db.execute(sql`SELECT status,input_tokens,output_tokens,usage_source FROM gw_requests`)
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows).toEqual(expect.arrayContaining([
      { status: 'interrupted', input_tokens: '0', output_tokens: '0', usage_source: 'unknown' },
      { status: 'quota_exceeded', input_tokens: '0', output_tokens: '0', usage_source: 'estimated' },
    ]))
    expect((await handle.db.execute(sql`SELECT * FROM gw_upstream_leases`)).rows).toHaveLength(0)
    expect((await service.repo.quotaSummary((await service.authenticate(k.token)).owner_id))?.used_today).toBe(0)
    behavior = 'normal'
    expect((await invoke(k.token)).statusCode).toBe(200)
    expect((await handle.db.execute(sql`SELECT * FROM gw_requests WHERE status='reserved'`)).rows).toHaveLength(0)
    expect((await handle.db.execute(sql`SELECT * FROM gw_upstream_leases`)).rows).toHaveLength(0)
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    if (competitor && competitor.exitCode === null && competitor.signalCode === null) { const ended=once(competitor,'exit'); competitor.kill('SIGKILL'); await ended }
  }
})

test('direct model names use the declared platform pool and remain bound without persisted aliases', async () => {
  const k = await setup()
  const key = await service.authenticate(k.token)
  await handle.db.execute(sql`UPDATE gw_keys SET models='["*"]'::jsonb WHERE id=${key.id}`)
  const wildcard = await service.authenticate(k.token)
  const call = () => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${k.token}`, 'x-coati-session-id': 'direct-pool' }, payload: { model: 'openai' } })
  expect((await call()).statusCode).toBe(200)
  expect((await call()).statusCode).toBe(200)
  const rows = await handle.db.execute(sql`SELECT execution FROM gw_requests WHERE status='ok'`)
  expect(rows.rows).toHaveLength(2)
  expect(rows.rows[0]!.execution).toMatchObject({ route_kind: 'pool', route_id: null, upstream_model: 'openai' })
  expect((await handle.db.execute(sql`SELECT model FROM gw_session_bindings`)).rows).toEqual([{ model: 'pool:openai:openai' }])
  expect((await service.models(wildcard)).data.map(row => row.id)).toContain('openai')
  await handle.db.execute(sql`INSERT INTO gw_public_routes(model,enabled) VALUES ('openai',false)`)
  expect((await call()).statusCode).toBe(404)
})


test('device confirmation permission is independent from PAT creation', async () => {
  const hash = await generatePasswordHash('device-fixture-pass',1000)
  const user = (await handle.db.execute(sql`insert into admin_users(username,password_hash) values('device-permission-fixture',${hash}) returning id`)).rows[0]!
  const role = (await handle.db.execute(sql`insert into roles(name,code) values('Device fixture','device-permission-fixture') returning id`)).rows[0]!
  try {
    await handle.db.execute(sql`insert into user_roles(user_id,role_id) values(${user.id},${role.id})`)
    for (const code of ['gateway_keys_add', 'gateway_device_confirm_action', 'gateway_my_usage_export', 'gateway_upstreams']) {
      await handle.db.execute(sql`insert into menus(name,code,is_active,menu_type) values(${code},${code},true,'button') on conflict(code) do nothing`)
    }
    const login = await app.inject({method:'POST',url:'/api/admin/login',payload:{username:'device-permission-fixture',password:'device-fixture-pass'}})
    const auth = {cookies:{coati_session:login.cookies.find(c=>c.name==='coati_session')!.value},headers:{'x-csrf-token':login.json().csrf_token}}
    const codes = (await app.inject({method:'POST',url:'/api/agent/auth/device/start'})).json()
    const decision = {method:'POST' as const,url:'/api/admin/gateway/device/confirm',payload:{user_code:codes.user_code},...auth}
    await handle.db.execute(sql`insert into role_menus(role_id,menu_id) select ${role.id},id from menus where code='gateway_keys_add'`)
    expect((await app.inject(decision)).statusCode).toBe(403)
    await handle.db.execute(sql`delete from role_menus where role_id=${role.id}`)
    await handle.db.execute(sql`insert into role_menus(role_id,menu_id) select ${role.id},id from menus where code='gateway_device_confirm_action'`)
    expect((await app.inject({...auth,method:'POST',url:'/api/admin/gateway/keys',payload:{name:'not permitted'}})).statusCode).toBe(403)
    const result = await app.inject(decision)
    expect(result.statusCode,result.body).toBe(200)
    await handle.db.execute(sql`delete from role_menus where role_id=${role.id}`)
    await handle.db.execute(sql`insert into role_menus(role_id,menu_id) select ${role.id},id from menus where code='gateway_my_usage_export'`)
    for (const url of ['/api/agent/me/usage', '/api/agent/me/usage/analytics'])
      expect((await app.inject({...auth,method:'GET',url})).statusCode).toBe(200)
    expect((await app.inject({...auth,method:'POST',url:'/api/agent/me/usage/export',payload:{file_type:'csv'}})).statusCode).toBe(200)
    for (const url of ['/api/admin/agent/usage','/api/admin/agent/usage/analytics','/api/admin/agent/quotas','/api/admin/gateway/overview','/api/admin/gateway/upstreams'])
      expect((await app.inject({...auth,method:'GET',url})).statusCode,url).toBe(403)
    await handle.db.execute(sql`delete from role_menus where role_id=${role.id}`)
    await handle.db.execute(sql`insert into role_menus(role_id,menu_id) select ${role.id},id from menus where code='gateway_upstreams'`)
    expect((await app.inject({...auth,method:'GET',url:'/api/admin/gateway/upstreams'})).statusCode).toBe(200)
    for (const url of ['/api/admin/gateway/upstreams','/api/admin/gateway/upstreams/999999/probe'])
      expect((await app.inject({...auth,method:'POST',url,payload:{}})).statusCode,url).toBe(403)
  } finally {
    await handle.db.execute(sql`delete from gw_devices where owner_id=${user.id}`)
    await handle.db.execute(sql`delete from admin_users where id=${user.id}`)
    await handle.db.execute(sql`delete from roles where id=${role.id}`)
  }
})
