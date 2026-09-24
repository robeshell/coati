import request from '@/shared/api/request'

export const listUsage = (params) => request.get('/admin/agent/usage', { params })
export const getUsageAnalytics = (params) => request.get('/admin/agent/usage/analytics', { params })
export const listMyUsage = (params) => request.get('/agent/me/usage', { params })
export const getMyUsageAnalytics = (params) => request.get('/agent/me/usage/analytics', { params })
export const exportMyUsage = (data) => request.post('/agent/me/usage/export', data, { responseType: 'blob' })
export const listQuotas = (params) => request.get('/admin/agent/quotas', { params })
export const updateQuota = (userId, data) => request.put(`/admin/agent/quotas/${userId}`, data)
