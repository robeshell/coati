import { upstreamTimeout } from './upstream-failure'
import { withAccountHeaders } from './account-headers'
import { GatewayTransport, readBounded, validateBase } from './transport'

function modelIds(body: unknown): string[] {
  let values: unknown = body
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    const record = values as Record<string, unknown>
    values = record.data ?? record.models
  }
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    const record = values as Record<string, unknown>
    values = record.data ?? record.models
  }
  if (!Array.isArray(values)) return []
  return [
    ...new Set(
      values.flatMap((item) => {
        const value =
          item && typeof item === 'object'
            ? item.id || item.model || item.name
            : item
        return typeof value === 'string' && value.trim() ? [value.trim()] : []
      }),
    ),
  ].sort()
}

export async function discoverModels(
  transport: GatewayTransport,
  base: string,
  secret: string,
  signal: AbortSignal,
  extraHeaders: unknown = {},
  timeoutMs = 30000,
  proxyUrl?: string | null,
  platform = false,
) {
  const root = validateBase(base, transport.allowPrivate)
  const urls = [
    root + '/models',
    ...(/\/v1$/i.test(root) ? [] : [root + '/v1/models']),
  ]
  for (const url of urls) {
    const response = await transport.discover(
      url,
      withAccountHeaders(
        {
          authorization: `Bearer ${secret}`,
          'x-api-key': secret,
          'anthropic-version': '2023-06-01',
          accept: 'application/json',
        },
        extraHeaders,
      ),
      signal,
      timeoutMs,
      proxyUrl,
      platform,
    )
    const text = await readBounded(response, 1024 * 1024)
    if ([404, 405, 501].includes(response.status)) continue
    if (!response.ok) throw new Error(`Model discovery HTTP ${response.status}`)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      continue
    }
    const models = modelIds(body)
    if (models.length) return { models, model_discovery_supported: true }
  }
  return { models: [] as string[], model_discovery_supported: false }
}

/** Safe diagnostic categories for fetch's nested DNS/socket causes; never expose raw headers. */
export function discoveryFailureMessage(error: unknown): string {
  let current: unknown = error
  const seen = new Set<unknown>()
  for (
    let depth = 0;
    depth < 8 && current instanceof Error && !seen.has(current);
    depth++
  ) {
    seen.add(current)
    if (
      current.message.includes('Private upstream') ||
      current.message.includes('Private proxy')
    )
      return '上游或代理地址被解析为非公网地址，已被安全策略拦截。若使用 Fake-IP 代理，请将上游域名设为真实 DNS 解析后重试。'
    const code = (current as NodeJS.ErrnoException).code
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
      return '上游域名解析失败，请检查服务端 DNS 或代理配置'
    if (code === 'ECONNREFUSED')
      return '无法连接上游或代理，请检查地址、端口及服务端网络'
    current = current.cause
  }
  if (upstreamTimeout(error))
    return '模型发现请求超时，请检查服务端网络或代理配置'
  if (error instanceof Error && error.message === 'Model discovery HTTP 401')
    return '上游拒绝认证（HTTP 401），请检查 API Key'
  if (error instanceof Error && error.message === 'Model discovery HTTP 403')
    return '上游拒绝访问（HTTP 403），请检查账号权限或网络访问限制'
  return error instanceof Error ? error.message : 'Model discovery failed'
}
