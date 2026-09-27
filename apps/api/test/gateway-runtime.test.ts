import { afterEach, expect, test, vi } from 'vitest'
import { createDb } from '../src/db/client'
import { GatewayRuntime } from '../src/modules/gateway/runtime'
import { TEST_DATABASE_URL } from './helpers'

afterEach(() => vi.useRealTimers())

test('runtime does not overlap recovery and waits for it before closing shared transport once', async () => {
  vi.useFakeTimers()
  const handle = createDb(TEST_DATABASE_URL)
  const runtime = new GatewayRuntime(handle.db, { encryptionKey: 'fixture', allowPrivate: true, timeoutMs: 1000, idleTimeoutMs: 1000 }, vi.fn())
  let finish!: () => void
  const recovery = vi.spyOn(runtime.service, 'recoverInterrupted').mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  const close = vi.spyOn(runtime.service.transport, 'close')
  try {
    runtime.start(); runtime.start()
    await vi.advanceTimersByTimeAsync(60000)
    expect(recovery).toHaveBeenCalledTimes(1)
    const first = runtime.close()
    expect(runtime.close()).toBe(first)
    expect(close).not.toHaveBeenCalled()
    finish()
    await first
    expect(close).toHaveBeenCalledTimes(1)
    runtime.start()
    await vi.advanceTimersByTimeAsync(60000)
    expect(recovery).toHaveBeenCalledTimes(1)
  } finally { finish?.(); await runtime.close(); await handle.pool.end() }
})

test('failed recovery is reported and a later tick can retry', async () => {
  vi.useFakeTimers()
  const handle = createDb(TEST_DATABASE_URL)
  const report = vi.fn()
  const runtime = new GatewayRuntime(handle.db, { encryptionKey: 'fixture', allowPrivate: true, timeoutMs: 1000, idleTimeoutMs: 1000 }, report)
  const failure = new Error('temporary DB failure')
  const recover = vi.spyOn(runtime.service, 'recoverInterrupted').mockRejectedValueOnce(failure).mockResolvedValue(undefined)
  try {
    runtime.start()
    await vi.advanceTimersByTimeAsync(60000)
    expect(report).toHaveBeenCalledWith(failure)
    expect(recover).toHaveBeenCalledTimes(2)
  } finally { await runtime.close(); await handle.pool.end() }
})

test('admission keeps capacity until response and asynchronous work both finish', async () => {
  const handle = createDb(TEST_DATABASE_URL)
  const runtime = new GatewayRuntime(handle.db, { encryptionKey: 'fixture', allowPrivate: true, timeoutMs: 1000, idleTimeoutMs: 1000 }, vi.fn(), { maxActive: 1, maxBufferedBytes: 8, drainMs: 10 })
  const lease = runtime.admit()
  let finish!: () => void
  const work = lease.run(() => new Promise<void>((resolve) => { finish = resolve }))
  try {
    lease.accountInput(8)
    expect(() => lease.accountInput(1)).toThrow('缓冲预算')
    lease.endResponse(true)
    expect(() => runtime.admit()).toThrow('繁忙')
    expect(runtime.snapshot().bufferedBytes).toBe(8)
    finish(); await work; await lease.done
    expect(runtime.snapshot()).toMatchObject({ activeRequests: 0, bufferedBytes: 0 })
  } finally { finish(); await work; lease.endResponse(true); await runtime.close(); await handle.pool.end() }
})

test('drain rejects new work and cancels existing work after grace', async () => {
  vi.useFakeTimers()
  const handle = createDb(TEST_DATABASE_URL)
  const runtime = new GatewayRuntime(handle.db, { encryptionKey: 'fixture', allowPrivate: true, timeoutMs: 1000, idleTimeoutMs: 1000 }, vi.fn(), { maxActive: 1, maxBufferedBytes: 8, drainMs: 10 })
  const lease = runtime.admit()
  try {
    runtime.beginDrain()
    expect(() => runtime.admit()).toThrow('正在关闭')
    expect(lease.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    expect(lease.signal.reason.code).toBe('gateway_draining')
  } finally { lease.endResponse(true); await runtime.close(); await handle.pool.end() }
})

test('destroying an unread output closes its source and releases its lease', async () => {
  const handle = createDb(TEST_DATABASE_URL)
  const runtime = new GatewayRuntime(handle.db, { encryptionKey: 'fixture', allowPrivate: true, timeoutMs: 1000, idleTimeoutMs: 1000 }, vi.fn())
  const lease = runtime.admit()
  const close = vi.fn(async () => ({ done: true as const, value: undefined }))
  const stream = lease.stream({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: 'event' }), return: close }) })
  stream.on('error', () => {})
  try {
    lease.endResponse(true)
    await lease.done
    expect(close).toHaveBeenCalledTimes(1)
    expect(runtime.snapshot().activeRequests).toBe(0)
  } finally { stream.destroy(); lease.endResponse(true); await runtime.close(); await handle.pool.end() }
})

test('output exceeding the budget cancels upstream and releases accounting', async () => {
  const handle = createDb(TEST_DATABASE_URL)
  const runtime = new GatewayRuntime(handle.db, { encryptionKey: 'fixture', allowPrivate: true, timeoutMs: 1000, idleTimeoutMs: 1000 }, vi.fn(), { maxActive: 1, maxBufferedBytes: 8, drainMs: 10 })
  const lease = runtime.admit()
  let closed = false
  const stream = lease.stream((async function* () { try { yield '123456789' } finally { closed = true } })())
  try {
    await expect((async () => { for await (const _chunk of stream) { /* consume */ } })()).rejects.toThrow('缓冲预算')
    lease.endResponse(true); await lease.done
    expect(closed).toBe(true)
    expect(runtime.snapshot()).toMatchObject({ activeRequests: 0, bufferedBytes: 0 })
  } finally { stream.destroy(); lease.endResponse(true); await runtime.close(); await handle.pool.end() }
})
