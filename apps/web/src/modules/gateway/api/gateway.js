import request from '@/shared/api/request'
const base = '/admin/gateway'
export const listGateway = (resource, params) =>
  request.get(`${base}/${resource}`, { params })
export const saveGateway = (resource, body, id) =>
  id
    ? request.put(`${base}/${resource}/${id}`, body)
    : request.post(`${base}/${resource}`, body)
export const disableGateway = (resource, id) =>
  request.delete(`${base}/${resource}/${id}`)
export const confirmDevice = (user_code) =>
  request.post(`${base}/device/confirm`, { user_code })

export const denyDevice = (user_code) =>
  request.post(`${base}/device/deny`, { user_code })

export const probeAccount = (id) =>
  request.post(`${base}/upstreams/${id}/probe`)

export const rotateKey = (id) => request.post(`${base}/keys/${id}/rotate`)

export const listMyUsage = (params) =>
  request.get('/agent/me/usage', { params })
export const exportMyUsage = (body) =>
  request.post('/agent/me/usage/export', body, { responseType: 'blob' })

export const listQuotas = params => request.get('/admin/agent/quotas', { params })
export const updateQuota = (id, body) => request.put(`/admin/agent/quotas/${id}`, body)

export const listAdminUsage = params => request.get('/admin/agent/usage', { params })

export const getUsageAnalytics = (scope, params) => request.get(scope === 'admin' ? '/admin/agent/usage/analytics' : '/agent/me/usage/analytics', { params })

export const routeMigrationPreflight = () => request.get(`${base}/route-migration/preflight`)
export const routeMigrationHistory = () => request.get(`${base}/route-migration/history`)
export const applyRouteMigration = body => request.post(`${base}/route-migration/apply`, body)
export const rollbackRouteMigration = id => request.post(`${base}/route-migration/${id}/rollback`, {})

const accountPath = personal => `/admin/agent/${personal ? 'my-channels' : 'credentials'}`
export const discoverAccountModels = (personal, body) => request.post(`${accountPath(personal)}/discover-models`, body)
export const checkAccount = (personal, id) => request.post(`${accountPath(personal)}/${id}/check`, {})
export const deleteAccount = (personal, id) => request.delete(`${accountPath(personal)}/${id}`)
export const copyAccount = id => request.post(`${accountPath(false)}/${id}/copy`, {})

export const listRouteHealth = () => request.get('/admin/agent/routes', { params: { page: 1, per_page: 1, include_summary: true } })
