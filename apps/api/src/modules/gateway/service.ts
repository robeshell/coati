import { loadAdminsWithRolesByIds } from '@/common/auth'
import { utcNowIso } from '@/common/serialize'
import type { AppConfig } from '@/config'
import type { Db } from '@/db/client'
import { adminUserToDict } from '@/db/schema/admin/rbac'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { accountMetadata, credentialMetadata } from './account-metadata'
import { supportedModels, supportsModel } from './account-models'
import { proxyHint, proxySecrets } from './account-proxy'
import { CacheTestRepository } from './cache-test-repository'
import { CredentialVault, hashToken, mintToken, parsePreviousKeys, redact } from './crypto'
import { deviceFlowPolicy } from './device-policy'
import { discoverModels } from './discovery'
import { environmentFallback, type EnvironmentFallback } from './environment-fallback'
import { executeGateway } from './execution'
import { profileRecord } from './model-profile'
import { ModelProfileRepository } from './model-profile-repository'
import { personalModelNames } from './personal-route'
import { reservationTtlSeconds } from './quota-policy'
import { GatewayRepository, type KeyRow } from './repository'
import { routeConsolidationPreflight } from './route-preflight'
import { schedulingPolicy, type SchedulingPolicy } from './scheduling-policy'
import {
  GatewayError,
  keySchema,
  keyUpdateSchema,
  publicRouteSchema,
  routeSchema,
  upstreamSchema,
  userLimitsSchema,
  type Protocol
} from './schema'
import { estimateMessageTokens } from './token-estimate'
import {
  GatewayTransport,
  routeBase,
  validateBase
} from './transport'

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
  async recoverInterrupted() {
    await this.repo.recoverExpired()
    await new CacheTestRepository(this.repo.db).recoverInterrupted()
  }

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
  async routeConsolidationPreflight() {
    return routeConsolidationPreflight(
      await this.repo.routeConsolidationSnapshot(),
      this.options.allowPrivate,
    )
  }
  routeConsolidations() {
    return this.repo.routeConsolidations()
  }
  async applyRouteConsolidation(body: unknown, actor: number) {
    const data = z
      .object({
        model: z.string().min(1).max(200),
        version: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(body)
    return this.consolidationWrite(() =>
      this.repo.applyRouteConsolidation(
        data.model,
        data.version,
        actor,
        this.options.allowPrivate,
      ),
    )
  }
  rollbackRouteConsolidation(id: string, actor: number) {
    return this.consolidationWrite(() =>
      this.repo.rollbackRouteConsolidation(z.uuid().parse(id), actor),
    )
  }
  private async consolidationWrite<T>(operation: () => Promise<T>): Promise<T> {
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
        expires_days === null ? null : utcNowIso(new Date(Date.now() + expires_days * 86400000)),
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
    return executeGateway(this, key, raw, protocol, clientSignal, headers, executionPolicy)
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
      expires_at: utcNowIso(new Date(Date.now() + policy.ttlSeconds * 1000)),
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
        expires_at: utcNowIso(new Date(Date.now() + 30 * 86400000)),
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
