import { Transform } from 'node:stream'
import type { FastifyInstance } from 'fastify'

/** Admission precedes parsing and authentication, so rejected work consumes neither. */
export function registerGatewayLifecycle(app: FastifyInstance) {
  app.decorateRequest('gatewayLease', undefined)
  const paths = new Set([
    ...['/v1', '/api/agent/v1'].flatMap((prefix) =>
      ['/chat/completions', '/responses', '/messages', '/web-search'].map((suffix) => prefix + suffix)),
    '/api/agent/anthropic/v1/messages',
  ])
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST' || !paths.has(request.url.split('?')[0]!)) return
    const lease = app.gatewayRuntime.admit(request.url.split('?')[0]!.endsWith('/web-search') ? 70000 : undefined)
    request.gatewayLease = lease
    let forceClose: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      forceClose = setTimeout(() => { if (!reply.raw.writableFinished) reply.raw.destroy() }, 1000)
      forceClose.unref()
    }
    lease.signal.addEventListener('abort', abort, { once: true })
    reply.raw.once('close', () => {
      lease.endResponse(!reply.raw.writableFinished)
      clearTimeout(forceClose)
      lease.signal.removeEventListener('abort', abort)
    })
    reply.raw.once('finish', () => lease.endResponse(false))
    request.raw.once('aborted', () => lease.endResponse(true))
  })
  app.addHook('preParsing', async (request, reply, payload) => {
    const lease = request.gatewayLease
    if (!lease) return payload
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          lease.accountInput(chunk.length)
          meter.receivedEncodedLength += chunk.length
          callback(null, chunk)
        } catch (error) { callback(error as Error) }
      },
    }) as Transform & { receivedEncodedLength: number }
    meter.receivedEncodedLength = 0
    // Fastify can reject Content-Length before attaching its parser listeners.
    // Keep an error owner and stop metering when that early response closes.
    meter.on('error', () => payload.unpipe(meter))
    reply.raw.once('close', () => { payload.unpipe(meter); meter.destroy() })
    payload.on('error', (error) => meter.destroy(error))
    return payload.pipe(meter)
  })
}
