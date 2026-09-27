import { cancellationStatus } from './request-lifecycle'
import { utcNowIso } from '@/common/serialize'
import { randomUUID } from 'node:crypto'
import { withAccountHeaders } from './account-headers'
import { supportsModel } from './account-models'
import { proxySecrets } from './account-proxy'
import { hasImage } from './auto-model'
import { bridgePolicy } from './bridge-policy'
import { type CredentialVault, redact } from './crypto'
import { environmentCandidate } from './environment-fallback'
import { bridgeRequest, bridgeResponse } from './protocol/bridge'
import { ProtocolBridgeError } from './protocol/compat-helpers'
import { bridgeStream } from './protocol/stream-bridge'
import { reservationTtlSeconds } from './quota-policy'
import type { GatewayRepository, KeyRow } from './repository'
import { requestContext } from './request-context'
import { inHealthPenalty, preferredHealthy } from './scheduling-policy'
import { GatewayError, requestSchema, requiresResponseStorage, type Protocol } from './schema'
import { orderCandidates, personalCandidates, smoothCandidates } from './selection'
import { affinityModelKey, explicitSessionId, sessionScope } from './session-affinity'
import { SettlementBuffer } from './settlement-buffer'
import { UsageMeter, rewriteModel, streamError } from './stream'
import { estimateReservationTokens } from './token-estimate'
import {
  type GatewayTransport,
  readBounded,
  routeBase
} from './transport'
import { upstreamEndpoint } from './upstream-endpoint'
import { parseUpstreamErrorBody } from './upstream-error-body'
import {
  classifyUpstreamHttp,
  transientConnectionFailure,
  upstreamTimeout,
} from './upstream-failure'
import { usageForProtocol } from './usage'

import type { GatewayOptions } from './service'

export type GatewayExecutionContext = {
  repo: GatewayRepository
  vault: CredentialVault
  transport: GatewayTransport
  options: GatewayOptions
  report: (error: unknown) => void
}

function boundedSetting(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  return Math.min(max, Math.max(min, Number.isFinite(parsed) && parsed !== 0 ? Math.trunc(parsed) : fallback))
}
export async function executeGateway(
  gateway: GatewayExecutionContext,
  key: KeyRow,
  raw: unknown,
  protocol: Protocol,
  clientSignal: AbortSignal,
  headers: Record<string, unknown> = {},
  executionPolicy: { inboundProtocol?: Protocol; authorizationModel?: string; capability?: import('./capability-route').SearchCapability; upstreamProtocol?: Protocol; upstreamIds?: number[]; parentRequestId?: string } = {},
) {
  clientSignal.throwIfAborted()
  if (!key.scopes.includes('chat'))
    throw new GatewayError(403, '令牌缺少 chat 权限', 'insufficient_scope')
  const body = requestSchema.parse(raw)
  const authorizationModel = executionPolicy.authorizationModel ?? body.model
  if ((executionPolicy.authorizationModel && !executionPolicy.parentRequestId) ||
      (!key.models.includes('*') && !key.models.includes(authorizationModel)))
    throw new GatewayError(403, '无权访问此模型', 'model_forbidden')
  const bridgeOptions = bridgePolicy(headers)
  const { reasoningPolicy: selectedReasoning, compatibilityPolicy } = bridgeOptions
  const id = randomUUID(),
    started = Date.now()
  const context = {
    ...requestContext(
      body,
      headers,
      gateway.options.traceKey ?? gateway.options.encryptionKey,
    ),
    reasoning_policy: selectedReasoning,
    compatibility_policy: compatibilityPolicy,
    ...(executionPolicy.parentRequestId ? { parent_request_id: executionPolicy.parentRequestId } : {}),
  }
  const reject = async (
    status: string,
    failure: GatewayError,
  ): Promise<never> => {
    failure.requestId = id
    await gateway.repo
      .recordRejected({
        id,
        key_id: key.id,
        model: body.model,
        protocol: executionPolicy.inboundProtocol ?? protocol,
        status,
        reserved_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        usage_source: 'estimated',
        request_context: context,
        http_status: failure.status,
        error: failure.message,
        duration_ms: Date.now() - started,
        expires_at: utcNowIso(new Date()) + 'Z',
      })
      .catch(gateway.report)
    throw failure
  }
  if (
    requiresResponseStorage(body, compatibilityPolicy)
  )
    return reject(
      'protocol_error',
      new GatewayError(
        400,
        '此版本不持久化 Responses；请传入完整历史并设置 store:false',
        'unsupported_feature',
      ),
    )
  const maxAttempts = gateway.options.maxAttempts ?? 3
  const needsVision = body.model === 'coati-auto' && hasImage(body)
  const available = await gateway.repo.candidates(
    body.model,
    false,
    needsVision,
    key.owner_id,
  )
  if (!available.length && executionPolicy.capability === body.model)
    available.push(...await gateway.repo.capabilityCandidates(executionPolicy.capability))
  if (!available.length && !executionPolicy.capability && !executionPolicy.upstreamIds && !needsVision && gateway.options.environmentFallback &&
    (!executionPolicy.upstreamProtocol || executionPolicy.upstreamProtocol === 'openai')) {
    const target = await gateway.repo.environmentTarget(body.model, key.owner_id, gateway.options.environmentFallback.model)
    if (target) available.push(environmentCandidate(gateway.options.environmentFallback, body.model,
      gateway.vault.encrypt(gateway.options.environmentFallback.key), target.config))
  }
  const reference = available[0]?.route
  const modelKey = affinityModelKey(reference?.public_route ? reference.id : undefined,
    body.model, (needsVision ? reference?.vision_model : reference?.upstream_model) || body.model)
  const sessionSecret = gateway.options.traceKey || gateway.options.encryptionKey
  const explicitSession = explicitSessionId(body, headers, sessionSecret)
  const boundRoute = available.some(c => c.route.public_route && c.route.bound_upstream_id !== null)
  const personal = available.some(c => c.route.personal_owner !== undefined)
  const personalSession = personal ? explicitSession : undefined
  // The ranking key matches Python; only its HMAC is stored in the database.
  const scope = gateway.options.sessionAffinityEnabled === false || personal || boundRoute || reference?.environment_fallback || reference?.capability ? undefined
    : sessionScope(key.owner_id, modelKey, body, headers, sessionSecret)
  const rankingKey = personalSession ? `personal:${key.owner_id}:${personalSession}:${body.model}`
    : scope ? `${key.owner_id}:${explicitSession}:${modelKey}` : undefined
  let routes = orderCandidates(available.filter(candidate => (!executionPolicy.upstreamProtocol || candidate.upstream.protocol === executionPolicy.upstreamProtocol) && (!executionPolicy.upstreamIds || executionPolicy.upstreamIds.includes(candidate.upstream.id))), rankingKey)
  if (needsVision && routes.length) {
    routes = routes.filter((candidate) =>
      candidate.route.vision_model?.trim(),
    )
    if (!routes.length)
      return reject(
        'routing_error',
        new GatewayError(503, '自动路由未配置含图模型', 'model_not_found'),
      )
  }
  if (routes.length) {
    routes = routes.filter(({ route, upstream }) =>
      supportsModel(
        upstream,
        needsVision ? route.vision_model! : route.upstream_model,
      ),
    )
    if (!routes.length)
      return reject(
        'routing_error',
        new GatewayError(
          422,
          '模型账号未声明支持请求所需的实际模型',
          'unsupported_upstream_model',
        ),
      )
  }
  const policy = gateway.repo.schedulingPolicy
  const primary = routes.find(c => c.route.public_route && c.route.bound_upstream_id === c.upstream.id)
  if (!personal) {
    const pool = preferredHealthy(routes.filter(c => c !== primary), policy)
    // Python binds the primary explicitly, regardless of its soft health penalty.
    routes = primary ? [primary, ...pool] : pool
  }
  let bound = scope ? await gateway.repo.binding(scope) : undefined
  if (bound && routes.some(c => c.upstream.id === bound!.upstream_id && inHealthPenalty(c.upstream, policy))) {
    await gateway.repo.invalidateBinding(scope!, bound.upstream_id)
    bound = undefined
  }
  const boundCandidate = bound ? routes.find(c => c.upstream.id === bound!.upstream_id) : undefined
  if (!personal) {
    const limit = boundRoute ? maxAttempts : Math.min(50, Math.max(maxAttempts, policy.selectionPoolSize))
    routes = routes.slice(0, limit)
    if (boundCandidate && !routes.includes(boundCandidate)) routes.unshift(boundCandidate)
  }
  if (bound && routes.some((c) => c.upstream.id === bound.upstream_id)) {
    routes.sort(
      (a, b) =>
        Number(b.upstream.id === bound.upstream_id) -
        Number(a.upstream.id === bound.upstream_id),
    )
    routes = routes.slice(0, maxAttempts)
  } else if (!boundRoute && !personalSession && (personal || gateway.options.sessionAffinityEnabled !== false)) {
    const load = await gateway.repo.poolLoad(modelKey, routes.map(candidate => candidate.upstream.id))
    if (personal && Object.values(load.active).some((count) => count > 0))
      routes = personalCandidates(routes, load.active)
    else if (!personal && (scope || Object.values(load.active).some((count) => count > 0)))
      routes = smoothCandidates(
        routes,
        scope ? load : { ...load, bindings: {}, last: null },
      )
  }
  let conversionError: unknown
  const candidates = routes.flatMap((candidate) => {
    try {
      const payload = bridgeRequest(
        body,
        protocol,
        candidate.upstream.protocol as Protocol,
        bridgeOptions,
      )
      return [{ ...candidate, payload }]
    } catch (error) {
      if (!(error instanceof ProtocolBridgeError)) throw error
      conversionError = error
      return []
    }
  })

  if (!candidates.length && conversionError instanceof ProtocolBridgeError)
    return reject(
      'protocol_error',
      new GatewayError(400, conversionError.message, 'unsupported_feature'),
    )
  if (!candidates.length) {
    if (
      (await gateway.repo.publicRoutes()).some(
        (row) => row.model === body.model && row.enabled,
      )
    )
      return reject(
        'routing_error',
        new GatewayError(503, '公开路由没有可用账号', 'upstream_unavailable'),
      )
    if (
      (
        await gateway.repo.candidates(
          body.model,
          true,
          needsVision,
          key.owner_id,
        )
      ).length
    )
      return reject(
        'routing_error',
        new GatewayError(
          503,
          '模型账号暂时处于冷却状态，请稍后重试',
          'upstream_unavailable',
        ),
      )
    return reject(
      'routing_error',
      new GatewayError(
        body.model === 'coati-auto' ? 503 : 404,
        '没有可用的模型路由',
        'model_not_found',
      ),
    )
  }
  const meter = new UsageMeter()
  const promptEstimate = estimateReservationTokens(body)
  let outputLimit = body.max_completion_tokens ?? body.max_output_tokens ?? body.max_tokens ??
    boundedSetting(process.env.AGENT_QUOTA_DEFAULT_MAX_OUTPUT_TOKENS, 4096, 1, 1000000)
  const budget = { promptTokens: promptEstimate, outputTokens: outputLimit,
    minHeadroom: boundedSetting(process.env.AGENT_QUOTA_MIN_COMPLETION_HEADROOM, 0, 0, 1000000) }
  clientSignal.throwIfAborted()
  const denied = await gateway.repo.reserve(key.id, {
    id,
    model: body.model,
    protocol: executionPolicy.inboundProtocol ?? protocol,
    reserved_tokens: promptEstimate + outputLimit,
    request_context: context,
    expires_at:
      utcNowIso(new Date(Date.now() + (gateway.options.reservationTtlSeconds ?? reservationTtlSeconds()) * 1000)) + 'Z',
  }, budget, executionPolicy.authorizationModel && executionPolicy.parentRequestId ?
    {model:executionPolicy.authorizationModel,parentRequestId:executionPolicy.parentRequestId} : undefined)
  outputLimit = budget.outputTokens
  if (denied) {
    const failure = new GatewayError(
      denied === 'unauthorized'
        ? 401
        : ['insufficient_scope', 'model_not_allowed'].includes(denied)
          ? 403
          : 429,
      denied === 'quota_exceeded' ? '剩余额度不足以预留本次请求' : denied,
      denied,
    )
    if (failure.status === 429) return reject('quota_exceeded', failure)
    throw failure
  }
  const controller = new AbortController(),
    signal = AbortSignal.any([
      clientSignal,
      controller.signal,
      AbortSignal.timeout(gateway.options.timeoutMs),
    ])
  let headerSecrets: string[] = []
  let secret = '',
    upstreamStarted = false,
    settled = false,
    settlementFailed = false,
    firstByte: number | undefined
  const persistFinish = async (
    status: string,
    error?: string,
    httpStatus: number | null = 200,
  ) => {
    if (settled) return
    if (settlementFailed)
      throw new GatewayError(
        500,
        '用量结算失败，请使用请求 ID 联系管理员',
        'settlement_failed',
      )
    try {
      await gateway.repo.releaseUpstream(id)
      const usage = upstreamStarted
        ? meter.result(promptEstimate)
        : { input_tokens: 0, output_tokens: 0, usage_source: 'estimated' }
      const persisted = await gateway.repo.finish(id, {
        status,
        http_status: httpStatus,
        ...usage,
        ...meter.details(),
        error: error ? redact(error, [secret, ...headerSecrets]) : null,
        duration_ms: Date.now() - started,
        first_byte_ms: firstByte ?? null,
      })
      if (persisted.length !== 1)
        throw new Error('Settlement did not update the reserved request')
      settled = true
    } catch (error) {
      settlementFailed = true
      gateway.report(error)
      throw new GatewayError(
        500,
        '用量结算失败，请使用请求 ID 联系管理员',
        'settlement_failed',
      )
    }
  }
  // Abort handling can race with stream iteration. All paths share one write.
  let finishing: Promise<void> | undefined
  const finish = (
    status: string,
    error?: string,
    httpStatus: number | null = 200,
  ) => (finishing ??= persistFinish(status, error, httpStatus))
  try {
    let attemptCount = 0
    for (let i = 0; i < candidates.length && attemptCount < maxAttempts; i++) {
      signal.throwIfAborted()
      const selected = candidates[i]!
      const current = selected.route.environment_fallback ? selected : await gateway.repo.acquireUpstream(
        selected.route.id,
        body.model,
        id,
        utcNowIso(new Date(started + gateway.options.timeoutMs + 60000)) + 'Z',
        scope
          ? {
              scope,
              modelKey,
              owner: key.owner_id,
              eligible: candidates.map((c) => c.upstream.id),
              ttlSeconds: gateway.options.sessionAffinityTtlSeconds ?? 3600,
            }
          : undefined,
        needsVision,
        selected.route.public_route ? selected.upstream.id : undefined,
        selected.route.personal_owner,
        selected.route.automatic_pool,
        selected.route.capability,
      )
      if (!current) continue
      const { upstream, route } = current
      if ((executionPolicy.upstreamProtocol && upstream.protocol !== executionPolicy.upstreamProtocol) || (executionPolicy.upstreamIds && !executionPolicy.upstreamIds.includes(upstream.id))) {
        await gateway.repo.releaseUpstream(id)
        continue
      }
      if (needsVision && !route.vision_model?.trim()) {
        await gateway.repo.releaseUpstream(id)
        continue
      }
      attemptCount++
      const convertedPayload = bridgeRequest(
        body,
        protocol,
        upstream.protocol as Protocol,
        bridgeOptions,
      )
      const upstreamProtocol = upstream.protocol as Protocol
      meter.sourceProtocol = upstreamProtocol
      const proxyUrl = upstream.proxy_secret
        ? gateway.vault.decrypt(upstream.proxy_secret)
        : null
      headerSecrets = [
        ...Object.values(upstream.extra_headers),
        ...proxySecrets(proxyUrl),
        upstream.proxy_secret ?? '',
      ]
      secret = gateway.vault.decrypt(upstream.secret)
      const headers = withAccountHeaders(
        {
          'content-type': 'application/json',
          accept: body.stream ? 'text/event-stream' : 'application/json',
        },
        upstream.extra_headers,
      )
      if (upstreamProtocol === 'anthropic') {
        headers['x-api-key'] = secret
        headers['anthropic-version'] ??= '2023-06-01'
      } else headers.authorization = `Bearer ${secret}`
      const payload: Record<string, unknown> = {
        ...convertedPayload,
        model: needsVision ? route.vision_model! : route.upstream_model,
      }
      // A bridge may insert a protocol default. Never let that default exceed
      // the output allowance used for the atomic reservation above.
      if (upstreamProtocol === 'anthropic')
        payload.max_tokens = Math.min(
          Number(payload.max_tokens ?? outputLimit),
          outputLimit,
        )
      if (upstreamProtocol === 'responses') {
        payload.store = false
        payload.max_output_tokens = Math.min(
          Number(payload.max_output_tokens ?? outputLimit),
          outputLimit,
        )
      }
      if (upstreamProtocol === 'openai') {
        if (payload.max_tokens !== undefined)
          payload.max_tokens = Math.min(
            Number(payload.max_tokens),
            outputLimit,
          )
        if (payload.max_completion_tokens !== undefined)
          payload.max_completion_tokens = Math.min(
            Number(payload.max_completion_tokens),
            outputLimit,
          )
        if (
          payload.max_tokens === undefined &&
          payload.max_completion_tokens === undefined
        )
          payload.max_completion_tokens = outputLimit
      }
      if (upstreamProtocol === 'openai' && body.stream)
        payload.stream_options = {
          ...((body.stream_options as object) || {}),
          include_usage: true,
        }
      const targetBase = routeBase(
        upstream.base_url,
        route.upstream_base,
        gateway.options.allowPrivate,
      )
      const execution = {
        route_kind:
          route.environment_fallback ? ('environment' as const) : route.automatic_pool ? ('pool' as const) : route.personal_owner !== undefined
            ? ('personal' as const)
            : route.public_route
              ? ('public' as const)
              : ('explicit' as const),
        provider: upstream.provider,
        route_name: route.model,
        route_id: route.environment_fallback || route.automatic_pool || route.personal_owner !== undefined ? null : route.id,
        upstream_id: route.environment_fallback ? null : upstream.id,
        upstream_name: upstream.name,
        upstream_model: String(payload.model),
        upstream_protocol: upstreamProtocol,
      }
      // Persist the chosen wire target before I/O so interruption still has provenance.
      await gateway.repo.recordExecution(id, execution)
      const attemptStart = Date.now()
      let response
      try {
        upstreamStarted = true
        response = await gateway.transport.send(
          upstreamEndpoint(targetBase, upstreamProtocol),
          payload,
          headers,
          signal,
          upstream.request_timeout_seconds * 1000,
          proxyUrl,
          upstream.scope === 'platform' && upstream.owner_user_id === null,
        )
      } catch (error) {
        await gateway.repo.attempt({
          request_id: id,
          upstream_id: route.environment_fallback ? null : upstream.id,
          execution,
          duration_ms: Date.now() - attemptStart,
          error: redact(String(error), [secret, ...headerSecrets]),
        })
        if (!signal.aborted && transientConnectionFailure(error)) {
          if (scope) await gateway.repo.invalidateBinding(scope, upstream.id)
          const canRetry = i < candidates.length - 1 && attemptCount < maxAttempts
          if (!route.environment_fallback) await gateway.repo.recordHealthFailure(
            upstream.id,
            utcNowIso(new Date(attemptStart)) + 'Z',
            redact(String(error), [secret, ...headerSecrets]),
            false,
            canRetry,
            upstream,
          )
          if (canRetry) {
            await gateway.repo.releaseUpstream(id)
            continue
          }
        }
        throw error
      }
      if (!response.ok) {
        const text = redact(await readBounded(response, 65536), [
          secret,
          ...headerSecrets,
        ])
        await gateway.repo.attempt({
          request_id: id,
          upstream_id: route.environment_fallback ? null : upstream.id,
          execution,
          status: response.status,
          duration_ms: Date.now() - attemptStart,
          error: text,
        })
        const classification = classifyUpstreamHttp(response.status, text)
        if (scope && classification.retryable)
          await gateway.repo.invalidateBinding(scope, upstream.id)
        if (classification.retryable && !route.environment_fallback) await gateway.repo.recordHealthFailure(
            upstream.id,
            utcNowIso(new Date(attemptStart)) + 'Z',
            text,
            classification.immediate,
            !classification.immediate &&
              (response.status === 429 ||
                (i < candidates.length - 1 && attemptCount < maxAttempts)),
            upstream,
          )
        if (
          classifyUpstreamHttp(response.status, text).retryable &&
          !signal.aborted &&
          i < candidates.length - 1 &&
          attemptCount < maxAttempts
        ) {
          await gateway.repo.releaseUpstream(id)
          continue
        }
        let message = `上游 ${response.status}: ${text}`
        if (classification.immediate) {
          let reason = ''
          try {
            const parsed = parseUpstreamErrorBody(text) as Record<string, unknown> | undefined
            const detail = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed
            if (detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string') reason = detail.message.trim()
          } catch { /* Non-JSON failures have no safe message field. */ }
          message = reason ? `上游账号不可用（HTTP ${response.status}）：${reason}` : `上游账号不可用（HTTP ${response.status}），请联系管理员`
        }
        const failure = new GatewayError(response.status, message, 'upstream_error')
        if (!classification.immediate) failure.upstreamBody = parseUpstreamErrorBody(text) ?? { error: text.slice(0, 500) }
        throw failure
      }
      if (body.stream) {
        if (
          !response.headers.get('content-type')?.includes('text/event-stream')
        ) {
          await response.body?.cancel()
          throw new GatewayError(502, '上游未返回 SSE 响应')
        }
        const { repo, options, report } = gateway
        async function* stream() {
          let completed = false
          let idle: ReturnType<typeof setTimeout> | undefined
          const reset = () => {
            clearTimeout(idle)
            idle = setTimeout(
              () => controller.abort(new Error('上游流式响应超时')),
              Math.min(
                options.idleTimeoutMs,
                upstream.request_timeout_seconds * 1000,
              ),
            )
            idle.unref()
          }
          const onAbort = () => {
            clearTimeout(idle)
            const message =
              signal.reason instanceof Error
                ? signal.reason.message
                : '流式响应已取消'
            void finish(
              clientSignal.aborted ? cancellationStatus(clientSignal) : 'stream_error',
              message,
            ).catch(report)
          }
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
          try {
            signal.throwIfAborted()
            const source = async function* () {
              const reader = response!.body![Symbol.asyncIterator]()
              try {
                while (true) {
                  signal.throwIfAborted()
                  reset()
                  let item
                  try { item = await reader.next() } finally { clearTimeout(idle) }
                  if (item.done) return
                  signal.throwIfAborted()
                  yield item.value
                }
              } finally { await reader.return?.() }
            }
            const terminal = new SettlementBuffer()
            for await (const event of bridgeStream(
              source(),
              upstreamProtocol,
              protocol,
              body.model,
              meter,
              bridgeOptions,
            )) {
              signal.throwIfAborted()
              if (firstByte === undefined) firstByte = Date.now() - started
              if (meter.finished) {
                yield* terminal.accept(event, protocol)
              } else yield event
            }
            if (!route.environment_fallback) await repo.recordHealthSuccess(
              upstream.id,
              utcNowIso(new Date(attemptStart)) + 'Z',
              upstream,
              Date.now() - attemptStart,
            )
            await finish('ok')
            signal.throwIfAborted()
            completed = true
            const ending = terminal.release()
            if (ending) yield ending
          } catch (error) {
            const message = redact(
              upstreamTimeout(error)
                ? '上游响应超时'
                : error instanceof Error
                  ? error.message
                  : String(error),
              [secret, ...headerSecrets],
            )
            await finish(
              clientSignal.aborted ? cancellationStatus(clientSignal) : 'stream_error',
              message,
            ).catch(report)
            if (!clientSignal.aborted)
              yield streamError(
                protocol,
                settlementFailed
                  ? '用量结算失败，请使用请求 ID 联系管理员'
                  : message,
                id,
                settlementFailed ? 'settlement_failed' : 'stream_error',
              )
          } finally {
            signal.removeEventListener('abort', onAbort)
            clearTimeout(idle)
            controller.abort()
            if (!settled)
              await finish('client_error', '客户端中断流式响应').catch(report)
            await repo
              .attempt({
                request_id: id,
                upstream_id: route.environment_fallback ? null : upstream.id,
                execution,
                status: 200,
                duration_ms: Date.now() - attemptStart,
                error: completed ? null : '流未正常完成',
              })
              .catch(report)
          }
        }
        // Async-generator finally blocks do not run when return() precedes the first next().
        const generator = stream()
        let consumed = false
        const settleUnconsumed = async (status: 'client_error' | 'stream_error' = clientSignal.aborted ? cancellationStatus(clientSignal) : 'stream_error') => {
          controller.abort()
          await finish(status, '流式响应消费前已取消')
        }
        const onUnconsumedAbort = () => { void settleUnconsumed().catch(report) }
        signal.addEventListener('abort', onUnconsumedAbort, { once: true })
        if (signal.aborted) onUnconsumedAbort()
        const detach = () => signal.removeEventListener('abort', onUnconsumedAbort)
        const owned: AsyncGenerator<string, void, unknown> = {
          [Symbol.asyncIterator]() { return this },
          next(...args: [] | [unknown]) { consumed = true; detach(); return generator.next(...args) },
          async return(value) {
            detach()
            controller.abort()
            try { return await generator.return(value) }
            finally { if (!consumed) await settleUnconsumed(clientSignal.aborted ? cancellationStatus(clientSignal) : 'client_error').catch(report) }
          },
          async throw(error) {
            detach()
            controller.abort(error)
            try { return await generator.throw(error) }
            finally { if (!consumed) await settleUnconsumed(clientSignal.aborted ? cancellationStatus(clientSignal) : 'client_error').catch(report) }
          },
          async [Symbol.asyncDispose]() { await this.return(undefined) },
        }
        return { id, stream: owned }
      }
      let json
      try {
        const text = await readBounded(response)
        try {
          json = JSON.parse(text)
        } catch {
          throw new GatewayError(502, '上游未返回有效 JSON')
        }
        if (json === null || typeof json !== 'object' || Array.isArray(json))
          throw new GatewayError(502, '上游未返回有效 JSON')
        if (json.error != null || json.status === 'failed' || json.type === 'error')
          throw new GatewayError(502, '上游返回错误响应', 'upstream_error')
        meter.observe(json, upstreamProtocol)
      } catch (error) {
        await gateway.repo
          .attempt({
            request_id: id,
            upstream_id: route.environment_fallback ? null : upstream.id,
            execution,
            status: response.status,
            duration_ms: Date.now() - attemptStart,
            error:
              error instanceof GatewayError
                ? redact(error.message, [secret, ...headerSecrets])
                : '上游响应读取或解析失败',
          })
          .catch(gateway.report)
        throw error
      }
      meter.outputCharacters = JSON.stringify(json).length
      await gateway.repo.attempt({
        request_id: id,
        upstream_id: route.environment_fallback ? null : upstream.id,
        execution,
        status: response.status,
        duration_ms: Date.now() - attemptStart,
      })
      const converted = bridgeResponse(
        json,
        upstreamProtocol,
        protocol,
        body.model,
        bridgeOptions,
      )
      if (upstreamProtocol !== protocol) {
        // Python converters may synthesize zero counters. Wire accounting must
        // use only the actual upstream usage, preserving absent vs reported zero.
        converted.usage = usageForProtocol(
          meter.rawUsage,
          upstreamProtocol,
          protocol,
        )
      }
      if (!route.environment_fallback) await gateway.repo.recordHealthSuccess(
        upstream.id,
        utcNowIso(new Date(attemptStart)) + 'Z',
        upstream,
        Date.now() - attemptStart,
      )
      await finish('ok')
      return { id, json: rewriteModel(converted, body.model) }
    }
    throw new GatewayError(503, '所有上游暂时不可用')
  } catch (error) {
    const wasAborted = signal.aborted || upstreamTimeout(error)
    controller.abort()
    const failure =
      error instanceof GatewayError
        ? error
        : error instanceof ProtocolBridgeError
          ? new GatewayError(502, error.message, 'protocol_error')
          : new GatewayError(
              wasAborted ? 504 : 502,
              wasAborted ? '请求取消或上游超时' : '上游连接失败',
              'upstream_error',
            )
    const status = clientSignal.aborted
      ? cancellationStatus(clientSignal)
      : failure.code === 'protocol_error' ||
          failure.code === 'unsupported_feature'
        ? 'protocol_error'
        : !upstreamStarted
          ? 'routing_error'
          : 'upstream_error'
    await finish(
      status,
      String(error),
      clientSignal.aborted ? null : failure.status,
    ).catch(gateway.report)
    failure.requestId = id
    throw failure
  }
}
