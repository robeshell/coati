import { beforeAll, afterAll, beforeEach, vi, test, expect } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'
import { sql } from 'drizzle-orm'
import {
  buildTestApp,
  openTestDb,
  superAdminSession,
  type AuthedSession,
} from './helpers'
import { GatewayService } from '../src/modules/gateway/service'
import { GatewayRepository } from '../src/modules/gateway/repository'
import { CredentialVault } from '../src/modules/gateway/crypto'
import { UsageMeter, nativeStream } from '../src/modules/gateway/stream'
import { validateBase, privateAddress } from '../src/modules/gateway/transport'
const handle = openTestDb()
let app: FastifyInstance,
  upstream: FastifyInstance,
  session: AuthedSession,
  service: GatewayService,
  base: string
let behavior = 'normal',
  calls = 0,
  observed: any,
  clientClosed = false
beforeAll(async () => {
  process.env.GATEWAY_ALLOW_PRIVATE_UPSTREAMS = 'true'
  upstream = Fastify()
  upstream.post('/v1/:a', async (request, reply) =>
    respond(request.body, reply),
  )
  upstream.post('/v1/chat/completions', async (request, reply) =>
    respond(request.body, reply),
  )
  function respond(body: any, reply: any) {
    calls++
    observed = body
    if (behavior === 'failure' || (behavior === 'fail-once' && calls === 1))
      return reply
        .code(503)
        .send({ error: { message: 'upstream unavailable secret-test-key' } })
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
    sql`TRUNCATE gw_attempts,gw_requests,gw_devices,gw_keys,gw_routes,gw_upstreams RESTART IDENTITY CASCADE`,
  )
  behavior = 'normal'
  calls = 0
  clientClosed = false
})
afterAll(async () => {
  await handle.db.execute(
    sql`TRUNCATE gw_attempts,gw_requests,gw_devices,gw_keys,gw_routes,gw_upstreams RESTART IDENTITY CASCADE`,
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
    })
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
  expect(res.statusCode).toBe(502)
  expect(res.body).toContain('upstream unavailable')
  expect(res.body).not.toContain('secret-test-key')
  expect((await service.repo.listRequests()).items[0]?.status).toBe('error')
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
    ).json().error,
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
test('expired reservations are recovered conservatively and idempotently', async () => {
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
    input_tokens: 50,
    usage_source: 'estimated',
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
      'cancelled',
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
  expect((await service.repo.listRequests()).items[0]?.status).toBe('error')
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
        { model: 'public-model', store: true },
        '/v1/responses',
      )
    ).statusCode,
  ).toBe(400)
})

test('withholds the successful terminal event if accounting persistence fails', async () => {
  const k=await setup();
  const accounting=new GatewayService(handle.db,{...service.options,encryptionKey:'accounting-fixture'})
  await accounting.repo.saveUpstream({name:'fixture',protocol:'openai',base_url:base,secret:accounting.vault.encrypt('secret-test-key')},1)
  const persist=vi.spyOn(accounting.repo,'finish').mockRejectedValue(new Error('accounting unavailable'))
  try {
    const result=await accounting.execute(await accounting.authenticate(k.token),{model:'public-model',stream:true},'openai',new AbortController().signal)
    let body='';for await(const frame of result.stream!)body+=frame
    expect(body).toContain('stream_error');expect(body).not.toContain('[DONE]')
    expect((await service.repo.listRequests()).items[0]?.status).toBe('reserved')
  } finally {persist.mockRestore();await accounting.transport.close()}
})
