/** Framework request-body declarations for the console, isolated from model protocol traffic.
 * Console input fields are converted and checked in the service layer.
 * The transport declaration accepts their documented raw JSON shapes.
 */
import { z } from 'zod'
import type { FastifyRequest } from 'fastify'
import { routeBody, type BodySchema } from '@/common/validation'
import { upstreamSchema, routeSchema, publicRouteSchema, keySchema, keyUpdateSchema, userLimitsSchema } from './schema'
import { profileInput } from './model-profile'
import { searchSettingsInput } from './search-settings'
import { cacheTestInput } from './cache-test'
import { createSchema } from './personal-access'
import { inputSchema, discoverySchema } from './personal-channel'

const rawFields = (names: string[]) => z.looseObject(Object.fromEntries(names.map(name => [name, z.unknown().optional().describe('保留兼容接口的原始 JSON 值；类型转换、长度及业务约束由服务层校验')])) )
const accountBody = rawFields(['name','base_url','default_model','note','model_prefix','upstream_protocol','api_key','proxy_url','extra_headers','extra_headers_json','supported_models','priority','weight','request_timeout_seconds','enabled'])
const discoveryBody = rawFields(['credential_id','base_url','api_key','proxy_url','upstream_protocol','extra_headers','extra_headers_json','request_timeout_seconds'])
const candidateRouteBody = rawFields(['model_name','upstream_model','vision_model','description','upstream_base','credential_id','enabled','fallback_enabled'])
const exportUsage = z.looseObject({ fields: z.array(z.string()).nullish(), file_type: z.string().nullish(), export_mode: z.string().nullish(), ids: z.array(z.string().min(1).max(100)).max(5000).nullish(), filters: z.record(z.string(), z.unknown()).nullish() })
const profileSync = z.object({ source: z.string().trim().min(1).max(255).default('admin-import'), items: z.array(z.object({ model_name: z.string().trim().min(1).max(128), context_window: z.coerce.number().int().min(1).max(1000000), max_output_tokens: z.coerce.number().int().min(1).max(1000000) })).max(1000).optional(), force: z.boolean().optional() })

export function gatewayAdminBody(method: string, path: string) {
  if (!['POST', 'PUT', 'PATCH'].includes(method)) return undefined
  let schema: BodySchema | undefined
  let patch = method !== 'POST'
  if (path.endsWith('/web-search')) { schema = searchSettingsInput; patch = false }
  else if (path.endsWith('/model-profiles/sync')) schema = profileSync
  else if (/\/model-profiles(?:\/:id)?$/.test(path)) schema = profileInput
  else if (path.endsWith('/cache-tests')) schema = cacheTestInput
  else if (path.endsWith('/discover-models')) schema = path.includes('/admin/agent/') ? discoveryBody : discoverySchema
  else if (path.endsWith('/health-probe')) schema = rawFields(['limit', 'quiet_seconds'])
  else if (/\/admin\/agent\/(credentials|my-channels)(?:\/:id)?$/.test(path)) schema = accountBody
  else if (/\/admin\/gateway\/my-channels(?:\/:id)?$/.test(path)) schema = inputSchema
  else if (/\/admin\/agent\/routes(?:\/:id)?$/.test(path)) schema = candidateRouteBody
  else if (path.endsWith('/route-consolidation/apply')) schema = z.strictObject({ model: z.string().min(1).max(200), version: z.string().regex(/^[a-f0-9]{64}$/) })
  else if (/\/public-routes(?:\/:id)?$/.test(path)) schema = publicRouteSchema
  else if (path.endsWith('/usage/export')) schema = exportUsage
  else if (/\/auth\/pat(?:\/:id)?$/.test(path)) schema = patch ? keyUpdateSchema : createSchema
  else if (/\/quotas\/:id$/.test(path)) schema = rawFields(['daily_token_quota'])
  else if (/\/user-limits\/:id$/.test(path)) { schema = userLimitsSchema; patch = false }
  else if (/\/gateway\/upstreams(?:\/:id)?$/.test(path)) schema = upstreamSchema
  else if (/\/gateway\/routes(?:\/:id)?$/.test(path)) schema = routeSchema
  else if (/\/gateway\/keys(?:\/:id)?$/.test(path)) schema = patch ? keyUpdateSchema : keySchema
  else if (/\/device\/(confirm|deny)$/.test(path)) schema = rawFields(['user_code'])
  if (!schema) return undefined
  return patch ? routeBody(schema, 'patch') : routeBody(schema, 'create')
}
export function gatewayBodyRoute(method: string, path: string) {
  return gatewayAdminBody(method, path)?.route ?? {}
}
export function readGatewayAdminBody(request: FastifyRequest) {
  const declaration = gatewayAdminBody(request.method, request.routeOptions.url ?? '')
  if (!declaration) throw new Error(`Missing console body declaration: ${request.method} ${request.routeOptions.url}`)
  return declaration.parse(request)
}
