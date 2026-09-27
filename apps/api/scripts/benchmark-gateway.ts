/** Independent-process, loopback-only memory baseline. Never uses an existing app DB or provider. */
import { fork, execFileSync, type ChildProcess } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { request as httpRequest, Agent } from 'node:http'
import { cpus, totalmem, tmpdir, release } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'tsup'
import pg from 'pg'
import { createDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { seedRbac } from './seed-rbac'
import { GatewayService } from '../src/modules/gateway/service'
import { admin_users } from '../src/db/schema'

type Sample = { type: 'sample'; role: string; phase: string; milestone?: string; time_ms: number; pid: number;
  rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number;
  active: number; completed: number; disconnected: number; sockets: number; upstreamActive: number;
  backpressure: number; cpu_percent: number; event_loop_utilization: number; event_loop_p99_ms: number;
  db_total: number; db_idle: number; db_waiting: number }
type Result = { phase: string; id?: string; status: number; first_ms: number; total_ms: number; bytes: number;
  aborted: boolean; ok: boolean; input?: number; output?: number; cached?: number; error?: string }
const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const adminUrl = process.env.BENCH_DATABASE_URL
if (!adminUrl) throw new Error('Set BENCH_DATABASE_URL to a disposable local PostgreSQL cluster with CREATEDB permission')
const database = new URL(adminUrl)
if (!['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)) throw new Error('Benchmark database must be loopback')
// pg accepts URL query overrides (including database/host); disallow them so the random DB cannot be bypassed.
if (database.search || database.hash) throw new Error('Benchmark database URL must not contain query overrides or fragments')
const name = `coati_bench_${Date.now()}_${randomBytes(3).toString('hex')}`
database.pathname = `/${name}`
const outputDir = await mkdtemp(resolve(tmpdir(), 'coati-memory-'))
await mkdir(resolve(apiRoot, 'node_modules/.cache'), { recursive: true })
const buildDir = await mkdtemp(resolve(apiRoot, 'node_modules/.cache/coati-bench-'))
const samples: Sample[] = [], results: Result[] = []
const phases: { name: string; started_ms: number; ended_ms?: number; parameters: object }[] = []
const children: ChildProcess[] = []
const loadAgent = new Agent({ keepAlive: true, maxSockets: 40, maxFreeSockets: 8 })
const abort = new AbortController()
let failure: string | undefined, created = false, cleaned = false
let setupService: GatewayService | undefined, handle: ReturnType<typeof createDb> | undefined
let ledger: Record<string, unknown>[] = [], ledgerSummary: unknown
let gateway: { child: ChildProcess; port: number; pid: number } | undefined
let upstream: { child: ChildProcess; port: number; pid: number } | undefined
const admin = new pg.Client({ connectionString: adminUrl })
const encryptionKey = randomBytes(32).toString('hex')
let token = '', currentPhase = 'startup', intentionalShutdown = false
let postgresVersion = '', appliedMigrations = 0
const baselineRssLimit = 1024 * 1024 * 1024
function fail(reason: string) { failure ??= reason; abort.abort() }
process.once('SIGINT', () => fail('Interrupted by SIGINT'))
process.once('SIGTERM', () => fail('Interrupted by SIGTERM'))
const watchdog = setTimeout(() => fail('Benchmark exceeded 10 minute safety deadline'), 600000)
const loadLoop = monitorEventLoopDelay({ resolution: 20 })
loadLoop.enable()
let loadCpu = process.cpuUsage(), loadClock = performance.now(), loadActive = 0
const loadTimer = setInterval(() => {
  const now = performance.now(), cpu = process.cpuUsage()
  samples.push({ type: 'sample', role: 'load', phase: currentPhase, time_ms: Date.now(), pid: process.pid,
    ...process.memoryUsage(), active: loadActive, completed: results.length, disconnected: 0, sockets: 0,
    upstreamActive: 0, backpressure: 0, db_total: 0, db_idle: 0, db_waiting: 0,
    cpu_percent: (cpu.user - loadCpu.user + cpu.system - loadCpu.system) / 1000 / (now - loadClock) * 100,
    event_loop_utilization: 0, event_loop_p99_ms: loadLoop.percentile(99) / 1e6 })
  loadCpu = cpu; loadClock = now; loadLoop.reset()
}, 500)
function check() { if (failure) throw new Error(failure) }
function startChild(role: string, extra: NodeJS.ProcessEnv = {}) {
  return new Promise<{ child: ChildProcess; port: number; pid: number }>((resolveReady, reject) => {
    // No inherited application credentials, proxies, NODE_OPTIONS or env-file loading.
    const child = fork(resolve(buildDir, 'benchmark-process.js'), [role], {
      execArgv: ['--expose-gc'], cwd: apiRoot,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), NODE_ENV: 'test', ...extra },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    children.push(child)
    const timer = setTimeout(() => { fail(`${role} startup timeout`); reject(new Error(failure)) }, 30000)
    let diagnostic = ''
    child.stderr?.on('data', (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(-2000) })
    child.on('error', () => { clearTimeout(timer); fail(`${role} spawn failed`); reject(new Error(failure)) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (!intentionalShutdown) { fail(`${role} exited unexpectedly (${code}); diagnostic retained locally`); reject(new Error(failure)) }
    })
    child.on('message', (message: Sample | { type: 'ready'; port: number; pid: number }) => {
      if (message.type === 'ready') { clearTimeout(timer); resolveReady({ child, port: message.port, pid: message.pid }) }
      else if (message.type === 'sample') {
        samples.push(message)
        if (message.role === 'gateway' && message.rss > baselineRssLimit) fail('Gateway exceeded 1 GiB benchmark stop threshold')
      }
    })
    child.on('exit', () => {
      if (diagnostic) void writeFile(resolve(outputDir, `${role}-stderr.txt`),
        diagnostic.replaceAll(encryptionKey, '[redacted]').replaceAll(database.toString(), '[database]'), { mode: 0o600 })
    })
  })
}
function phase(name: string, parameters: object = {}) {
  check()
  if (phases.length) phases[phases.length - 1]!.ended_ms = Date.now()
  currentPhase = name
  phases.push({ name, started_ms: Date.now(), parameters })
  for (const child of children) child.send?.({ type: 'phase', phase: name })
  console.log(`Memory baseline: ${name}`)
}
async function idle(ms: number) { await delay(ms, undefined, { signal: abort.signal }); check() }
async function runRequest(options: { large?: boolean; slow?: boolean; cancel?: boolean } = {}): Promise<Result> {
  loadActive++
  const started = performance.now()
  const row: Result = { phase: currentPhase, status: 0, first_ms: 0, total_ms: 0, bytes: 0, aborted: false, ok: false }
  const body = JSON.stringify({ model: options.large ? 'bench-large' : 'bench',
    messages: [{ role: 'user', content: 'Local deterministic memory fixture' }], stream: true,
    stream_options: { include_usage: true }, max_tokens: 256 })
  try {
    const response = await new Promise<import('node:http').IncomingMessage>((resolveResponse, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: gateway!.port, path: '/v1/chat/completions',
        method: 'POST', agent: loadAgent, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, resolveResponse)
      req.once('error', reject)
      req.end(body)
    })
    row.status = response.statusCode ?? 0
    row.id = response.headers['x-request-id'] as string | undefined
    let pending = '', done = false, streamError = false
    for await (const chunk of response) {
      if (!row.bytes) row.first_ms = performance.now() - started
      row.bytes += chunk.length
      if (options.cancel && row.status === 200) { row.aborted = true; response.destroy(); break }
      pending += chunk.toString()
      if (pending.length > 1024 * 1024) throw new Error('Fixture frame exceeded 1 MiB')
      let boundary: number
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
        if (!frame.startsWith('data: ')) continue
        const raw = frame.slice(6)
        if (raw === '[DONE]') { done = true; continue }
        const parsed = JSON.parse(raw)
        if (parsed.error) streamError = true
        if (parsed.usage) {
          row.input = parsed.usage.prompt_tokens; row.output = parsed.usage.completion_tokens
          row.cached = parsed.usage.prompt_tokens_details?.cached_tokens
        }
      }
      if (options.slow) await delay(100, undefined, { signal: abort.signal })
    }
    row.ok = row.status === 200 && (row.aborted || (done && !streamError && row.input === 128 && row.cached === 64 && row.output === (options.large ? 192 : 64)))
  } catch (error) { row.error = error instanceof Error ? error.name : 'UnknownError' }
  row.total_ms = performance.now() - started
  results.push(row)
  loadActive--
  return row
}
async function batch(concurrency: number, count: number, options: Parameters<typeof runRequest>[0] = {}) {
  let next = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next++ < count) { check(); const row = await runRequest(options); if (!row.ok) fail(`Unexpected result in ${currentPhase}: HTTP ${row.status}, ${row.error ?? 'stream/usage mismatch'}`) }
  }))
  check()
}
const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1] : null
async function sourceFingerprint() {
  const repo = resolve(apiRoot, '../..')
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'apps/api/src'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').sort()
  const hash = createHash('sha256')
  for (const file of files) hash.update(file).update(await readFile(resolve(repo, file)))
  return hash.digest('hex')
}
let soakSkipped = 0
try {
  await admin.connect()
  postgresVersion = (await admin.query('SHOW server_version')).rows[0].server_version
  await admin.query(`CREATE DATABASE "${name}"`)
  created = true
  console.log(`Memory baseline report directory: ${outputDir}`)
  await build({ config: false, entry: [resolve(apiRoot, 'scripts/benchmark-process.ts')], outDir: buildDir,
    format: ['esm'], target: 'node22', platform: 'node', splitting: true, sourcemap: false,
    skipNodeModulesBundle: true, silent: true, tsconfig: resolve(apiRoot, 'tsconfig.json') })
  upstream = await startChild('upstream')
  await runMigrations(database.toString(), () => {})
  await seedRbac({ databaseUrl: database.toString(), adminPassword: randomBytes(24).toString('hex'), incremental: true, log: () => {} })
  handle = createDb(database.toString())
  appliedMigrations = Number((await handle.pool.query('SELECT count(*) FROM drizzle.__drizzle_migrations')).rows[0].count)
  setupService = new GatewayService(handle.db, { encryptionKey, allowPrivate: true, timeoutMs: 60000, idleTimeoutMs: 30000 })
  const [owner] = await handle.db.select().from(admin_users)
  const provider = await setupService.saveUpstream({ name: 'Loopback memory fixture', protocol: 'openai',
    base_url: `http://127.0.0.1:${upstream.port}`, api_key: 'fixture-only',
    supported_models: ['fixture', 'fixture-large'], concurrency_limit: 40 })
  for (const large of [false, true]) await setupService.saveRoute({ model: large ? 'bench-large' : 'bench',
    upstream_id: provider.id, upstream_model: large ? 'fixture-large' : 'fixture' })
  const key = await setupService.createKey(owner!.id, { name: 'disposable-memory-baseline', models: ['bench', 'bench-large'],
    daily_limit: 1000000, concurrency_limit: 40, rpm_limit: 100000 })
  token = key.token
  await setupService.transport.close(); setupService = undefined
  gateway = await startChild('gateway', { TEST_DATABASE_URL: database.toString(), SECRET_KEY: encryptionKey,
    GATEWAY_ENCRYPTION_KEY: encryptionKey, GATEWAY_ALLOW_PRIVATE_UPSTREAMS: 'true', ENABLE_TASK_SCHEDULER: 'false',
    WEB_DIST_DIR: resolve(outputDir, 'no-web-assets'), INSTANCE_DIR: outputDir })
  phase('cold_idle', { seconds: 10 }); await idle(10000)
  phase('warmup', { concurrency: 2, requests: 8 }); await batch(2, 8)
  phase('warm_idle', { seconds: 5 }); await idle(5000)
  for (const concurrency of [8, 32]) {
    phase(`stream_${concurrency}`, { concurrency, requests: concurrency * 3, output_bytes_per_request: 65536 })
    await batch(concurrency, concurrency * 3)
  }
  phase('slow_clients', { concurrency: 8, requests: 8, output_bytes_per_request: 6291456, read_pause_ms: 100 })
  await batch(8, 8, { large: true, slow: true })
  phase('cancel', { concurrency: 8, requests: 8, cancel: 'after first body chunk' }); await batch(8, 8, { large: true, cancel: true })
  phase('soak', { seconds: 40, arrival_rps: 4, concurrency_cap: 8 })
  const active = new Set<Promise<void>>()
  const soakStarted = performance.now()
  for (let i = 0; i < 160; i++) {
    await idle(Math.max(0, soakStarted + i * 250 - performance.now()))
    if (active.size >= 8) { soakSkipped++; continue }
    const work = runRequest().then((row) => { if (!row.ok) fail(`Soak request failed: HTTP ${row.status}`) }).finally(() => active.delete(work))
    active.add(work)
  }
  await Promise.all(active); check()
  phase('recovery', { seconds: 30, forced_gc: false }); await idle(30000)
  const data = await handle.pool.query('SELECT id, status, input_tokens, output_tokens, cache_read_tokens, usage_source, http_status FROM gw_requests ORDER BY created_at')
  ledger = data.rows
  const mismatches: string[] = []
  for (const row of results) {
    const persisted = ledger.find((entry) => entry.id === row.id)
    if (!persisted || persisted.status === 'reserved') { mismatches.push(row.id ?? 'missing-id'); continue }
    if (row.aborted && persisted.status !== 'client_error') mismatches.push(row.id!)
    if (!row.aborted && persisted.status !== 'ok') mismatches.push(row.id!)
    if (!row.aborted && (Number(persisted.input_tokens) !== row.input || Number(persisted.output_tokens) !== row.output || Number(persisted.cache_read_tokens) !== row.cached || persisted.usage_source !== 'upstream')) mismatches.push(row.id!)
  }
  ledgerSummary = { requests: ledger.length, client_requests: results.length, reserved: ledger.filter((row) => row.status === 'reserved').length,
    statuses: ledger.reduce<Record<string, number>>((acc, row) => { const status = String(row.status); acc[status] = (acc[status] ?? 0) + 1; return acc }, {}),
    wire_usage_mismatches: mismatches.length, natural_recovery_gateway: samples.filter((s) => s.role === 'gateway' && s.phase === 'recovery').at(-1) }
  if (mismatches.length || ledger.length !== results.length) throw new Error('Ledger reconciliation failed')
  const recovered = samples.filter((s) => s.role === 'gateway' && s.phase === 'recovery').at(-1)
  if (!recovered || recovered.active || recovered.upstreamActive) throw new Error('Active requests remained after recovery')
  phase('gc_diagnostic', { forced_gc: true, excluded_from_natural_recovery: true })
  gateway.child.send({ type: 'gc' }); await idle(1500)
} catch (error) { failure ??= error instanceof Error ? error.message : 'Benchmark failed' }
finally {
  intentionalShutdown = true
  loadAgent.destroy()
  for (const child of children) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('exit', () => { clearTimeout(timer); resolveExit() })
      child.kill('SIGTERM')
    })
  }
  try { await setupService?.transport.close() } catch { failure ??= 'Setup transport cleanup failed' }
  try { await handle?.pool.end() } catch { failure ??= 'Setup database pool cleanup failed' }
  try {
    if (created) { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); cleaned = true }
  } catch { failure ??= `Database cleanup failed: ${name}` }
  await admin.end().catch(() => { failure ??= 'Admin database connection cleanup failed' })
  clearTimeout(watchdog)
  clearInterval(loadTimer); loadLoop.disable()
  if (phases.length) phases[phases.length - 1]!.ended_ms = Date.now()
  const summary = phases.map((p) => {
    const measured = samples.filter((s) => s.role === 'gateway' && s.phase === p.name && !s.milestone)
    const requests = results.filter((r) => r.phase === p.name)
    const peak = (field: keyof Sample) => Math.max(0, ...measured.map((s) => Number(s[field])))
    return { ...p, requests: requests.length, errors: requests.filter((r) => !r.ok).length,
      ttfb_p50_ms: percentile(requests.map((r) => r.first_ms), 0.5), ttfb_p95_ms: percentile(requests.map((r) => r.first_ms), 0.95),
      total_p95_ms: percentile(requests.map((r) => r.total_ms), 0.95), peak_rss_bytes: peak('rss'), peak_heap_bytes: peak('heapUsed'),
      peak_external_bytes: peak('external'), peak_array_buffer_bytes: peak('arrayBuffers'), peak_cpu_percent: peak('cpu_percent'),
      peak_event_loop_p99_ms: peak('event_loop_p99_ms'), peak_db_waiting: peak('db_waiting'), peak_active: peak('active'), last: measured.at(-1) }
  })
  const report = { status: failure ? 'failed' : 'completed', failure, output_dir: outputDir, database_cleaned: cleaned,
    child_processes_stopped: children.every((c) => c.exitCode !== null || c.signalCode !== null),
    environment: { node: process.version, platform: process.platform, arch: process.arch, os: release(), cpu: cpus()[0]?.model,
      logical_cpus: cpus().length, host_memory_bytes: totalmem(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: apiRoot, encoding: 'utf8' }).trim(),
      working_tree: 'includes local uncommitted changes', api_pid: gateway?.pid, upstream_pid: upstream?.pid, load_pid: process.pid },
    postgres_version: postgresVersion, applied_migrations: appliedMigrations,
    source_fingerprints: Object.fromEntries(await Promise.all(['scripts/benchmark-gateway.ts', 'scripts/benchmark-process.ts', '../../pnpm-lock.yaml'].map(async (file) =>
      [file, createHash('sha256').update(await readFile(resolve(apiRoot, file))).digest('hex')]))),
    api_source_sha256: await sourceFingerprint(),
    boundaries: ['Local HTTP loopback only; OpenAI Chat streaming; no real providers, TLS or proxies',
      'Gateway runs compiled JS, no tsx/watch; logger and scheduler disabled; production logging overhead excluded',
      'Fresh PostgreSQL DB with real auth, finite key quota, reservation and usage settlement; DB RSS excluded',
      '500ms memory/pool samples may miss shorter peaks; first body time is not first model token time',
      '40-second soak is a short baseline, not long-term stability or production capacity proof',
      'Forced GC is separately labeled and never used as natural recovery evidence',
      'Fixture usage is synthetic and checked against the ledger, not tokenized output size'],
    stop_rss_bytes: baselineRssLimit, soak_skipped_arrivals: soakSkipped, ledger: ledgerSummary, phases: summary,
    milestones: samples.filter((s) => s.milestone && s.milestone !== 'phase_start') }
  await writeFile(resolve(outputDir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  await writeFile(resolve(outputDir, 'samples.json'), JSON.stringify(samples), { mode: 0o600 })
  await writeFile(resolve(outputDir, 'requests.json'), JSON.stringify(results, null, 2), { mode: 0o600 })
  await writeFile(resolve(outputDir, 'ledger.json'), JSON.stringify(ledger, null, 2), { mode: 0o600 })
  await rm(buildDir, { recursive: true, force: true })
  console.log(JSON.stringify({ status: report.status, report: resolve(outputDir, 'report.json'), database_cleaned: cleaned, failure }))
}
if (failure) process.exitCode = 1
