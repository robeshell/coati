import type { Account } from '@/modules/gateway/api/types'
export const accountDefaults = {
  name: '',
  protocol: 'openai',
  provider: 'openai-compatible',
  base_url: '',
  api_key: '',
  supported_models: '',
  default_model: '',
  model_prefix: '',
  enabled: true,
  weight: 100,
  priority: 100,
  concurrency_limit: 10,
  request_timeout_seconds: 120,
  note: '',
  extra_headers: '{}',
  proxy_mode: 'keep',
  proxy_url: '',
}
export type AccountForm = typeof accountDefaults
export function accountValues(row?: Account | null): AccountForm {
  return row
    ? {
        ...accountDefaults,
        ...row,
        note: row.note ?? '',
        api_key: '',
        proxy_mode: 'keep',
        proxy_url: '',
        supported_models: (row.supported_models || []).join('\n'),
        extra_headers: JSON.stringify(row.extra_headers || {}, null, 2),
      }
    : { ...accountDefaults }
}
export function accountBody(values: AccountForm, personal: boolean) {
  let headers
  try {
    headers = JSON.parse(values.extra_headers || '{}')
  } catch {
    throw new Error('自定义请求头必须是 JSON 对象')
  }
  if (!headers || typeof headers !== 'object' || Array.isArray(headers))
    throw new Error('自定义请求头必须是 JSON 对象')
  const body: Record<string, unknown> = Object.fromEntries(
    ([
      'name',
      'protocol',
      'provider',
      'base_url',
      'default_model',
      'enabled',
      'weight',
      'priority',
      'concurrency_limit',
      'request_timeout_seconds',
      'note',
    ] as const).map((key) => [key, values[key]]),
  )
  body.supported_models = [
    ...new Set(
      values.supported_models
        .split(/[,，\n]/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ]
  body.extra_headers = headers
  if (values.api_key.trim()) body.api_key = values.api_key.trim()
  if (personal) body.model_prefix = values.model_prefix.trim()
  if (values.proxy_mode === 'clear') body.proxy_url = null
  if (values.proxy_mode === 'replace') {
    if (!values.proxy_url.trim()) throw new Error('请输入新的代理地址')
    body.proxy_url = values.proxy_url.trim()
  }
  return body
}
