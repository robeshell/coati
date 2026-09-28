import type { Analytics, RouteHealth, AccountList, PublicRoutes, RouteConsolidations, RoutePreflight, Key, Routes, Query, UserLimits, UsageList, QuotaList, ProbeResult, MutationResult, CheckResult, Overview } from '@/modules/gateway/api/types'
import request from '@/shared/api/request'
const base = '/admin/gateway'
interface Resources { 'public-routes': { items: PublicRoutes }; upstreams: AccountList; 'my-channels': AccountList; keys: { items: Key[] }; routes: { items: Routes }; overview: Overview }
export function listGateway<R extends keyof Resources>(resource: R, params?: Query): Promise<Resources[R]>
export function listGateway(resource: `user-limits/${number}`, params?: Query): Promise<UserLimits>
export function listGateway<T>(resource: string, params?: Query): Promise<T>
export function listGateway(resource: string, params?: Query): Promise<unknown> { return request.get<unknown, unknown>(`${base}/${resource}`, { params }) }
export const saveGateway = (resource: string, body: unknown, id?: number) =>
  id
    ? request.put<unknown, MutationResult>(`${base}/${resource}/${id}`, body)
    : request.post<unknown, MutationResult>(`${base}/${resource}`, body)
export const disableGateway = (resource: string, id: number) =>
  request.delete(`${base}/${resource}/${id}`)
export const confirmDevice = (user_code: string) =>
  request.post<unknown, { ok: boolean; user_code?: string }>(`${base}/device/confirm`, { user_code })

export const denyDevice = (user_code: string) =>
  request.post<unknown, { ok: boolean; user_code?: string }>(`${base}/device/deny`, { user_code })

export const probeAccount = (id: number) =>
  request.post<unknown, ProbeResult>(`${base}/upstreams/${id}/probe`)

export const rotateKey = (id: number) => request.post<unknown, { token: string }>(`${base}/keys/${id}/rotate`)

export const listMyUsage = (params?: Query) =>
  request.get<unknown, UsageList>('/agent/me/usage', { params })
export const exportMyUsage = (body: unknown) =>
  request.post<unknown, Blob>('/agent/me/usage/export', body, { responseType: 'blob' })

export const listQuotas = (params?: Query) => request.get<unknown, QuotaList>('/admin/agent/quotas', { params })
export const updateQuota = (id: number, body: unknown) => request.put(`/admin/agent/quotas/${id}`, body)

export const listAdminUsage = (params?: Query) => request.get<unknown, UsageList>('/admin/agent/usage', { params })

export const getUsageAnalytics = (scope: string, params?: Query) => request.get<unknown, Analytics>(scope === 'admin' ? '/admin/agent/usage/analytics' : '/agent/me/usage/analytics', { params })

export const routeConsolidationPreflight = () => request.get<unknown, RoutePreflight>(`${base}/route-consolidation/preflight`)
export const routeConsolidationHistory = () => request.get<unknown, { items: RouteConsolidations }>(`${base}/route-consolidation/history`)
export const applyRouteConsolidation = (body: unknown) => request.post(`${base}/route-consolidation/apply`, body)
export const rollbackRouteConsolidation = (id: string) => request.post(`${base}/route-consolidation/${id}/rollback`, {})

const accountPath = (personal: boolean) => `/admin/agent/${personal ? 'my-channels' : 'credentials'}`
export const discoverAccountModels = (personal: boolean, body: unknown) => request.post<unknown, { models: string[] }>(`${accountPath(personal)}/discover-models`, body)
export const checkAccount = (personal: boolean, id: number) => request.post<unknown, CheckResult>(`${accountPath(personal)}/${id}/check`, {})
export const deleteAccount = (personal: boolean, id: number) => request.delete(`${accountPath(personal)}/${id}`)
export const copyAccount = (id: number) => request.post(`${accountPath(false)}/${id}/copy`, {})

export const listRouteHealth = () => request.get<unknown, RouteHealth>('/admin/agent/routes', { params: { page: 1, per_page: 1, include_summary: true } })
