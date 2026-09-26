import {
  accountMetadata,
  accountSummary,
  credentialMetadata,
} from './account-metadata'
import { proxyHint, proxySecrets } from './account-proxy'
import { discoverModels, discoveryFailureMessage } from './discovery'
import { redact } from './crypto'
import { z } from 'zod'
import { utcNowIso } from '@/common/serialize'
import { supportedModels } from './account-models'
import { personalModelNames } from './personal-route'
import { GatewayError, upstreamSchema } from './schema'
import type { GatewayService } from './service'
import type { UpstreamRow } from './repository'
import { validateBase } from './transport'

const inputSchema = upstreamSchema
  .extend({
    model_prefix: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(
        (value) => !/[\s\\]/u.test(value),
        '模型前缀不能包含空白或反斜杠',
      ),
  })
  .strict()
const editable = [
  'name',
  'request_timeout_seconds',
  'extra_headers',
  'note',
  'protocol',
  'base_url',
  'supported_models',
  'default_model',
  'priority',
  'weight',
  'concurrency_limit',
  'enabled',
  'provider',
  'model_prefix',
] as const
export function personalChannelRecord(row: UpstreamRow) {
  return {
    id: row.id,
    ...accountMetadata(row),
    ...Object.fromEntries(editable.map((key) => [key, row[key]])),
    supported_models: supportedModels(row),
    display_models: personalModelNames(row),
    proxy_hint: row.proxy_hint,
    has_proxy: Boolean(row.proxy_secret),
    has_secret: Boolean(row.secret),
    scope: row.scope,
    owner_user_id: row.owner_user_id,
    health_status: row.health_status,
    last_probe_at: row.last_probe_at
      ? utcNowIso(new Date(row.last_probe_at)) + 'Z'
      : null,
    last_probe_status: row.last_probe_status,
    last_probe_latency_ms: row.last_probe_latency_ms,
    consecutive_failures: row.consecutive_failures,
    last_error: row.last_error,
    cooldown_until: row.cooldown_until
      ? utcNowIso(new Date(row.cooldown_until)) + 'Z'
      : null,
    created_at: utcNowIso(new Date(row.created_at)) + 'Z',
  }
}
export async function savePersonalChannel(
  service: GatewayService,
  owner: number,
  raw: unknown,
  id?: number,
) {
  const data = z.record(z.string(), z.unknown()).parse(raw)
  const row = await service.repo.savePersonalChannel(
    owner,
    (existing) => {
      const input = inputSchema.parse({
        ...(existing
          ? Object.fromEntries(editable.map((key) => [key, existing[key]]))
          : {}),
        ...data,
      })
      if (!input.api_key && !existing)
        throw new GatewayError(400, '请输入上游 API Key')
      const { api_key, proxy_url, ...fields } = input
      return {
        ...fields,
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
        base_url: validateBase(input.base_url, service.options.allowPrivate),
        supported_models: supportedModels({
          supported_models: input.supported_models ?? [],
          default_model: input.default_model ?? '',
        }),
        secret: api_key ? service.vault.encrypt(api_key) : existing!.secret,
      }
    },
    id,
  )
  if (id !== undefined) return personalChannelRecord(row)
  // Saving has committed. A failed observation must not report a failed creation.
  let probe: Record<string, unknown>
  try {
    const result = await service.probeUpstream(row.id, 0, owner)
    probe = { ...result, ok: result.verified, attempted: true }
  } catch (error) {
    probe = {
      ok: false,
      verified: false,
      attempted: true,
      message:
        error instanceof GatewayError
          ? error.message
          : '自动探活失败，请手动重试',
    }
  }
  const refreshed =
    (await service.repo.personalChannelRows(owner)).find(
      (item) => item.id === row.id,
    ) ?? row
  return {
    ...personalChannelRecord(refreshed),
    health_probe: probe,
  }
}
const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  enabled: z.enum(['true', 'false']).optional(),
  protocol: upstreamSchema.shape.protocol.optional(),
  provider: z.string().optional(),
  health_status: z.string().optional(),
})
export async function listPersonalChannels(
  service: GatewayService,
  owner: number,
  query: unknown,
) {
  const filter = querySchema.parse(query)
  const all = await service.repo.personalChannelRows(owner)
  const matches = all.filter(
    (row) =>
      (!filter.search ||
        row.name.toLowerCase().includes(filter.search.toLowerCase())) &&
      (filter.enabled === undefined ||
        row.enabled === (filter.enabled === 'true')) &&
      (!filter.protocol || row.protocol === filter.protocol) &&
      (!filter.provider || row.provider === filter.provider) &&
      (!filter.health_status || row.health_status === filter.health_status),
  )
  return {
    items: matches
      .slice((filter.page - 1) * filter.per_page, filter.page * filter.per_page)
      .map(personalChannelRecord),
    total: matches.length,
    page: filter.page,
    per_page: filter.per_page,
    limit: 5,
    summary: accountSummary(all),
  }
}

const discoverySchema = z
  .object({
    request_timeout_seconds: upstreamSchema.shape.request_timeout_seconds,
    proxy_url: upstreamSchema.shape.proxy_url,
    credential_id: z.number().int().positive().optional(),
    base_url: z.string().max(2000).optional(),
    api_key: z.string().max(8192).optional(),
    protocol: upstreamSchema.shape.protocol.optional(),
    extra_headers: upstreamSchema.shape.extra_headers,
  })
  .strict()
export async function discoverPersonalModels(
  service: GatewayService,
  owner: number | undefined,
  raw: unknown,
) {
  const input = discoverySchema.parse(raw)
  const row =
    input.credential_id === undefined
      ? undefined
      : (
          await (owner === undefined
            ? service.repo.upstreams()
            : service.repo.personalChannelRows(owner))
        ).find((item) => item.id === input.credential_id)
  if (input.credential_id !== undefined && !row)
    throw new GatewayError(404, '渠道不存在')
  let base: string
  let secret: string
  if (row && !input.api_key) {
    if (
      input.base_url &&
      input.base_url.trim().replace(/\/+$/, '') !==
        row.base_url.replace(/\/+$/, '')
    )
      throw new GatewayError(
        400,
        '测试已保存 Key 时不能覆盖 Base URL；请先保存修改或填写新 Key',
      )
    if (input.protocol && input.protocol !== row.protocol)
      throw new GatewayError(
        400,
        '测试已保存 Key 时不能切换上游接口；请先保存修改或填写新 Key',
      )
    base = row.base_url
    secret = service.vault.decrypt(row.secret)
  } else {
    if (!input.base_url?.trim())
      throw new GatewayError(400, '请先填写 Base URL')
    if (!input.api_key) throw new GatewayError(400, '请先填写 API Key')
    base = validateBase(input.base_url, service.options.allowPrivate)
    secret = input.api_key
  }
  const proxyUrl =
    input.proxy_url === undefined
      ? row?.proxy_secret && !input.api_key
        ? service.vault.decrypt(row.proxy_secret)
        : null
      : input.proxy_url
  const extraHeaders =
    input.extra_headers ?? (row && !input.api_key ? row.extra_headers : {})
  const timeoutMs = Math.min(
    30000,
    (input.request_timeout_seconds ??
      (row && !input.api_key ? row.request_timeout_seconds : 30)) * 1000,
  )
  const started = Date.now()
  try {
    const result = await discoverModels(
      service.transport,
      base,
      secret,
      AbortSignal.timeout(Math.min(service.options.timeoutMs, timeoutMs)),
      extraHeaders,
      timeoutMs,
      proxyUrl,
      owner === undefined,
    )
    return {
      ...result,
      model_count: result.models.length,
      latency_ms: Date.now() - started,
      ...(!result.models.length
        ? { message: '当前上游接口不支持模型列表，请手动填写' }
        : {}),
    }
  } catch (error) {
    throw new GatewayError(
      502,
      redact(
        discoveryFailureMessage(error),
        [
          secret,
          ...Object.values(extraHeaders),
          ...proxySecrets(proxyUrl),
          row?.proxy_secret ?? '',
        ],
      ),
      'upstream_discovery_failed',
    )
  }
}
