/** Isolated full HTTP gateway baseline. Never uses an existing application database or a real model provider. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRbac } from './seed-rbac'
import { GatewayService } from '../src/modules/gateway/service'
import { admin_users } from '../src/db/schema'

const adminUrl = process.env.BENCH_DATABASE_URL
if (!adminUrl)
  throw new Error(
    'Set BENCH_DATABASE_URL to a disposable local PostgreSQL cluster with CREATEDB permission',
  )
const name = `coati_bench_${Date.now()}`
const database = new URL(adminUrl)
database.pathname = `/${name}`
const admin = new pg.Client({ connectionString: adminUrl })
await admin.connect()
await admin.query(`CREATE DATABASE "${name}"`)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const upstream = createServer(async (request, response) => {
  for await (const _chunk of request) {
    /* Consume the complete request. */
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  await delay(10)
  for (let i = 0; i < 6 && !response.destroyed; i++) {
    if (
      !response.write(
        `data: ${JSON.stringify({ model: 'fixture', choices: [{ delta: { content: 'hello' } }] })}\n\n`,
      )
    )
      await once(response, 'drain')
    await delay(5)
  }
  response.end(
    'data: {"usage":{"prompt_tokens":10,"completion_tokens":6},"choices":[]}\n\ndata: [DONE]\n\n',
  )
})
const encryptionKey = randomBytes(32).toString('hex')
process.env.GATEWAY_ENCRYPTION_KEY = encryptionKey
process.env.GATEWAY_ALLOW_PRIVATE_UPSTREAMS = 'true'
const config = loadConfig({
  NODE_ENV: 'test',
  TEST_DATABASE_URL: database.toString(),
  SECRET_KEY: encryptionKey,
  ENABLE_TASK_SCHEDULER: 'false',
})
const handle = createDb(database.toString())
let app: Awaited<ReturnType<typeof buildApp>> | undefined
const service = new GatewayService(handle.db, {
  encryptionKey,
  allowPrivate: true,
  timeoutMs: 60000,
  idleTimeoutMs: 30000,
})
try {
  await runMigrations(database.toString(), () => {})
  await seedRbac({
    databaseUrl: database.toString(),
    adminPassword: randomBytes(24).toString('hex'),
    incremental: true,
    log: () => {},
  })
  const [owner] = await handle.db.select().from(admin_users)
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamPort = (upstream.address() as { port: number }).port
  const provider = await service.saveUpstream({
    name: 'Local fixture',
    protocol: 'openai',
    base_url: `http://127.0.0.1:${upstreamPort}`,
    api_key: 'fixture-only',
  })
  await service.saveRoute({
    model: 'bench',
    upstream_id: provider.id,
    upstream_model: 'fixture',
  })
  const key = await service.createKey(owner!.id, {
    name: 'benchmark',
    models: ['bench'],
    daily_limit: 0,
    concurrency_limit: 1000,
    rpm_limit: 100000,
  })
  app = await buildApp({ config, dbHandle: handle, logger: false })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/v1/chat/completions`
  async function request() {
    const start = performance.now()
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'bench',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        max_tokens: 20,
      }),
    })
    let first = 0,
      output = ''
    for await (const chunk of r.body!) {
      if (!first) first = performance.now() - start
      output += Buffer.from(chunk).toString()
    }
    if (
      r.status !== 200 ||
      !output.includes('[DONE]') ||
      output.includes('gateway_error')
    )
      throw new Error(`Benchmark request failed: HTTP ${r.status}`)
    return { first, total: performance.now() - start }
  }
  for (let i = 0; i < 10; i++) await request()
  const reports = []
  for (const concurrency of [1, 20, 100]) {
    const count = 200,
      samples: Awaited<ReturnType<typeof request>>[] = []
    let next = 0
    const started = performance.now()
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next++ < count) samples.push(await request())
      }),
    )
    const elapsed = performance.now() - started
    const percentile = (field: 'first' | 'total', p: number) =>
      Number(
        samples
          .map((x) => x[field])
          .sort((a, b) => a - b)
          [Math.ceil(p * samples.length) - 1]!.toFixed(2),
      )
    reports.push({
      concurrency,
      requests: samples.length,
      rps: Number(((count * 1000) / elapsed).toFixed(2)),
      ttfb_p50_ms: percentile('first', 0.5),
      ttfb_p95_ms: percentile('first', 0.95),
      total_p95_ms: percentile('total', 0.95),
      rss_mib: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
    })
  }
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        platform: process.platform,
        arch: process.arch,
        date: new Date().toISOString(),
        fixture:
          '6 SSE deltas, 10ms initial delay, 5ms per delta; loopback; same process load generator and fake upstream',
        database:
          'PostgreSQL, fresh isolated database; auth, reservation and accounting enabled',
        reports,
      },
      null,
      2,
    ),
  )
} finally {
  app?.server.closeAllConnections()
  upstream.closeAllConnections()
  await app?.close()
  await service.transport.close()
  await handle.pool.end()
  upstream.close()
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
  await admin.end()
}
