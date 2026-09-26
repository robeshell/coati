import { deviceFlowPolicy } from './device-policy'
import { environmentFallback, environmentCandidate, type EnvironmentFallback } from './environment-fallback'
import { schedulingPolicy, inHealthPenalty, preferredHealthy, type SchedulingPolicy } from './scheduling-policy'
import { parseUpstreamErrorBody } from './upstream-error-body'
import { reservationTtlSeconds } from './quota-policy'
import { requiresResponseStorage } from './schema'
import { personalModelNames } from './personal-route'
import { ModelProfileRepository } from './model-profile-repository'
import { profileRecord } from './model-profile'
import { accountMetadata, credentialMetadata } from './account-metadata'
import { upstreamEndpoint } from './upstream-endpoint'
import { proxyHint, proxySecrets } from './account-proxy'
import { withAccountHeaders } from './account-headers'
import { routeMigrationPreflight } from './route-preflight'
import { supportedModels, supportsModel } from './account-models'
import { estimateMessageTokens, estimateReservationTokens } from './token-estimate'
import { z } from 'zod'
import { SettlementBuffer } from './settlement-buffer'
import { bridgePolicy } from './bridge-policy'
import { hasImage } from './auto-model'
import { requestContext } from './request-context'
import { loadAdminsWithRolesByIds } from '@/common/auth'
import { adminUserToDict } from '@/db/schema/admin/rbac'
import { discoverModels } from './discovery'
import { sessionScope, explicitSessionId, affinityModelKey } from './session-affinity'
import { orderCandidates, smoothCandidates, personalCandidates } from './selection'
import {
  upstreamTimeout,
  classifyUpstreamHttp,
  transientConnectionFailure,
} from './upstream-failure'
import { usageForProtocol } from './usage'
import { utcNowIso } from '@/common/serialize'
import { randomUUID, randomBytes } from 'node:crypto'
import type { AppConfig } from '@/config'
import type { Db } from '@/db/client'
import { GatewayRepository, type KeyRow } from './repository'
import { CredentialVault, hashToken, mintToken, redact, parsePreviousKeys } from './crypto'
import {
  GatewayError,
  upstreamSchema,
  userLimitsSchema,
  routeSchema,
  publicRouteSchema,
  keySchema,
  keyUpdateSchema,
  requestSchema,
  type Protocol,
} from './schema'
import { bridgeRequest, bridgeResponse } from './protocol/bridge'
import { bridgeStream } from './protocol/stream-bridge'
import { ProtocolBridgeError } from './protocol/compat-helpers'
import {
  GatewayTransport,
  readBounded,
  validateBase,
  routeBase,
} from './transport'
import { UsageMeter, rewriteModel, streamError } from './stream'

export interface GatewayOptions {
  environmentFallback?: EnvironmentFallback
  schedulingPolicy?: SchedulingPolicy
  sessionAffinityEnabled?: boolean
  sessionAffinityTtlSeconds?: number
  maxAttempts?: number
  reservationTtlSeconds?: number
  trustedProxyUrl?: string
  previousEncryptionKeys?: string[]
  encryptionKey: string
  traceKey?: string
  allowPrivate: boolean
  timeoutMs: number
  idleTimeoutMs: number
}
function boundedSetting(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value)
  return Math.min(max, Math.max(min, Number.isFinite(parsed) && parsed !== 0 ? Math.trunc(parsed) : fallback))
}
export function gatewayOptions(config: AppConfig): GatewayOptions {
  const encryptionKey =
    process.env.GATEWAY_ENCRYPTION_KEY ||
    (config.isProduction ? '' : config.secretKey)
  if (!encryptionKey)
    throw new Error('Production requires GATEWAY_ENCRYPTION_KEY')
  return {
    encryptionKey,
    environmentFallback: environmentFallback(),
    schedulingPolicy: schedulingPolicy(),
    reservationTtlSeconds: reservationTtlSeconds(),
    sessionAffinityEnabled: !['0', 'false', 'no', 'off'].includes((process.env.AGENT_SESSION_AFFINITY_ENABLED ?? 'true').trim().toLowerCase()),
    sessionAffinityTtlSeconds: boundedSetting(process.env.AGENT_SESSION_AFFINITY_TTL_SECONDS, 3600, 60, 7 * 24 * 3600),
    maxAttempts: boundedSetting(process.env.AGENT_GATEWAY_MAX_ATTEMPTS, 3, 1, 10),
    previousEncryptionKeys: parsePreviousKeys(process.env.GATEWAY_PREVIOUS_ENCRYPTION_KEYS || '[]'),
    traceKey: config.secretKey,
    trustedProxyUrl: process.env.GATEWAY_TRUSTED_PROXY_URL || undefined,
    allowPrivate: process.env.GATEWAY_ALLOW_PRIVATE_UPSTREAMS === 'true',
    timeoutMs: 180000,
    idleTimeoutMs: 300000,
  }
}
export class GatewayService {
  readonly repo: GatewayRepository
  readonly vault: CredentialVault
  readonly transport: GatewayTransport
  constructor(
    db: Db,
    readonly options: GatewayOptions,
    readonly report: (error: unknown) => void = () => {},
  ) {
    this.repo = new GatewayRepository(db, undefined, undefined, options.schedulingPolicy)
    this.vault = new CredentialVault(options.encryptionKey, options.previousEncryptionKeys)
    this.transport = new GatewayTransport(options.allowPrivate, options.trustedProxyUrl)
  }
  async upstreams() {
    return (await this.repo.upstreams()).map(
      ({
        secret,
        proxy_secret: _proxySecret,
        probe_token: _probeToken,
        ...x
      }) => ({
        ...x,
        ...accountMetadata({
          ...x,
          secret,
          proxy_secret: _proxySecret,
          probe_token: _probeToken,
        }),
        supported_models: supportedModels(x),
        has_proxy: Boolean(_proxySecret),
        has_secret: Boolean(secret),
      }),
    )
  }
  async saveUpstream(value: unknown, id?: number) {
    const input = upstreamSchema.parse(value)
    const existing = id
      ? (await this.repo.upstreams()).find((x) => x.id === id)
      : null
    if (id && !existing) throw new GatewayError(404, '模型服务不存在')
    if (!input.api_key && !existing)
      throw new GatewayError(400, '请输入上游 API Key')
    const row = await this.repo.saveUpstream(
      {
        ...(input.api_key
          ? credentialMetadata(input.api_key)
          : {
              api_key_hint: existing?.api_key_hint ?? null,
              key_fingerprint: existing?.key_fingerprint ?? null,
            }),
        proxy_secret:
          input.proxy_url === undefined
            ? (existing?.proxy_secret ?? null)
            : input.proxy_url
              ? this.vault.encrypt(input.proxy_url)
              : null,
        proxy_hint:
          input.proxy_url === undefined
            ? (existing?.proxy_hint ?? null)
            : proxyHint(input.proxy_url),
        name: input.name,
        request_timeout_seconds:
          input.request_timeout_seconds ??
          existing?.request_timeout_seconds ??
          120,
        extra_headers: input.extra_headers ?? existing?.extra_headers ?? {},
        note: input.note === undefined ? (existing?.note ?? null) : input.note,
        priority: input.priority ?? existing?.priority ?? 100,
        supported_models:
          input.supported_models ?? existing?.supported_models ?? [],
        default_model: input.default_model ?? existing?.default_model ?? '',
        provider: input.provider ?? existing?.provider ?? 'openai-compatible',
        protocol: input.protocol,
        base_url: validateBase(input.base_url, this.options.allowPrivate),
        enabled: input.enabled,
        concurrency_limit: input.concurrency_limit,
        weight: input.weight,
        secret: input.api_key
          ? this.vault.encrypt(input.api_key)
          : existing!.secret,
      },
      id,
    )
    const {
      secret,
      proxy_secret: _proxySecret,
      probe_token: _probeToken,
      ...safe
    } = row!
    return {
      ...safe,
      ...accountMetadata(row!),
      supported_models: supportedModels(safe),
      has_proxy: Boolean(_proxySecret),
      has_secret: Boolean(secret),
    }
  }
  async probeUpstream(id: number, quietSeconds = 0, personalOwner?: number) {
    const accounts =
      personalOwner === undefined
        ? await this.repo.upstreams()
        : await this.repo.personalChannelRows(personalOwner)
    const existing = accounts.find((item) => item.id === id)
    if (!existing) throw new GatewayError(404, '模型服务不存在')
    if (!existing.enabled) throw new GatewayError(409, '模型服务已停用')
    const row = await this.repo.claimProbe(id, quietSeconds, personalOwner)
    if (!row)
      throw new GatewayError(
        409,
        '账号正在探测或尚处于探测静默期',
        'probe_busy',
      )
    const started = Date.now()
    const verifiedProtocol = row.protocol !== 'anthropic'
    let secret = ''
    let proxyUrl: string | null = null
    try {
      proxyUrl = row.proxy_secret ? this.vault.decrypt(row.proxy_secret) : null
      secret = this.vault.decrypt(row.secret)
      const result = await discoverModels(
        this.transport,
        row.base_url,
        secret,
        AbortSignal.timeout(
          Math.min(
            this.options.timeoutMs,
            30000,
            row.request_timeout_seconds * 1000,
          ),
        ),
        row.extra_headers,
        row.request_timeout_seconds * 1000,
        proxyUrl,
        row.scope === 'platform' && row.owner_user_id === null,
      )
      const verified = verifiedProtocol && result.models.length > 0
      const applied = await this.repo.completeProbe(
        row,
        verified,
        Date.now() - started,
      )
      return {
        ...result,
        verified,
        health_updated: applied,
        latency_ms: Date.now() - started,
      }
    } catch (error) {
      const message = redact(
        error instanceof Error ? error.message : 'Model discovery failed',
        [
          secret,
          row.secret,
          row.proxy_secret ?? '',
          ...proxySecrets(proxyUrl),
          row.probe_token ?? '',
          ...Object.values(row.extra_headers),
        ],
      )
      await this.repo.completeProbe(row, false, Date.now() - started, message)
      throw new GatewayError(502, message, 'upstream_probe_failed')
    }
  }
  async userLimits(owner: number) {
    const row = await this.repo.userLimits(owner)
    if (!row) throw new GatewayError(404, '用户不存在')
    return row
  }
  async saveUserLimits(owner: number, body: unknown) {
    const limits = userLimitsSchema.parse(body)
    await this.userLimits(owner)
    return this.repo.saveUserLimits(owner, limits)
  }
  async routeMigrationPreflight() {
    return routeMigrationPreflight(
      await this.repo.routeMigrationSnapshot(),
      this.options.allowPrivate,
    )
  }
  routeMigrations() {
    return this.repo.routeMigrations()
  }
  async applyRouteMigration(body: unknown, actor: number) {
    const data = z
      .object({
        model: z.string().min(1).max(200),
        version: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(body)
    return this.migrationWrite(() =>
      this.repo.applyRouteMigration(
        data.model,
        data.version,
        actor,
        this.options.allowPrivate,
      ),
    )
  }
  rollbackRouteMigration(id: string, actor: number) {
    return this.migrationWrite(() =>
      this.repo.rollbackRouteMigration(z.uuid().parse(id), actor),
    )
  }
  private async migrationWrite<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      const code =
        (error as { code?: string; cause?: { code?: string } }).cause?.code ||
        (error as { code?: string }).code
      if (code === '55P03' || code === '40P01')
        throw new GatewayError(409, '配置正在使用或修改，请稍后重试')
      throw error
    }
  }
  async savePublicRoute(value: unknown, id?: number) {
    const existing = id
      ? (await this.repo.publicRoutes()).find((row) => row.id === id)
      : undefined
    if (id && !existing) throw new GatewayError(404, '公开路由不存在')
    const data = publicRouteSchema.parse({
      ...existing,
      ...z.record(z.string(), z.unknown()).parse(value),
    })
    if (data.model === 'coati-auto' && !data.upstream_model)
      throw new GatewayError(422, '自动路由必须配置实际模型')
    if (data.upstream_base && !data.upstream_id)
      throw new GatewayError(422, '覆盖地址必须绑定账号')
    if (data.upstream_id) {
      const account = (await this.repo.upstreams()).find(
        (row) => row.id === data.upstream_id,
      )
      if (!account || (data.enabled && !account.enabled))
        throw new GatewayError(422, '绑定账号不可用')
      for (const target of [
        data.upstream_model || data.model,
        data.vision_model,
      ])
        if (target && !supportsModel(account, target))
          throw new GatewayError(422, '绑定账号不支持目标模型')
      if (data.upstream_base)
        data.upstream_base = routeBase(
          account.base_url,
          data.upstream_base,
          this.options.allowPrivate,
        )
    }
    const saved = await this.repo.savePublicRoute(data, id)
    if (!saved) throw new GatewayError(404, '公开路由不存在')
    return saved
  }
  async saveRoute(value: unknown, id?: number) {
    const data = routeSchema.parse(value)
    const upstream = (await this.repo.upstreams()).find(
      (x) => x.id === data.upstream_id,
    )
    if (!upstream) throw new GatewayError(400, '请选择有效的模型服务')
    if (data.enabled && !upstream.enabled)
      throw new GatewayError(422, '生效的模型路由不能绑定已停用的模型账号')
    for (const model of [data.upstream_model, data.vision_model])
      if (model && !supportsModel(upstream, model))
        throw new GatewayError(
          422,
          '绑定的模型账号未声明支持路由实际模型或含图模型',
          'unsupported_upstream_model',
        )
    const existing = id
      ? (await this.repo.routes()).find((x) => x.id === id)
      : undefined
    if (id && !existing) throw new GatewayError(404, '路由不存在')
    if (data.description === undefined)
      data.description = existing?.description ?? null
    if (data.upstream_base === undefined)
      data.upstream_base = existing?.upstream_base ?? null
    if (data.upstream_base)
      data.upstream_base = routeBase(
        upstream.base_url,
        data.upstream_base,
        this.options.allowPrivate,
      )
    const row = await this.repo.saveRoute(data, id)
    if (!row) throw new GatewayError(404, '路由不存在')
    return row
  }
  async keys(owner: number) {
    return (await this.repo.keys(owner)).map(
      ({ digest: _digest, ...safe }) => safe,
    )
  }
  async createKey(owner: number, value: unknown) {
    const data = keySchema.parse(value),
      token = mintToken()
    const { expires_days, ...fields } = data
    const row = await this.repo.createKey({
      ...fields,
      owner_id: owner,
      digest: hashToken(token),
      prefix: token.slice(0, 12),
      expires_at:
        expires_days === null ? null : utcNowIso(new Date(Date.now() + expires_days * 86400000)) + 'Z',
    })
    const { digest: _digest, ...safe } = row
    return { ...safe, token }
  }
  async rotateKey(owner: number, id: number) {
    const token = mintToken()
    const result = await this.repo.rotateKey(id, owner, {
      digest: hashToken(token),
      prefix: token.slice(0, 12),
    })
    if (result.error === 'not_found') throw new GatewayError(404, '令牌不存在')
    if (result.error) throw new GatewayError(409, '只能轮换当前有效的令牌')
    const { digest: _digest, ...safe } = result.row
    return { ...safe, token }
  }
  async updateKey(owner: number, id: number, value: unknown) {
    const data = keyUpdateSchema.parse(value)
    const result = await this.repo.updatePersonalKey(
      id,
      owner,
      data.name,
      data.expires_days,
    )
    if (result.error === 'not_found') throw new GatewayError(404, '令牌不存在')
    if (result.error)
      throw new GatewayError(409, '只能编辑当前有效的个人 API Key')
    const { digest: _digest, ...safe } = result.row
    return safe
  }
  async authenticate(raw: string) {
    const key = raw && (await this.repo.key(hashToken(raw)))
    return this.acceptKey(key || undefined)
  }
  async authenticateOwnedKey(owner: number, id: number) {
    const key = (await this.repo.keys(owner)).find(row => row.id === id)
    if (!key) throw new GatewayError(404, '访问令牌不存在')
    // An invalid selected key must not invalidate the administrator's cookie session.
    if (key.revoked || (key.expires_at && Date.parse(key.expires_at) <= Date.now()))
      throw new GatewayError(409, '所选访问令牌已失效，请重新选择')
    return this.acceptKey(key)
  }
  private async acceptKey(key: KeyRow | undefined) {
    if (
      !key ||
      key.revoked ||
      (key.expires_at && Date.parse(key.expires_at) <= Date.now())
    )
      throw new GatewayError(401, 'API Key 无效或已过期', 'invalid_api_key')
    try {
      await this.repo.touchKey(key.id)
    } catch (error) {
      this.report(error)
    }
    return key
  }
  async profile(key: KeyRow) {
    if (!key.scopes.includes('profile'))
      throw new GatewayError(403, '令牌缺少 profile 权限', 'insufficient_scope')
    const [user] = await loadAdminsWithRolesByIds(this.repo.db, [key.owner_id])
    if (!user) throw new GatewayError(401, '用户不存在', 'invalid_api_key')
    return {
      user: adminUserToDict(user),
      quota: await this.repo.quotaSummary(key.owner_id),
    }
  }
  countTokens(key: KeyRow, raw: unknown) {
    if (!key.scopes.includes('chat'))
      throw new GatewayError(403, '令牌缺少 chat 权限', 'insufficient_scope')
    const body = z.record(z.string(), z.unknown()).parse(raw ?? {})
    return {
      id: randomUUID(),
      json: { input_tokens: estimateMessageTokens(body) },
    }
  }
  async models(key: Pick<KeyRow, 'owner_id' | 'models' | 'scopes'>) {
    if (!key.scopes.includes('chat'))
      throw new GatewayError(403, '令牌缺少 chat 权限', 'insufficient_scope')
    const profiles = new Map(
      (await new ModelProfileRepository(this.repo.db).all())
        .filter((row) => row.enabled)
        .map((row) => [row.model_name, profileRecord(row)]),
    )
    const publicConfigs = await this.repo.publicRoutes()
    const explicitConfigs = await this.repo.routes()
    const personal = await this.repo.personalAccounts(key.owner_id)
    const capabilities = (name: string) => {
      const direct = profiles.get(name)
      const publicConfig = publicConfigs.find(
        (row) => row.enabled && row.model === name,
      )
      const configs = publicConfig
        ? [publicConfig]
        : explicitConfigs.filter((row) => row.enabled && row.model === name)
      const owned = personal.find((row) =>
        personalModelNames(row).includes(name),
      )
      const targets = owned
        ? [supportedModels(owned)[personalModelNames(owned).indexOf(name)]!]
        : configs.length
          ? configs.flatMap((config) =>
              [config.upstream_model || name, config.vision_model].filter(
                (v): v is string => Boolean(v),
              ),
            )
          : [name]
      const matches = targets.map((target) => profiles.get(target))
      return direct
        ? {
            context_window: direct.context_window,
            max_output_tokens: direct.max_output_tokens,
          }
        : matches.every(Boolean)
          ? {
              context_window: Math.min(
                ...matches.map((row) => row!.context_window),
              ),
              max_output_tokens: Math.min(
                ...matches.map((row) => row!.max_output_tokens),
              ),
            }
          : { context_window: 128000, max_output_tokens: 8192 }
    }
    const catalog = await this.repo.models(key.owner_id)
    if (this.options.environmentFallback) {
      for (const name of new Set([this.options.environmentFallback.model, ...publicConfigs.map(route => route.model)])) {
        if (await this.repo.environmentTarget(name, key.owner_id, this.options.environmentFallback.model))
          catalog.push({ model: name, protocol: 'openai' })
      }
    }
    return {
      object: 'list',
      data: [
        ...new Set(
          catalog
            .filter(
              (x) => key.models.includes('*') || key.models.includes(x.model),
            )
            .map((x) => x.model),
        ),
      ].map((id) => ({
        id,
        object: 'model',
        owned_by: 'coati',
        ...capabilities(id),
      })),
    }
  }
  async execute(
    key: KeyRow,
    raw: unknown,
    protocol: Protocol,
    clientSignal: AbortSignal,
    headers: Record<string, unknown> = {},
    executionPolicy: { inboundProtocol?: Protocol; authorizationModel?: string; capability?: import('./capability-route').SearchCapability; upstreamProtocol?: Protocol; upstreamIds?: number[]; parentRequestId?: string } = {},
  ) {
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
        this.options.traceKey ?? this.options.encryptionKey,
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
      await this.repo
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
        .catch(this.report)
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
    const maxAttempts = this.options.maxAttempts ?? 3
    const needsVision = body.model === 'coati-auto' && hasImage(body)
    const available = await this.repo.candidates(
      body.model,
      false,
      needsVision,
      key.owner_id,
    )
    if (!available.length && executionPolicy.capability === body.model)
      available.push(...await this.repo.capabilityCandidates(executionPolicy.capability))
    if (!available.length && !executionPolicy.capability && !executionPolicy.upstreamIds && !needsVision && this.options.environmentFallback &&
      (!executionPolicy.upstreamProtocol || executionPolicy.upstreamProtocol === 'openai')) {
      const target = await this.repo.environmentTarget(body.model, key.owner_id, this.options.environmentFallback.model)
      if (target) available.push(environmentCandidate(this.options.environmentFallback, body.model,
        this.vault.encrypt(this.options.environmentFallback.key), target.config))
    }
    const reference = available[0]?.route
    const modelKey = affinityModelKey(reference?.public_route ? reference.id : undefined,
      body.model, (needsVision ? reference?.vision_model : reference?.upstream_model) || body.model)
    const sessionSecret = this.options.traceKey || this.options.encryptionKey
    const explicitSession = explicitSessionId(body, headers, sessionSecret)
    const boundRoute = available.some(c => c.route.public_route && c.route.bound_upstream_id !== null)
    const personal = available.some(c => c.route.personal_owner !== undefined)
    const personalSession = personal ? explicitSession : undefined
    // The ranking key matches Python; only its HMAC is stored in the database.
    const scope = this.options.sessionAffinityEnabled === false || personal || boundRoute || reference?.environment_fallback || reference?.capability ? undefined
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
    const policy = this.repo.schedulingPolicy
    const primary = routes.find(c => c.route.public_route && c.route.bound_upstream_id === c.upstream.id)
    if (!personal) {
      const pool = preferredHealthy(routes.filter(c => c !== primary), policy)
      // Python binds the primary explicitly, regardless of its soft health penalty.
      routes = primary ? [primary, ...pool] : pool
    }
    let bound = scope ? await this.repo.binding(scope) : undefined
    if (bound && routes.some(c => c.upstream.id === bound!.upstream_id && inHealthPenalty(c.upstream, policy))) {
      await this.repo.invalidateBinding(scope!, bound.upstream_id)
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
    } else if (!boundRoute && !personalSession && (personal || this.options.sessionAffinityEnabled !== false)) {
      const load = await this.repo.poolLoad(modelKey, routes.map(candidate => candidate.upstream.id))
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
        (await this.repo.publicRoutes()).some(
          (row) => row.model === body.model && row.enabled,
        )
      )
        return reject(
          'routing_error',
          new GatewayError(503, '公开路由没有可用账号', 'upstream_unavailable'),
        )
      if (
        (
          await this.repo.candidates(
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
    const denied = await this.repo.reserve(key.id, {
      id,
      model: body.model,
      protocol: executionPolicy.inboundProtocol ?? protocol,
      reserved_tokens: promptEstimate + outputLimit,
      request_context: context,
      expires_at:
        utcNowIso(new Date(Date.now() + (this.options.reservationTtlSeconds ?? reservationTtlSeconds()) * 1000)) + 'Z',
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
        AbortSignal.timeout(this.options.timeoutMs),
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
        await this.repo.releaseUpstream(id)
        const usage = upstreamStarted
          ? meter.result(promptEstimate)
          : { input_tokens: 0, output_tokens: 0, usage_source: 'estimated' }
        const persisted = await this.repo.finish(id, {
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
        this.report(error)
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
        const selected = candidates[i]!
        const current = selected.route.environment_fallback ? selected : await this.repo.acquireUpstream(
          selected.route.id,
          body.model,
          id,
          utcNowIso(new Date(started + this.options.timeoutMs + 60000)) + 'Z',
          scope
            ? {
                scope,
                modelKey,
                owner: key.owner_id,
                eligible: candidates.map((c) => c.upstream.id),
                ttlSeconds: this.options.sessionAffinityTtlSeconds ?? 3600,
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
          await this.repo.releaseUpstream(id)
          continue
        }
        if (needsVision && !route.vision_model?.trim()) {
          await this.repo.releaseUpstream(id)
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
          ? this.vault.decrypt(upstream.proxy_secret)
          : null
        headerSecrets = [
          ...Object.values(upstream.extra_headers),
          ...proxySecrets(proxyUrl),
          upstream.proxy_secret ?? '',
        ]
        secret = this.vault.decrypt(upstream.secret)
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
          this.options.allowPrivate,
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
        await this.repo.recordExecution(id, execution)
        const attemptStart = Date.now()
        let response
        try {
          upstreamStarted = true
          response = await this.transport.send(
            upstreamEndpoint(targetBase, upstreamProtocol),
            payload,
            headers,
            signal,
            upstream.request_timeout_seconds * 1000,
            proxyUrl,
            upstream.scope === 'platform' && upstream.owner_user_id === null,
          )
        } catch (error) {
          await this.repo.attempt({
            request_id: id,
            upstream_id: route.environment_fallback ? null : upstream.id,
            execution,
            duration_ms: Date.now() - attemptStart,
            error: redact(String(error), [secret, ...headerSecrets]),
          })
          if (!signal.aborted && transientConnectionFailure(error)) {
            if (scope) await this.repo.invalidateBinding(scope, upstream.id)
            const canRetry = i < candidates.length - 1 && attemptCount < maxAttempts
            if (!route.environment_fallback) await this.repo.recordHealthFailure(
              upstream.id,
              utcNowIso(new Date(attemptStart)) + 'Z',
              redact(String(error), [secret, ...headerSecrets]),
              false,
              canRetry,
              upstream,
            )
            if (canRetry) {
              await this.repo.releaseUpstream(id)
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
          await this.repo.attempt({
            request_id: id,
            upstream_id: route.environment_fallback ? null : upstream.id,
            execution,
            status: response.status,
            duration_ms: Date.now() - attemptStart,
            error: text,
          })
          const classification = classifyUpstreamHttp(response.status, text)
          if (scope && classification.retryable)
            await this.repo.invalidateBinding(scope, upstream.id)
          if (classification.retryable && !route.environment_fallback) await this.repo.recordHealthFailure(
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
            await this.repo.releaseUpstream(id)
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
          const { repo, options, report } = this
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
                clientSignal.aborted ? 'client_error' : 'stream_error',
                message,
              ).catch(report)
            }
            signal.addEventListener('abort', onAbort, { once: true })
            if (signal.aborted) onAbort()
            try {
              signal.throwIfAborted()
              reset()
              const source = async function* () {
                for await (const chunk of response!.body!) {
                  signal.throwIfAborted()
                  reset()
                  yield chunk
                }
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
                clientSignal.aborted ? 'client_error' : 'stream_error',
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
          return { id, stream: stream() }
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
          await this.repo
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
            .catch(this.report)
          throw error
        }
        meter.outputCharacters = JSON.stringify(json).length
        await this.repo.attempt({
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
        if (!route.environment_fallback) await this.repo.recordHealthSuccess(
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
        ? 'client_error'
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
      ).catch(this.report)
      failure.requestId = id
      throw failure
    }
  }
  async decideDevice(
    owner: number,
    raw: unknown,
    decision: 'approved' | 'denied',
  ) {
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).user_code : undefined
    const user_code = value == null ? '' : String(value).trim()
    if (!user_code) throw new GatewayError(400, '用户码 必填', 'invalid_user_code')
    if (Array.from(user_code).length > 32)
      throw new GatewayError(400, '用户码 不能超过 32 个字符', 'invalid_user_code')
    const result = await this.repo.confirmDevice(
      user_code.toUpperCase(),
      owner,
      decision,
    )
    if (result.error)
      throw new GatewayError(
        result.error === 'invalid_user_code'
          ? 404
          : result.error === 'expired_token'
            ? 410
            : 409,
        result.error === 'invalid_user_code' ? '用户码无效'
          : result.status === 'expired' ? '用户码已过期，请重新发起登录'
          : result.status === 'approved' ? '该登录请求已确认，请返回发起登录的应用继续'
          : result.status === 'consumed' ? '该登录请求已经完成，无需重复授权'
          : '当前登录请求无法确认，请重新发起登录',
        result.error,
      )
    return { success: true, ok: true, user_code: result.user_code }
  }
  async startDevice() {
    const policy = deviceFlowPolicy()
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const codePart = () => Array.from(randomBytes(4), value => alphabet[value % alphabet.length]).join('')
    const deviceCode = randomBytes(32).toString('base64url'),
      userCode = `${codePart()}-${codePart()}`
    const admission = await this.repo.createDevice({
      device_hash: hashToken(deviceCode),
      user_code: userCode,
      expires_at: utcNowIso(new Date(Date.now() + policy.ttlSeconds * 1000)) + 'Z',
    })
    if (admission === 'rate_limited')
      throw new GatewayError(
        429,
        '设备登录请求过于频繁，请稍后再试',
        'rate_limited',
      )
    if (admission === 'capacity_exceeded')
      throw new GatewayError(
        503,
        '设备登录请求已达容量上限，请稍后再试',
        'capacity_exceeded',
      )
    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: policy.verificationPath,
      verification_uri_complete: `${policy.verificationPath}?user_code=${userCode}`,
      expires_in: policy.ttlSeconds,
      interval: policy.intervalSeconds,
    }
  }
  admitDeviceRequest(ip: string) {
    return this.repo.admitDeviceRequest(hashToken(ip))
  }
  async pollDevice(code: string) {
    const token = mintToken(),
      result = await this.repo.consumeDevice(hashToken(code), {
        name: '设备授权',
        kind: 'device',
        digest: hashToken(token),
        prefix: token.slice(0, 12),
        models: ['*'],
        daily_limit: 0,
        concurrency_limit: 0,
        rpm_limit: 0,
        expires_at: utcNowIso(new Date(Date.now() + 30 * 86400000)) + 'Z',
      })
    if (typeof result === 'string')
      throw new GatewayError(
        result === 'already_consumed'
          ? 409
          : result === 'invalid_device_code'
            ? 404
            : 400,
        result,
        result,
      )
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 2592000,
      scope: 'chat profile',
      user: adminUserToDict(result.user),
    }
  }
}
