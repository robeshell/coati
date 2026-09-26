import {
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { Readable } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { boundResponseLifetime } from '../src/modules/gateway/response-deadline'

for (const contentType of ['text/event-stream', 'application/json']) {
  test(`${contentType}: a paused HTTP reader cannot retain a response past deadline`, async () => {
    let raw: ServerResponse | undefined
    let stopped = false
    const server = createServer((_req, res) => {
      raw = res
      boundResponseLifetime(res, 100, 100)
      res.setHeader('content-type', contentType)
      const source = Readable.from(
        (async function* () {
          try {
            for (let i = 0; i < 8192; i++) yield Buffer.alloc(32768, 120)
          } finally {
            stopped = true
          }
        })(),
        { objectMode: false, highWaterMark: 65536 },
      )
      res.once('close', () => source.destroy())
      source.pipe(res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    let incoming: IncomingMessage | undefined
    const client = request(`http://127.0.0.1:${(server.address() as any).port}`)
    client.on('error', () => {})
    const received = new Promise<IncomingMessage>((resolve, reject) => {
      client.once('response', resolve)
      client.once('error', reject)
    })
    client.end()
    try {
      incoming = await received
      incoming.on('error', () => {})
      incoming.pause()
      expect(raw?.writableFinished).toBe(false)
      await expect.poll(() => raw?.destroyed, { timeout: 2000 }).toBe(true)
      await expect.poll(() => stopped, { timeout: 2000 }).toBe(true)
      expect(raw?.writableFinished).toBe(false)
    } finally {
      incoming?.destroy()
      client.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}

test('finished or disconnected responses cancel timers and remove listeners', () => {
  vi.useFakeTimers()
  try {
    for (const event of ['finish', 'close']) {
      const raw = new (require('node:events').EventEmitter)()
      raw.destroy = vi.fn()
      boundResponseLifetime(raw, 100)
      expect(vi.getTimerCount()).toBe(1)
      raw.emit(event)
      expect(vi.getTimerCount()).toBe(0)
      expect(raw.listenerCount('finish') + raw.listenerCount('close')).toBe(0)
      vi.advanceTimersByTime(2000)
      expect(raw.destroy).not.toHaveBeenCalled()
    }
  } finally {
    vi.useRealTimers()
  }
})
