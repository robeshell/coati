import { GatewayError, publicRouteSchema } from './schema'
import { supportsModel } from './account-models'
import { routeBase } from './transport'
import { legacyRouteRecord } from './legacy-route-list'
import type { GatewayRepository } from './repository'

function text(value: unknown, label: string, limit: number, required = false) {
  if (value != null && typeof value === 'object')
    throw new GatewayError(400, `${label} 必须是文本`)
  const normalized =
    value == null
      ? ''
      : String(
          typeof value === 'boolean' ? (value ? 'True' : 'False') : value,
        ).trim()
  if (required && !normalized) throw new GatewayError(400, `${label} 必填`)
  if (normalized.length > limit)
    throw new GatewayError(400, `${label} 不能超过 ${limit} 个字符`)
  return normalized || null
}
function boolean(value: unknown, fallback: boolean) {
  if (value == null) return fallback
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
export function normalizeLegacyRoute(value: unknown, partial = false) {
  if (value == null) value = {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new GatewayError(400, '路由配置必须是对象')
  const body = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const has = (key: string) => !partial || Object.hasOwn(body, key)
  for (const [key, target, label, max] of [
    ['model_name', 'model', '模型名称', 128],
    ['upstream_model', 'upstream_model', '上游模型', 128],
    ['vision_model', 'vision_model', '含图时模型', 128],
    ['description', 'description', '路由说明', 255],
    ['upstream_base', 'upstream_base', '上游地址', 512],
  ] as const)
    if (has(key))
      out[target] = text(body[key], label, max, key === 'model_name')
  if (out.upstream_base) {
    try {
      const url = new URL(out.upstream_base as string)
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname)
        throw new Error()
    } catch {
      throw new GatewayError(400, '上游地址 必须是有效的 HTTP(S) 地址')
    }
    out.upstream_base = (out.upstream_base as string).replace(/\/+$/, '')
  }
  if (has('credential_id')) {
    const raw = body.credential_id
    let id: number | null = null
    if (raw != null && raw !== '') {
      if (typeof raw === 'boolean') id = raw ? 1 : 0
      else if (typeof raw === 'number' && Number.isFinite(raw))
        id = Math.trunc(raw)
      else if (typeof raw === 'string' && /^[+-]?\d+$/.test(raw.trim()))
        id = Number(raw)
      else throw new GatewayError(400, '上游凭证 必须是整数')
      if (!Number.isSafeInteger(id))
        throw new GatewayError(400, '上游凭证 必须是整数')
      if (id < 1) throw new GatewayError(400, '上游凭证 不能小于 1')
    }
    out.upstream_id = id
  }
  if (has('enabled')) out.enabled = boolean(body.enabled, true)
  if (has('fallback_enabled'))
    out.fallback_enabled = boolean(body.fallback_enabled, false)
  return out
}
const origin = (value: string) => {
  const url = new URL(value)
  const authority =
    value.split('://')[1]?.split(/[/?#]/)[0]?.split('@').pop() || ''
  return [
    url.protocol,
    url.hostname,
    authority.match(/:(\d+)$/)?.[1] || null,
  ].join('|')
}
export async function saveLegacyRoute(
  repo: GatewayRepository,
  value: unknown,
  allowPrivate: boolean,
  id?: number,
) {
  const existing = id
    ? (await repo.publicRoutes()).find((row) => row.id === id)
    : undefined
  if (id && !existing) throw new GatewayError(404, '路由不存在')
  const data = publicRouteSchema.parse({
    ...existing,
    ...normalizeLegacyRoute(value, Boolean(id)),
  })
  if (
    (await repo.publicRoutes()).some(
      (row) => row.model === data.model && row.id !== id,
    )
  )
    throw new GatewayError(409, '模型名称已存在')
  if (data.model === 'coati-auto' && !data.upstream_model)
    throw new GatewayError(
      422,
      '自动路由（coati-auto）必须配置「实际模型」作为纯文本目标',
    )
  const account = data.upstream_id
    ? (await repo.upstreams()).find((row) => row.id === data.upstream_id)
    : undefined
  if (data.upstream_id && !account)
    throw new GatewayError(400, '选择的上游凭证不存在')
  if (account) {
    if (data.enabled && !account.enabled)
      throw new GatewayError(422, '生效的模型路由不能绑定已停用的模型账号')
    for (const [label, target] of [
      ['实际模型', data.upstream_model],
      ['含图时模型', data.vision_model],
    ])
      if (target && !supportsModel(account, target))
        throw new GatewayError(
          422,
          `绑定的模型账号不支持${label}「${target}」，请修改模型配置或更换账号`,
        )
  }
  if (data.upstream_base) {
    if (!account)
      throw new GatewayError(
        422,
        '覆盖上游地址时必须绑定一把 Key，避免将随机 Key 发往错误服务',
      )
    if (origin(data.upstream_base) !== origin(account.base_url))
      throw new GatewayError(
        422,
        '路由覆盖地址只能调整同一上游域名下的路径；切换域名请修改 Key 配置',
      )
    // Validate network and credential-bearing URL policy without changing legacy storage shape.
    routeBase(account.base_url, data.upstream_base, allowPrivate)
  }
  try {
    const saved = await repo.savePublicRoute(data, id)
    if (!saved) throw new GatewayError(404, '路由不存在')
    return legacyRouteRecord(saved)
  } catch (error) {
    if (error instanceof GatewayError && error.message === '公开模型路由已存在')
      throw new GatewayError(409, '模型名称已存在')
    throw error
  }
}
export async function deleteLegacyRoute(repo: GatewayRepository, id: number) {
  try {
    await repo.deletePublicRoute(id)
    return { ok: true }
  } catch (error) {
    if (error instanceof GatewayError) {
      if (error.status === 404) throw new GatewayError(404, '路由不存在')
      if (error.status === 409)
        throw new GatewayError(
          409,
          '启用中的模型路由不能删除，请先停用后再删除',
        )
    }
    throw error
  }
}
