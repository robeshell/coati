import { Readable } from 'node:stream'
import { z, ZodError } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getCurrentAdminUser, menuPermissionRequired } from '@/common/auth'
import { GatewayService, gatewayOptions } from './service'
import { GatewayError } from './schema'
const idOf = (request: FastifyRequest) =>
  z.coerce
    .number()
    .int()
    .positive()
    .parse((request.params as { id: string }).id)
export async function registerGatewayAdmin(app: FastifyInstance) {
  const service = new GatewayService(
    app.db,
    gatewayOptions(app.config),
    (error) => app.log.error({ err: error }, 'Gateway accounting failure'),
  )
  app.addHook('onClose', () => service.transport.close())
  const owner = async (request: FastifyRequest) =>
    (await getCurrentAdminUser(request))!.id
  for (const resource of ['upstreams', 'routes'] as const) {
    const path = `/api/admin/gateway/${resource}`,
      permission = `gateway_${resource}`
    app.get(
      path,
      { preHandler: menuPermissionRequired(permission) },
      async () => ({
        items:
          resource === 'upstreams'
            ? await service.upstreams()
            : await service.repo.routes(),
      }),
    )
    app.post(
      path,
      { preHandler: menuPermissionRequired(permission + '_add') },
      async (request, reply) =>
        reply
          .code(201)
          .send(
            resource === 'upstreams'
              ? await service.saveUpstream(request.body)
              : await service.saveRoute(request.body),
          ),
    )
    app.put(
      path + '/:id',
      { preHandler: menuPermissionRequired(permission + '_edit') },
      async (request) =>
        resource === 'upstreams'
          ? service.saveUpstream(request.body, idOf(request))
          : service.saveRoute(request.body, idOf(request)),
    )
    app.delete(
      path + '/:id',
      { preHandler: menuPermissionRequired(permission + '_delete') },
      async (request) => {
        const row = await service.repo.disable(resource, idOf(request))
        if (!row) throw new GatewayError(404, '资源不存在')
        return { success: true }
      },
    )
  }
  app.get(
    '/api/admin/gateway/keys',
    { preHandler: menuPermissionRequired('gateway_keys') },
    async (request) => ({ items: await service.keys(await owner(request)) }),
  )
  app.post(
    '/api/admin/gateway/keys',
    { preHandler: menuPermissionRequired('gateway_keys_add') },
    async (request, reply) =>
      reply
        .code(201)
        .send(await service.createKey(await owner(request), request.body)),
  )
  app.delete(
    '/api/admin/gateway/keys/:id',
    { preHandler: menuPermissionRequired('gateway_keys_delete') },
    async (request) => {
      if (!(await service.repo.revoke(idOf(request), await owner(request))))
        throw new GatewayError(404, '令牌不存在')
      return { success: true }
    },
  )
  app.get(
    '/api/admin/gateway/requests',
    { preHandler: menuPermissionRequired('gateway_requests') },
    async (request) =>
      service.repo.listRequests(
        z.coerce
          .number()
          .int()
          .min(1)
          .max(100000)
          .parse((request.query as { page?: string }).page || 1),
      ),
  )
  app.get(
    '/api/admin/gateway/requests/:id/attempts',
    { preHandler: menuPermissionRequired('gateway_requests') },
    async (request) => ({
      items: await service.repo.attempts(
        z
          .string()
          .uuid()
          .parse((request.params as { id: string }).id),
      ),
    }),
  )
  app.get(
    '/api/admin/gateway/overview',
    { preHandler: menuPermissionRequired('gateway_overview') },
    () => service.repo.summary(),
  )
  app.post(
    '/api/admin/gateway/device/confirm',
    { preHandler: menuPermissionRequired('gateway_keys_add') },
    async (request) => {
      const { user_code } = z
        .object({ user_code: z.string().min(1).max(20) })
        .parse(request.body)
      if (
        !(await service.repo.confirmDevice(
          user_code.trim().toUpperCase(),
          await owner(request),
        ))
      )
        throw new GatewayError(400, '授权码无效、已使用或已过期')
      return { success: true }
    },
  )
}
export async function registerGatewayApi(app: FastifyInstance) {
  const service = new GatewayService(
    app.db,
    gatewayOptions(app.config),
    (error) => app.log.error({ err: error }, 'Gateway accounting failure'),
  )
  app.addHook('onClose', () => service.transport.close())
  const recover = setInterval(() => {
    service.repo
      .recoverExpired()
      .catch((error) =>
        app.log.error({ err: error }, 'Reservation recovery failed'),
      )
  }, 30000)
  recover.unref()
  app.addHook('onClose', async () => clearInterval(recover))
  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof GatewayError
        ? error.status
        : error instanceof ZodError
          ? 400
          : error instanceof Error &&
              'statusCode' in error &&
              typeof error.statusCode === 'number' &&
              error.statusCode >= 400 &&
              error.statusCode < 500
            ? error.statusCode
            : 500
    const message =
      error instanceof GatewayError
        ? error.message
        : error instanceof ZodError
          ? '请求参数无效'
          : status < 500
            ? '请求参数无效'
            : '网关内部错误'
    if (status === 500)
      request.log.error({ err: error }, 'Gateway request failed')
    reply.code(status).send({
      error: {
        message,
        type: 'gateway_error',
        code: error instanceof GatewayError ? error.code : 'invalid_request',
      },
      request_id: request.id,
    })
  })
  const authenticate = (request: FastifyRequest) => {
    const auth = request.headers.authorization,
      apiKey = request.headers['x-api-key']
    return service.authenticate(
      auth?.replace(/^Bearer\s+/i, '') ||
        (typeof apiKey === 'string' ? apiKey : ''),
    )
  }
  for (const prefix of ['/v1', '/api/agent/v1']) {
    app.get(prefix + '/models', async (request) =>
      service.models(await authenticate(request)),
    )
    for (const [suffix, protocol] of [
      ['/chat/completions', 'openai'],
      ['/messages', 'anthropic'],
      ['/responses', 'responses'],
    ] as const) {
      app.post(prefix + suffix, async (request, reply) => {
        const key = await authenticate(request),
          abort = new AbortController()
        reply.raw.on('close', () => {
          if (!reply.raw.writableFinished) abort.abort()
        })
        const result = await service.execute(
          key,
          request.body,
          protocol,
          abort.signal,
        )
        reply
          .header('X-Request-Id', result.id)
          .header('X-Agent-Request-Id', result.id)
        if (result.stream)
          return reply
            .header('Content-Type', 'text/event-stream; charset=utf-8')
            .header('Cache-Control', 'no-store')
            .header('X-Accel-Buffering', 'no')
            .send(
              Readable.from(result.stream, {
                objectMode: false,
                highWaterMark: 65536,
              }),
            )
        return result.json
      })
    }
  }
  // The initial device grant is short-lived and bounded per IP; confirmation is cookie-authenticated + CSRF protected.
  const limits = new Map<string, { at: number; count: number }>()
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.includes('/device/')) return
    const now = Date.now()
    for (const [ip, v] of limits) if (now - v.at > 60000) limits.delete(ip)
    if (limits.size > 10000 && !limits.has(request.ip))
      return reply.code(429).send({ error: 'slow_down' })
    const current = limits.get(request.ip) || { at: now, count: 0 }
    limits.set(request.ip, current)
    if (++current.count > 60)
      return reply.code(429).send({ error: 'slow_down' })
  })
  app.post('/api/agent/auth/device/start', () => service.startDevice())
  app.post('/api/agent/auth/device/poll', async (request, reply) => {
    const body = z
      .object({ device_code: z.string().min(1).max(100) })
      .parse(request.body)
    try {
      return await service.pollDevice(body.device_code)
    } catch (error) {
      if (error instanceof GatewayError)
        return reply.code(error.status).send({ error: error.code })
      throw error
    }
  })
}
