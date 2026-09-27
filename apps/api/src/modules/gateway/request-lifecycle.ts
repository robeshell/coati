import { Readable } from 'node:stream'
import { GatewayError } from './schema'

/** Instance capacity stays owned until both the HTTP response and asynchronous work end. */
export class GatewayRequestLease {
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private work = 0
  private responseEnded = false
  private finished = false
  private inputBytes = 0
  private readonly timer: ReturnType<typeof setTimeout>
  private resolveDone!: () => void
  readonly done = new Promise<void>((resolve) => { this.resolveDone = resolve })

  constructor(
    timeoutMs: number,
    private readonly changeBytes: (delta: number) => void,
    private readonly release: () => void,
  ) {
    this.timer = setTimeout(() => this.abort(new GatewayError(504, '网关请求超过总时间限制', 'gateway_deadline')), timeoutMs)
    this.timer.unref()
  }

  check() { this.signal.throwIfAborted() }
  abort(reason: unknown = new Error('客户端中断请求')) { this.controller.abort(reason) }

  accountInput(bytes: number) {
    this.check()
    this.changeBytes(bytes)
    this.inputBytes += bytes
  }

  endResponse(interrupted: boolean) {
    if (interrupted) this.abort()
    this.responseEnded = true
    this.maybeFinish()
  }

  private hold() {
    this.check()
    this.work++
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.work--
      this.maybeFinish()
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const finish = this.hold()
    try { return await task() } finally { finish() }
  }

  private maybeFinish() {
    if (this.finished || !this.responseEnded || this.work) return
    this.finished = true
    clearTimeout(this.timer)
    this.changeBytes(-this.inputBytes)
    this.inputBytes = 0
    this.release()
    this.resolveDone()
  }

  /** Keep at most one encoded event here; split writes without changing SSE event boundaries. */
  stream(source: AsyncIterable<string | Buffer>): Readable {
    const iterator = source[Symbol.asyncIterator]()
    const finish = this.hold()
    let pending: Buffer | undefined
    let offset = 0
    let heldBytes = 0
    let closing: Promise<void> | undefined
    const releaseBytes = () => {
      this.changeBytes(-heldBytes)
      heldBytes = 0; pending = undefined; offset = 0
    }
    const close = () => closing ??= (async () => {
      try { await iterator.return?.() }
      finally { releaseBytes(); this.signal.removeEventListener('abort', cancel); finish() }
    })()
    const chunks: AsyncIterableIterator<Buffer> = {
      [Symbol.asyncIterator]() { return this },
      next: async (): Promise<IteratorResult<Buffer>> => {
        try {
          this.check()
          if (!pending || offset >= pending.length) {
            releaseBytes()
            const item = await iterator.next()
            this.check()
            if (item.done) { await close(); return { done: true, value: undefined } }
            const bytes = Buffer.byteLength(item.value)
            this.changeBytes(bytes)
            heldBytes = bytes
            pending = Buffer.from(item.value)
          }
          const value = pending.subarray(offset, offset + 65536)
          offset += value.length
          return { done: false, value }
        } catch (error) {
          this.abort(error)
          await close()
          throw error
        }
      },
      async return() { await close(); return { done: true as const, value: undefined } },
      throw: async (error: unknown) => { this.abort(error); await close(); throw error },
    }
    const readable = Readable.from(chunks, { objectMode: false, highWaterMark: 65536 })
    const cancel = () => readable.destroy(this.signal.reason instanceof Error ? this.signal.reason : new Error('请求已取消'))
    this.signal.addEventListener('abort', cancel, { once: true })
    if (this.signal.aborted) cancel()
    return readable
  }
}

/** Runtime cancellation is a server-side failure, not a client disconnect. */
export function cancellationStatus(signal: AbortSignal): 'client_error' | 'stream_error' {
  return signal.reason instanceof GatewayError && signal.reason.code.startsWith('gateway_') ? 'stream_error' : 'client_error'
}
