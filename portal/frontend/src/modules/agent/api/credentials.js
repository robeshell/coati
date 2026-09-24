import request from '@/shared/api/request'

export const listCredentials = (params) => request.get('/admin/agent/credentials', { params })
export const listCredentialProviders = () => request.get('/admin/agent/providers')
export const listCredentialUpstreamProtocols = () => request.get('/admin/agent/upstream-protocols')
export const createCredential = (data) => request.post('/admin/agent/credentials', data)
export const updateCredential = (id, data) => request.put(`/admin/agent/credentials/${id}`, data)
export const deleteCredential = (id) => request.delete(`/admin/agent/credentials/${id}`)
export const copyCredential = (id) => request.post(`/admin/agent/credentials/${id}/copy`)
export const discoverCredentialModels = (data) => request.post('/admin/agent/credentials/discover-models', data)
export const checkCredential = (id) => request.post(`/admin/agent/credentials/${id}/check`)
