import type { Db } from '@/db/client'
import { GatewayService, type GatewayOptions } from './service'
import { GatewayRequestLease } from './request-lifecycle'
import { GatewayError } from './schema'

export function runtimeLimits(env: NodeJS.ProcessEnv = process.env) {
  const positive = (name: string, fallback: number, max: number) => {
    const raw = env[name]?.trim()
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`)
    return value
  }
  return {
    maxActive: positive('GATEWAY_MAX_ACTIVE_REQUESTS', 256, 10000),
    maxBufferedBytes: positive('GATEWAY_BUFFER_BUDGET_BYTES', 64 * 1024 * 1024, 1024 * 1024 * 1024),
    drainMs: positive('GATEWAY_DRAIN_GRACE_MS', 10000, 180000),
  }
}

/** One owner per API instance. HTTP plugins borrow the service; they never close its pools. */
export class GatewayRuntime {
  readonly service: GatewayService
  private timer?: ReturnType<typeof setInterval>
  private recovery?: Promise<void>
  private closing?: Promise<void>
  private stopping = false
  private readonly requests = new Set<GatewayRequestLease>()
  private bufferedBytes = 0
  private drainTimer?: ReturnType<typeof setTimeout>

  constructor(db: Db, options: GatewayOptions, private readonly report: (error: unknown) => void,
    readonly limits = runtimeLimits()) {
    this.service = new GatewayService(db, options, report)
  }

  get accepting() { return !this.stopping }
  snapshot() { return { activeRequests: this.requests.size, bufferedBytes: this.bufferedBytes, accepting: this.accepting } }

  admit(timeoutMs = this.service.options.timeoutMs): GatewayRequestLease {
    if (this.stopping) throw new GatewayError(503, '网关正在关闭，请稍后重试', 'gateway_draining')
    if (this.requests.size >= this.limits.maxActive)
      throw new GatewayError(503, '网关实例繁忙，请稍后重试', 'gateway_capacity')
    const lease = new GatewayRequestLease(timeoutMs, (delta) => {
      if (delta > 0 && this.bufferedBytes + delta > this.limits.maxBufferedBytes)
        throw new GatewayError(503, '网关实例缓冲预算已满，请稍后重试', 'gateway_buffer_capacity')
      this.bufferedBytes += delta
    }, () => this.requests.delete(lease))
    this.requests.add(lease)
    return lease
  }

  beginDrain() {
    if (this.stopping) return
    this.stopping = true
    clearInterval(this.timer)
    this.drainTimer = setTimeout(() => {
      for (const lease of this.requests)
        lease.abort(new GatewayError(503, '网关关闭，正在取消在途请求', 'gateway_draining'))
    }, this.limits.drainMs)
    this.drainTimer.unref()
  }

  start() {
    if (this.timer || this.stopping) return
    this.timer = setInterval(() => {
      if (this.recovery || this.stopping) return
      this.recovery = this.service.recoverInterrupted()
        .catch(this.report)
        .finally(() => { this.recovery = undefined })
    }, 30000)
    this.timer.unref()
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.beginDrain()
    this.closing = (async () => {
      // Recovery still uses the DB. The app closes its DB pool only after this owner finishes.
      await this.recovery
      await Promise.all([...this.requests].map((lease) => lease.done))
      clearTimeout(this.drainTimer)
      await this.service.transport.close()
    })()
    return this.closing
  }
}
