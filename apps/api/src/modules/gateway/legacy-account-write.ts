import { GatewayError, upstreamSchema } from './schema'
import { legacyAccountRecord } from './legacy-account-list'
import { supportedModels } from './account-models'
import { credentialMetadata } from './account-metadata'
import { proxyHint } from './account-proxy'
import { validateBase } from './transport'
import { discoverPersonalModels } from './personal-channel'
import type { GatewayService } from './service'
import type { UpstreamRow } from './repository'

function object(value: unknown): Record<string, unknown> {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new GatewayError(400, '账号配置必须是对象')
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, max = 8192) {
  if (value != null && typeof value === 'object')
    throw new GatewayError(400, `${label} 必须是文本`)
  const result =
    value == null
      ? ''
      : String(
          typeof value === 'boolean' ? (value ? 'True' : 'False') : value,
        ).trim()
  if ([...result].length > max)
    throw new GatewayError(400, `${label} 不能超过 ${max} 个字符`)
  return result
}
function integer(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number,
) {
  const result =
    value == null || value === ''
      ? fallback
      : typeof value === 'boolean'
        ? Number(value)
        : typeof value === 'number'
          ? Math.trunc(value)
          : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())
            ? Number(value)
            : NaN
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new GatewayError(400, `${label} 需为 ${min}–${max} 的整数`)
  return result
}
function boolean(value: unknown) {
  if (value == null) return true
  if (typeof value === 'string') {
    if (['false', '0', 'no', 'off'].includes(value.trim().toLowerCase()))
      return false
    if (['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase()))
      return true
  }
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return Boolean(value)
}
const protocolMap: Record<string, string> = {
  'openai-chat': 'openai',
  'openai-responses': 'responses',
  'anthropic-messages': 'anthropic',
}
function protocol(value: unknown) {
  const name = text(value, '上游接口类型', 32) || 'openai-chat'
  if (!Object.hasOwn(protocolMap, name))
    throw new GatewayError(400, '不支持的上游接口类型')
  return protocolMap[name]!
}
function headers(body: Record<string, unknown>) {
  let raw = body.extra_headers ?? body.extra_headers_json ?? {}
  if (raw === '') raw = {}
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      throw new GatewayError(400, '自定义请求头必须是 JSON 对象')
    }
  }
  return Object.fromEntries(
    Object.entries(object(raw)).map(([key, value]) => [
      key.trim(),
      text(value, '请求头', 512),
    ]),
  )
}
function provider(base: string) {
  const host = new URL(base).hostname.toLowerCase()
  for (const name of ['deepseek', 'openai', 'anthropic'])
    if (host.endsWith(`.${name}.com`)) return name
  return 'openai-compatible'
}
export function normalizeLegacyAccount(value: unknown, partial = false) {
  const body = object(value),
    out: Record<string, unknown> = {}
  const has = (key: string) => !partial || Object.hasOwn(body, key)
  for (const [key, label, max] of [
    ['name', '名称', 100],
    ['base_url', 'Base URL', 512],
    ['default_model', '默认模型', 128],
    ['note', '备注', 255],
    ['model_prefix', '模型前缀', 64],
  ] as const) {
    if (!has(key)) continue
    const normalized = text(body[key], label, max)
    if (key === 'name' || key === 'base_url') {
      if (!normalized) {
        if (!partial) throw new GatewayError(400, `${label} 必填`)
        continue
      }
    }
    out[key] = key === 'note' ? normalized || null : normalized
  }
  if (has('upstream_protocol')) out.protocol = protocol(body.upstream_protocol)
  if (has('api_key')) {
    const key = text(body.api_key, 'API Key')
    if (key) out.api_key = key
    else if (!partial) throw new GatewayError(400, 'API Key 必填')
  }
  if (has('proxy_url'))
    out.proxy_url =
      body.proxy_url == null
        ? null
        : text(body.proxy_url, '出站代理', 512) || null
  if (has('extra_headers') || Object.hasOwn(body, 'extra_headers_json'))
    out.extra_headers = headers(body)
  if (has('supported_models')) {
    const models =
      body.supported_models == null || body.supported_models === ''
        ? []
        : body.supported_models
    if (!Array.isArray(models))
      throw new GatewayError(400, '支持模型必须是数组')
    out.supported_models = [
      ...new Set(
        models.map((model) => text(model, '支持模型', 128)).filter(Boolean),
      ),
    ]
  }
  for (const [key, label, min, max, fallback] of [
    ['priority', '优先级', 1, 1000, 100],
    ['weight', '权重', 1, 1000, 100],
    ['request_timeout_seconds', '请求超时', 5, 300, 120],
  ] as const)
    if (has(key)) out[key] = integer(body[key], label, fallback, min, max)
  if (has('enabled')) out.enabled = boolean(body.enabled)
  return out
}
const editable = [
  'name',
  'protocol',
  'base_url',
  'provider',
  'supported_models',
  'default_model',
  'priority',
  'weight',
  'request_timeout_seconds',
  'enabled',
  'note',
  'extra_headers',
  'concurrency_limit',
] as const
async function account(service: GatewayService, id: number, owner?: number) {
  const row = (
    await (owner === undefined
      ? service.repo.upstreams()
      : service.repo.personalChannelRows(owner))
  ).find((row) => row.id === id)
  if (!row)
    throw new GatewayError(
      404,
      owner === undefined ? '凭证不存在' : '渠道不存在',
    )
  return row
}
export async function checkLegacyAccount(
  service: GatewayService,
  id: number,
  owner?: number,
  quiet = 0,
) {
  await account(service, id, owner)
  const result = await service.probeUpstream(id, quiet, owner)
  const row = await account(service, id, owner)
  return {
    ok: result.verified,
    verified: result.verified,
    latency_ms: result.latency_ms,
    health_status: row.health_status,
    model_count: result.models.length,
    ...(!result.verified
      ? {
          message: result.models.length
            ? `已取到 ${result.models.length} 个模型，但该接口的模型列表不能证明对话端点可用，未标记健康`
            : '当前上游接口不提供模型列表，未执行连通性验证；请手动填写模型',
        }
      : {}),
  }
}
export async function saveLegacyAccount(
  service: GatewayService,
  value: unknown,
  id?: number,
  owner?: number,
) {
  const data = normalizeLegacyAccount(value, id !== undefined)
  const build = (existing: UpstreamRow | undefined) => {
    const merged = {
      ...(existing
        ? Object.fromEntries(editable.map((key) => [key, existing[key]]))
        : {}),
      ...data,
    }
    const input = upstreamSchema.parse(merged)
    const base = validateBase(input.base_url, service.options.allowPrivate)
    const prefix =
      owner === undefined
        ? ''
        : text(data.model_prefix ?? existing?.model_prefix, '模型前缀', 64)
    if (owner !== undefined && (!prefix || /[\s\\]/u.test(prefix)))
      throw new GatewayError(400, '个人渠道必须填写不含空白或反斜杠的模型前缀')
    const { api_key, proxy_url, ...fields } = input
    return {
      ...fields,
      base_url: base,
      model_prefix: prefix,
      provider:
        existing && !Object.hasOwn(data, 'base_url')
          ? existing.provider
          : provider(base),
      supported_models: supportedModels({
        supported_models: input.supported_models ?? [],
        default_model: input.default_model ?? '',
      }),
      secret: api_key ? service.vault.encrypt(api_key) : existing!.secret,
      ...(api_key
        ? credentialMetadata(api_key)
        : {
            api_key_hint: existing?.api_key_hint ?? null,
            key_fingerprint: existing?.key_fingerprint ?? null,
          }),
      proxy_secret:
        proxy_url === undefined
          ? (existing?.proxy_secret ?? null)
          : proxy_url
            ? service.vault.encrypt(proxy_url)
            : null,
      proxy_hint:
        proxy_url === undefined
          ? (existing?.proxy_hint ?? null)
          : proxyHint(proxy_url),
    }
  }
  const row =
    owner === undefined
      ? await service.repo.writePlatformAccount(build, id)
      : await service.repo.savePersonalChannel(owner, build, id)
  if (id !== undefined) return legacyAccountRecord(row)
  let probe: Record<string, unknown>
  try {
    probe = {
      ...(await checkLegacyAccount(service, row.id, owner)),
      attempted: true,
    }
  } catch (error) {
    probe = {
      ok: false,
      verified: false,
      attempted: true,
      health_status: row.health_status,
      message:
        error instanceof GatewayError
          ? error.message
          : '自动探活失败，请手动重试',
    }
  }
  return {
    ...legacyAccountRecord(await account(service, row.id, owner)),
    health_probe: probe,
  }
}
export async function discoverLegacyAccounts(
  service: GatewayService,
  value: unknown,
  owner?: number,
) {
  const body = object(value),
    input: Record<string, unknown> = {}
  for (const key of ['base_url', 'api_key', 'proxy_url'] as const)
    if (Object.hasOwn(body, key))
      input[key] = text(body[key], key, key === 'api_key' ? 8192 : 512)
  if (body.credential_id != null && body.credential_id !== '')
    input.credential_id = integer(
      body.credential_id,
      '凭证 ID',
      0,
      1,
      2147483647,
    )
  if (body.upstream_protocol) input.protocol = protocol(body.upstream_protocol)
  if (body.extra_headers !== undefined || body.extra_headers_json !== undefined)
    input.extra_headers = headers(body)
  if (body.request_timeout_seconds != null)
    input.request_timeout_seconds = integer(
      body.request_timeout_seconds,
      '请求超时',
      120,
      5,
      300,
    )
  const result = await discoverPersonalModels(service, owner, input)
  return {
    models: result.models,
    model_count: result.model_count,
    latency_ms: result.latency_ms,
    ...(result.message ? { message: result.message } : {}),
  }
}

export async function probeLegacyAccounts(
  service: GatewayService,
  value: unknown,
) {
  const body =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const limit = body.limit
    ? Math.max(
        1,
        Math.min(50, integer(body.limit, 'limit', 5, -2147483648, 2147483647)),
      )
    : 5
  const quiet = body.quiet_seconds
    ? Math.max(
        30,
        integer(
          body.quiet_seconds,
          'quiet_seconds',
          600,
          -2147483648,
          2147483647,
        ),
      )
    : 600
  // The platform management permission must not expose or operate personal accounts.
  const candidates = await service.repo.probeCandidates(limit, quiet)
  const items: Array<Record<string, unknown>> = []
  for (const candidate of candidates) {
    try {
      const row = await account(service, candidate.id)
      const result = await checkLegacyAccount(service, row.id, undefined, quiet)
      items.push({ id: row.id, name: row.name, scope: 'platform', ...result })
    } catch (error) {
      if (error instanceof GatewayError && error.code === 'probe_busy') continue
      items.push({
        id: candidate.id,
        scope: 'platform',
        ok: false,
        error: error instanceof GatewayError ? error.message : '探测失败',
      })
    }
  }
  return {
    probed: items.length,
    recovered: items.filter((item) => item.ok).length,
    still_failing: items.filter((item) => !item.ok && item.verified !== false)
      .length,
    unverified: items.filter((item) => item.verified === false).length,
    items,
  }
}
