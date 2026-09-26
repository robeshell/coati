import { legacyCacheTest } from './cache-test-compat'
import { executeWithServerTools } from './server-tool-loop'
import { CacheTestRepository } from './cache-test-repository'
import { WebSearchService } from './web-search'
import { SearchSettingsService } from './search-settings'
import { CacheTestService, cacheTestQuery } from './cache-test'
import { ModelProfileRepository } from './model-profile-repository'
import { listProfiles, saveProfile, syncProfiles } from './model-profile'
import {
  saveLegacyAccount,
  checkLegacyAccount,
  discoverLegacyAccounts,
  probeLegacyAccounts,
} from './legacy-account-write'
import { legacyAccountRecord } from './legacy-account-list'
import { listLegacyAccounts } from './legacy-account-list'
import { accountSummary } from './account-metadata'
import { providerCatalog, protocolCatalog } from './account-catalog'
import {
  savePersonalChannel,
  listPersonalChannels,
  discoverPersonalModels,
} from './personal-channel'
import { saveLegacyRoute, deleteLegacyRoute } from './legacy-route-write'
import { listLegacyRoutes } from './legacy-route-list'
import { listQuotas, updateQuota } from './quotas'
import { listAdminUsage } from './usage-admin'
import { personalUsageAnalytics, adminUsageAnalytics } from './usage-analytics'
import { exportPersonalUsage } from './usage-export'
import { sendTable } from '@/common/tabular'
import { boundResponseLifetime } from './response-deadline'
import { LegacyPatService, legacyPat } from './legacy-pat'
import { Readable } from 'node:stream'
import { z, ZodError } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  getCurrentAdminUser,
  loginRequired,
  menuPermissionRequired,
} from '@/common/auth'
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
  const searchSettings = new SearchSettingsService(service)
  for(const prefix of ['/api/admin/gateway/web-search','/api/admin/agent/web-search']) {
    app.get(prefix,{preHandler:menuPermissionRequired('gateway_websearch')},()=>searchSettings.view())
    app.put(prefix,{preHandler:menuPermissionRequired('gateway_websearch_edit')},request=>searchSettings.save(request.body))
    app.delete(prefix,{preHandler:menuPermissionRequired('gateway_websearch_edit')},()=>searchSettings.reset())
    app.post(prefix+'/test',{preHandler:menuPermissionRequired('gateway_websearch_edit')},async(request,reply)=>{
      const abort=new AbortController()
      const closed=()=>{if(!reply.raw.writableFinished)abort.abort()}
      reply.raw.on('close',closed)
      try{return await searchSettings.test(AbortSignal.any([abort.signal,AbortSignal.timeout(65000)]))}
      finally{reply.raw.off('close',closed)}
    })
  }
  const profiles = new ModelProfileRepository(app.db)
  for (const prefix of [
    '/api/admin/gateway/model-profiles',
    '/api/admin/agent/model-profiles',
  ]) {
    app.get(
      prefix,
      { preHandler: menuPermissionRequired('gateway_model_profiles') },
      async (request) => listProfiles(profiles, request.query),
    )
    app.get(
      prefix + '/candidates',
      { preHandler: menuPermissionRequired('gateway_model_profiles') },
      async (request) => {
        const query = z
          .object({ search: z.string().default('') })
          .parse(request.query)
        return {
          items: (await profiles.candidates())
            .filter((name) =>
              name.toLowerCase().includes(query.search.toLowerCase()),
            )
            .slice(0, 200),
        }
      },
    )
    app.post(
      prefix,
      { preHandler: menuPermissionRequired('gateway_model_profiles_add') },
      async (request, reply) =>
        reply.code(201).send(await saveProfile(profiles, request.body)),
    )
    app.put(
      prefix + '/:id',
      { preHandler: menuPermissionRequired('gateway_model_profiles_edit') },
      async (request) => saveProfile(profiles, request.body, idOf(request)),
    )
    app.delete(
      prefix + '/:id',
      { preHandler: menuPermissionRequired('gateway_model_profiles_delete') },
      async (request) => profiles.remove(idOf(request)),
    )
    app.post(
      prefix + '/sync',
      { preHandler: menuPermissionRequired('gateway_model_profiles_edit') },
      async (request) => syncProfiles(profiles, request.body),
    )
  }
  const owner = async (request: FastifyRequest) =>
    (await getCurrentAdminUser(request))!.id
  const cacheTests = new CacheTestService(service)
  for (const prefix of ['/api/admin/gateway/cache-tests', '/api/admin/agent/cache-tests']) {
    const legacy = prefix.includes('/agent/')
    const view = { preHandler: menuPermissionRequired('gateway_cache_tests') }
    app.get(prefix, view, async request => {
      const result=await cacheTests.repo.page(await owner(request),cacheTestQuery.parse(request.query),legacy)
      return legacy?{...result,items:result.items.map(legacyCacheTest)}:result
    })
    app.get(prefix + '/keys', view, async request => ({items:await cacheTests.keys(await owner(request))}))
    app.get(prefix + '/models', view, async request => {
      const query = z.object({key_id:z.coerce.number().int().positive().optional()}).parse(request.query)
      const result = await cacheTests.models(await owner(request), query.key_id)
      return {models:result.data.map(row=>row.id),default_model:result.data[0]?.id ?? null}
    })
    app.get(prefix + '/:id', view, async request => {const result=await cacheTests.repo.get(await owner(request),idOf(request));return legacy?legacyCacheTest(result):result})
    app.delete(prefix + '/:id', {preHandler:menuPermissionRequired('gateway_cache_tests_delete')}, async request=>cacheTests.repo.remove(await owner(request), idOf(request)))
    app.post(prefix, {preHandler:menuPermissionRequired('gateway_cache_tests_run')}, async (request,reply)=>{
      const abort = new AbortController()
      const onClose=()=>{if(!reply.raw.writableFinished)abort.abort()}
      reply.raw.on('close',onClose)
      boundResponseLifetime(reply.raw, 910000)
      try {
        const result=await cacheTests.run(await owner(request),request.body,AbortSignal.any([abort.signal,AbortSignal.timeout(900000)]))
        return reply.code(201).send(legacy?legacyCacheTest(result):result)
      } finally {reply.raw.off('close',onClose)}
    })
  }
  app.get(
    '/api/admin/agent/credentials',
    { preHandler: menuPermissionRequired('gateway_upstreams') },
    async (request) => listLegacyAccounts(service.repo, request.query),
  )
  app.get(
    '/api/admin/agent/my-channels',
    { preHandler: menuPermissionRequired('gateway_my_channels') },
    async (request) =>
      listLegacyAccounts(service.repo, request.query, await owner(request)),
  )
  for (const personal of [false, true]) {
    const path = personal
      ? '/api/admin/agent/my-channels'
      : '/api/admin/agent/credentials'
    const permission = personal ? 'gateway_my_channels' : 'gateway_upstreams'
    const actor = async (request: FastifyRequest) =>
      personal ? await owner(request) : undefined
    app.post(
      path,
      { preHandler: menuPermissionRequired(permission + '_add') },
      async (request, reply) =>
        reply
          .code(201)
          .send(
            await saveLegacyAccount(
              service,
              request.body,
              undefined,
              await actor(request),
            ),
          ),
    )
    app.put(
      path + '/:id',
      { preHandler: menuPermissionRequired(permission + '_edit') },
      async (request) =>
        saveLegacyAccount(
          service,
          request.body,
          idOf(request),
          await actor(request),
        ),
    )
    app.delete(
      path + '/:id',
      { preHandler: menuPermissionRequired(permission + '_delete') },
      async (request) =>
        service.repo.deleteAccount(idOf(request), await actor(request)),
    )
    const probePermission = personal
      ? 'gateway_my_channels_test'
      : 'gateway_upstreams_test'
    app.post(
      path + '/discover-models',
      { preHandler: menuPermissionRequired(probePermission) },
      async (request) =>
        discoverLegacyAccounts(service, request.body, await actor(request)),
    )
    app.post(
      path + '/:id/check',
      { preHandler: menuPermissionRequired(probePermission) },
      async (request) =>
        checkLegacyAccount(service, idOf(request), await actor(request)),
    )
  }
  app.post(
    '/api/admin/agent/credentials/:id/copy',
    { preHandler: menuPermissionRequired('gateway_upstreams_add') },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          legacyAccountRecord(
            await service.repo.copyPlatformAccount(idOf(request)),
          ),
        ),
  )
  app.post(
    '/api/admin/agent/credentials/health-probe',
    { preHandler: menuPermissionRequired('gateway_upstreams_test') },
    async (request) => probeLegacyAccounts(service, request.body),
  )
  for (const scope of ['platform', 'personal'] as const) {
    const permission =
      scope === 'platform' ? 'gateway_upstreams' : 'gateway_my_channels'
    const prefixes =
      scope === 'platform'
        ? ['/api/admin/gateway', '/api/admin/agent']
        : ['/api/admin/gateway/my-channels', '/api/admin/agent/my-channels']
    for (const prefix of prefixes) {
      app.get(
        `${prefix}/providers`,
        { preHandler: menuPermissionRequired(permission) },
        async () => providerCatalog(),
      )
      app.get(
        `${prefix}/upstream-protocols`,
        { preHandler: menuPermissionRequired(permission) },
        async () => protocolCatalog(prefix.includes('/gateway')),
      )
    }
  }
  app.post(
    '/api/admin/gateway/my-channels/discover-models',
    { preHandler: menuPermissionRequired('gateway_my_channels_test') },
    async (request) =>
      discoverPersonalModels(service, await owner(request), request.body),
  )
  app.post(
    '/api/admin/gateway/my-channels/:id/check',
    { preHandler: menuPermissionRequired('gateway_my_channels_test') },
    async (request) =>
      service.probeUpstream(idOf(request), 0, await owner(request)),
  )
  app.get(
    '/api/admin/gateway/my-channels',
    { preHandler: menuPermissionRequired('gateway_my_channels') },
    async (request) =>
      listPersonalChannels(service, await owner(request), request.query),
  )
  app.post(
    '/api/admin/gateway/my-channels',
    { preHandler: menuPermissionRequired('gateway_my_channels_add') },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await savePersonalChannel(
            service,
            await owner(request),
            request.body,
          ),
        ),
  )
  app.put(
    '/api/admin/gateway/my-channels/:id',
    { preHandler: menuPermissionRequired('gateway_my_channels_edit') },
    async (request) =>
      savePersonalChannel(
        service,
        await owner(request),
        request.body,
        idOf(request),
      ),
  )
  app.delete(
    '/api/admin/gateway/my-channels/:id',
    { preHandler: menuPermissionRequired('gateway_my_channels_delete') },
    async (request) =>
      service.repo.deletePersonalChannel(await owner(request), idOf(request)),
  )
  app.get(
    '/api/admin/agent/routes',
    { preHandler: menuPermissionRequired('gateway_routes') },
    async (request) => listLegacyRoutes(service.repo, request.query),
  )
  app.post(
    '/api/admin/agent/routes',
    { preHandler: menuPermissionRequired('gateway_routes_add') },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await saveLegacyRoute(
            service.repo,
            request.body,
            gatewayOptions(app.config).allowPrivate,
          ),
        ),
  )
  app.put(
    '/api/admin/agent/routes/:id',
    { preHandler: menuPermissionRequired('gateway_routes_edit') },
    async (request) =>
      saveLegacyRoute(
        service.repo,
        request.body,
        gatewayOptions(app.config).allowPrivate,
        idOf(request),
      ),
  )
  app.delete(
    '/api/admin/agent/routes/:id',
    { preHandler: menuPermissionRequired('gateway_routes_delete') },
    async (request) => deleteLegacyRoute(service.repo, idOf(request)),
  )
  app.get(
    '/api/admin/gateway/route-migration/preflight',
    { preHandler: menuPermissionRequired('gateway_routes') },
    async () => service.routeMigrationPreflight(),
  )
  app.get(
    '/api/admin/gateway/route-migration/history',
    { preHandler: menuPermissionRequired('gateway_routes') },
    async () => ({ items: await service.routeMigrations() }),
  )
  app.post(
    '/api/admin/gateway/route-migration/apply',
    { preHandler: menuPermissionRequired('gateway_routes_edit') },
    async (request) =>
      service.applyRouteMigration(request.body, await owner(request)),
  )
  app.post(
    '/api/admin/gateway/route-migration/:id/rollback',
    { preHandler: menuPermissionRequired('gateway_routes_edit') },
    async (request) =>
      service.rollbackRouteMigration(
        (request.params as { id: string }).id,
        await owner(request),
      ),
  )
  app.get(
    '/api/admin/gateway/public-routes',
    { preHandler: menuPermissionRequired('gateway_routes') },
    async () => ({ items: await service.repo.publicRoutes() }),
  )
  app.post(
    '/api/admin/gateway/public-routes',
    { preHandler: menuPermissionRequired('gateway_routes_add') },
    async (request, reply) =>
      reply.code(201).send(await service.savePublicRoute(request.body)),
  )
  app.put(
    '/api/admin/gateway/public-routes/:id',
    { preHandler: menuPermissionRequired('gateway_routes_edit') },
    async (request) => service.savePublicRoute(request.body, idOf(request)),
  )
  app.delete(
    '/api/admin/gateway/public-routes/:id',
    { preHandler: menuPermissionRequired('gateway_routes_delete') },
    async (request) => service.repo.deletePublicRoute(idOf(request)),
  )
  const pats = new LegacyPatService(service)
  app.get(
    '/api/admin/agent/usage',
    { preHandler: menuPermissionRequired('gateway_requests') },
    async (request) => listAdminUsage(service.repo, request.query),
  )
  app.get(
    '/api/admin/agent/usage/analytics',
    { preHandler: menuPermissionRequired('gateway_requests') },
    async (request) => adminUsageAnalytics(service.repo, request.query),
  )
  app.get(
    '/api/agent/me/usage/analytics',
    { preHandler: loginRequired },
    async (request) =>
      personalUsageAnalytics(service.repo, await owner(request), request.query),
  )
  app.post(
    '/api/agent/me/usage/export',
    { preHandler: menuPermissionRequired('gateway_my_usage_export') },
    async (request, reply) =>
      sendTable(
        reply,
        await exportPersonalUsage(pats, await owner(request), request.body),
      ),
  )
  app.get(
    '/api/agent/me/usage',
    { preHandler: loginRequired },
    async (request) =>
      pats.usage(await owner(request), undefined, request.query),
  )
  app.get(
    '/api/agent/auth/pat',
    { preHandler: menuPermissionRequired('gateway_keys') },
    async (request) => pats.list(await owner(request), request.query),
  )
  app.get(
    '/api/agent/auth/pat/:id/usage',
    { preHandler: menuPermissionRequired('gateway_keys') },
    async (request) =>
      pats.usage(await owner(request), idOf(request), request.query),
  )
  app.post(
    '/api/agent/auth/pat',
    { preHandler: menuPermissionRequired('gateway_keys_add') },
    async (request, reply) =>
      reply
        .code(201)
        .send(await pats.create(await owner(request), request.body)),
  )
  app.put(
    '/api/agent/auth/pat/:id',
    { preHandler: menuPermissionRequired('gateway_keys_edit') },
    async (request) =>
      legacyPat(
        await service.updateKey(
          await owner(request),
          idOf(request),
          request.body,
        ),
      ),
  )
  app.post(
    '/api/agent/auth/pat/:id/rotate',
    { preHandler: menuPermissionRequired('gateway_keys_rotate') },
    async (request, reply) => {
      const replacement = await service.rotateKey(
        await owner(request),
        idOf(request),
      )
      return reply.code(201).send({
        ...legacyPat(replacement),
        token: replacement.token,
        rotated_from_id: replacement.rotated_from_id,
      })
    },
  )
  app.delete(
    '/api/agent/auth/pat/:id',
    { preHandler: menuPermissionRequired('gateway_keys_delete') },
    async (request) => {
      const row = await service.repo.revoke(idOf(request), await owner(request))
      if (!row) throw new GatewayError(404, '令牌不存在')
      return legacyPat(row)
    },
  )
  app.get(
    '/api/admin/agent/quotas',
    { preHandler: menuPermissionRequired('gateway_requests') },
    (request) => listQuotas(service.repo, request.query),
  )
  app.put(
    '/api/admin/agent/quotas/:id',
    { preHandler: menuPermissionRequired('gateway_requests_quota_edit') },
    (request) => updateQuota(service.repo, idOf(request), request.body),
  )
  app.get(
    '/api/admin/gateway/user-limits/:id',
    { preHandler: menuPermissionRequired('system_users') },
    async (request) => service.userLimits(idOf(request)),
  )
  app.put(
    '/api/admin/gateway/user-limits/:id',
    { preHandler: menuPermissionRequired('system_users_edit') },
    async (request) => service.saveUserLimits(idOf(request), request.body),
  )
  app.post(
    '/api/admin/gateway/upstreams/:id/probe',
    { preHandler: menuPermissionRequired('gateway_upstreams_test') },
    async (request) => service.probeUpstream(idOf(request)),
  )
  for (const resource of ['upstreams', 'routes'] as const) {
    const path = `/api/admin/gateway/${resource}`,
      permission = `gateway_${resource}`
    app.get(
      path,
      { preHandler: menuPermissionRequired(permission) },
      async () => {
        if (resource === 'routes') return { items: await service.repo.routes() }
        const items = await service.upstreams()
        return { items, summary: accountSummary(items) }
      },
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
  app.post(
    '/api/admin/gateway/keys/:id/rotate',
    { preHandler: menuPermissionRequired('gateway_keys_rotate') },
    async (request, reply) =>
      reply
        .code(201)
        .send(await service.rotateKey(await owner(request), idOf(request))),
  )
  app.put(
    '/api/admin/gateway/keys/:id',
    { preHandler: menuPermissionRequired('gateway_keys_edit') },
    async (request) =>
      service.updateKey(await owner(request), idOf(request), request.body),
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
    '/api/admin/gateway/requests/:id',
    { preHandler: menuPermissionRequired('gateway_requests') },
    async (request) => {
      const row = await service.repo.requestById(
        z
          .string()
          .uuid()
          .parse((request.params as { id: string }).id),
      )
      if (!row) throw new GatewayError(404, '请求不存在')
      return row
    },
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
  for (const prefix of [
    '/api/admin/gateway/device',
    '/api/agent/auth/device',
  ]) {
    for (const [action, decision] of [
      ['confirm', 'approved'],
      ['deny', 'denied'],
    ] as const) {
      app.post(
        prefix + '/' + action,
        { preHandler: menuPermissionRequired('gateway_device_confirm_action') },
        async (request, reply) => {
          const legacy = prefix === '/api/agent/auth/device'
          try {
            const result = await service.decideDevice(await owner(request), request.body, decision)
            return legacy ? { ok: result.ok, user_code: result.user_code } : result
          } catch (error) {
            if (legacy && error instanceof GatewayError)
              return reply.code(error.status).send({ error: error.message })
            throw error
          }
        },
      )
    }
  }
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
      .then(() => new CacheTestRepository(app.db).recoverInterrupted())
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
    if (error instanceof GatewayError && error.upstreamBody !== undefined) {
      reply.header('x-request-id', error.requestId ?? request.id)
      // Do not add/rename supplier fields; the request identity stays in the header.
      return reply.code(status).type('application/json').send(JSON.stringify(error.upstreamBody))
    }
    reply.code(status).send({
      error: {
        message,
        type: 'gateway_error',
        code: error instanceof GatewayError ? error.code : 'invalid_request',
      },
      request_id:
        error instanceof GatewayError
          ? (error.requestId ?? request.id)
          : request.id,
    })
  })
  const tokenOf = (request: FastifyRequest) => {
    const auth = request.headers.authorization
    const bearer =
      auth && /^Bearer\s+/i.test(auth)
        ? auth.replace(/^Bearer\s+/i, '').trim()
        : ''
    const first = request.headers['x-api-key'],
      second = request.headers['api-key']
    return (
      bearer ||
      (typeof first === 'string' ? first.trim() : '') ||
      (typeof second === 'string' ? second.trim() : '')
    )
  }
  const authenticate = (request: FastifyRequest) =>
    service.authenticate(tokenOf(request))
  const webSearch = new WebSearchService(service)
  for (const path of ['/v1/web-search', '/api/agent/v1/web-search']) {
    app.post(path, async (request, reply) => {
      const key = await authenticate(request)
      const abort = new AbortController()
      const closed = () => { if (!reply.raw.writableFinished) abort.abort() }
      reply.raw.on('close', closed)
      boundResponseLifetime(reply.raw, 70000)
      try {
        const result = await webSearch.run(key, request.body, abort.signal, request.headers)
        return reply.header('X-Request-Id', result.id).header('X-Agent-Request-Id', result.id).send(result.json)
      } finally { reply.raw.off('close', closed) }
    })
  }
  app.get('/api/agent/me', async (request, reply) => {
    if (!tokenOf(request))
      return reply.code(401).send({ error: '缺少 API Key' })
    try {
      return await service.profile(await authenticate(request))
    } catch (error) {
      if (error instanceof GatewayError && error.status === 401)
        return reply.code(401).send({ error: '未授权' })
      if (error instanceof GatewayError && error.code === 'insufficient_scope')
        return reply
          .code(403)
          .send({ error: '令牌权限不足', required_scope: 'profile' })
      throw error
    }
  })
  for (const prefix of ['/v1', '/api/agent/v1', '/api/agent/anthropic/v1']) {
    app.post(prefix + '/messages/count_tokens', async (request, reply) => {
      const result = service.countTokens(
        await authenticate(request),
        request.body,
      )
      return reply
        .header('X-Request-Id', result.id)
        .header('X-Agent-Request-Id', result.id)
        .send(result.json)
    })
    if (prefix !== '/api/agent/anthropic/v1')
      app.get(prefix + '/models', async (request) =>
        service.models(await authenticate(request)),
      )
    for (const [suffix, protocol] of [
      ['/chat/completions', 'openai'],
      ['/messages', 'anthropic'],
      ['/responses', 'responses'],
    ] as const) {
      if (prefix === '/api/agent/anthropic/v1' && protocol !== 'anthropic')
        continue
      app.post(prefix + suffix, async (request, reply) => {
        const key = await authenticate(request),
          abort = new AbortController()
        boundResponseLifetime(reply.raw, service.options.timeoutMs)
        reply.raw.on('close', () => {
          if (!reply.raw.writableFinished) abort.abort()
        })
        const result = await executeWithServerTools(
          service, key,
          request.body,
          protocol,
          abort.signal,
          request.headers,
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
  // Shared across replicas; use Fastify's trusted client address, never a raw forwarded header.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]
    if (
      request.method !== 'POST' ||
      !['/api/agent/auth/device/start', '/api/agent/auth/device/poll'].includes(
        path!,
      )
    )
      return
    const retryAfter = await service.admitDeviceRequest(request.ip)
    if (retryAfter)
      return reply
        .header('Retry-After', String(retryAfter))
        .code(429)
        .send({ error: 'slow_down' })
  })
  app.post('/api/agent/auth/device/start', async (_request, reply) => {
    try {
      return await service.startDevice()
    } catch (error) {
      if (error instanceof GatewayError && error.code === 'rate_limited')
        reply.header('Retry-After', '60')
      throw error
    }
  })
  app.post('/api/agent/auth/device/poll', async (request, reply) => {
    const body = z
      .object({ device_code: z.string().min(1).max(100) })
      .parse(request.body)
    try {
      return await service.pollDevice(body.device_code)
    } catch (error) {
      if (error instanceof GatewayError) {
        const messages: Record<string, string> = {
          authorization_pending: '等待你在浏览器中确认授权',
          expired_token: '登录请求已过期，请重新发起登录',
          already_consumed: '令牌已领取',
          invalid_device_code: '登录请求无效，请重新发起登录',
          access_denied: '设备授权已拒绝',
        }
        return reply.code(error.status).send({
          error: messages[error.code] ?? error.message,
          ...(error.code === 'invalid_device_code' ? {} : { error_code: error.code }),
        })
      }
      throw error
    }
  })
}
