/** Compiled, disposable benchmark child. Never loaded by the production server. */
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { channel } from 'node:diagnostics_channel'
import { createRequire } from 'node:module'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type pg from 'pg'

const role = process.argv[2]
let phase = 'startup'
let active = 0
let completed = 0
let disconnected = 0
let sockets = 0
let backpressure = 0
let upstreamActive = 0
let pool: pg.Pool | undefined
let loadedOptionalLibraries: string[] = []
const loop = monitorEventLoopDelay({ resolution: 20 })
loop.enable()
let cpu = process.cpuUsage()
let clock = performance.now()
let elu = performance.eventLoopUtilization()
const send = (message: object) => { if (process.connected) process.send?.(message) }
function sample(milestone?: string) {
  const now = performance.now()
  const nextCpu = process.cpuUsage()
  const nextElu = performance.eventLoopUtilization()
  send({ type: 'sample', role, phase, milestone, time_ms: Date.now(), pid: process.pid,
    ...process.memoryUsage(), active, completed, disconnected, sockets, upstreamActive, backpressure, loadedOptionalLibraries,
    cpu_percent: ((nextCpu.user - cpu.user + nextCpu.system - cpu.system) / 1000) / (now - clock) * 100,
    event_loop_utilization: performance.eventLoopUtilization(nextElu, elu).utilization,
    event_loop_p99_ms: loop.percentile(99) / 1e6,
    db_total: pool?.totalCount ?? 0, db_idle: pool?.idleCount ?? 0, db_waiting: pool?.waitingCount ?? 0,
  })
  cpu = nextCpu; clock = now; elu = nextElu; loop.reset()
}
sample('runtime_loaded')
const timer = setInterval(() => sample(), 500)
let shutdown: (() => Promise<void>) | undefined
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  clearInterval(timer)
  loop.disable()
  await shutdown?.()
  process.exit(0)
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
process.on('disconnect', () => { void stop() })
process.on('message', (message: { type: string; phase?: string }) => {
  if (message.type === 'phase') { phase = message.phase!; sample('phase_start') }
  if (message.type === 'gc') { global.gc?.(); sample('forced_gc_diagnostic_only') }
})

if (role === 'upstream') {
  const server = createServer(async (request, response) => {
    active++
    let done = false
    const abort = new AbortController()
    response.once('close', () => {
      active--; if (done) completed++; else disconnected++
      abort.abort()
    })
    try {
      let body = ''
      for await (const chunk of request) {
        body += chunk.toString()
        if (body.length > 16384) { response.writeHead(413).end(); return }
      }
      const model = (JSON.parse(body) as { model: string }).model
      const large = model === 'fixture-large'
      const frames = large ? 192 : 64
      const content = 'x'.repeat(large ? 32768 : 1024)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const write = async (text: string) => {
        if (!response.write(text)) {
          backpressure++
          await once(response, 'drain', { signal: abort.signal })
        }
      }
      for (let i = 0; i < frames; i++) {
        await delay(large ? 5 : 25, undefined, { signal: abort.signal })
        await write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)
      }
      await write(`data: ${JSON.stringify({ id: 'fixture', model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 128, completion_tokens: frames, total_tokens: 128 + frames,
          prompt_tokens_details: { cached_tokens: 64 } } })}\n\ndata: [DONE]\n\n`)
      done = true
      response.end()
    } catch {
      response.destroy()
    }
  })
  server.on('connection', (socket) => { sockets++; socket.once('close', () => sockets--) })
  shutdown = async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  send({ type: 'ready', role, pid: process.pid, port: (server.address() as { port: number }).port })
} else if (role === 'gateway') {
  const { buildApp } = await import('../src/app')
  const { loadConfig } = await import('../src/config')
  const { createDb } = await import('../src/db/client')
  const require = createRequire(import.meta.url)
  loadedOptionalLibraries = ['exceljs', 'xlsx'].filter((name) => Boolean(require.cache[require.resolve(name)]))
  sample('application_imported')
  const handle = createDb(process.env.TEST_DATABASE_URL!)
  pool = handle.pool
  const app = await buildApp({ config: loadConfig(), dbHandle: handle, logger: false })
  app.server.on('connection', (socket) => { sockets++; socket.once('close', () => sockets--) })
  // Raw HTTP lifetime includes aborted responses; never retain request bodies or identities.
  app.server.on('request', (_request, response: ServerResponse) => {
    active++
    response.once('close', () => {
      active--
      if (response.writableFinished) completed++; else disconnected++
    })
  })
  channel('undici:request:create').subscribe(() => upstreamActive++)
  channel('undici:request:trailers').subscribe(() => upstreamActive--)
  channel('undici:request:error').subscribe(() => upstreamActive--)
  shutdown = async () => { app.server.closeAllConnections(); await app.close(); await handle.pool.end() }
  await app.listen({ port: 0, host: '127.0.0.1' })
  sample('application_ready')
  send({ type: 'ready', role, pid: process.pid, port: (app.server.address() as { port: number }).port })
} else {
  throw new Error('Unknown benchmark child role')
}
