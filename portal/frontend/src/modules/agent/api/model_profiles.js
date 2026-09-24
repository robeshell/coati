import request from '@/shared/api/request'

export const listModelProfiles = (params) => request.get('/admin/agent/model-profiles', { params })
export const listModelProfileCandidates = (params) => request.get('/admin/agent/model-profiles/candidates', { params })
export const createModelProfile = (data) => request.post('/admin/agent/model-profiles', data)
export const updateModelProfile = (id, data) => request.put(`/admin/agent/model-profiles/${id}`, data)
export const deleteModelProfile = (id) => request.delete(`/admin/agent/model-profiles/${id}`)
export const syncModelProfiles = (force = true) => request.post('/admin/agent/model-profiles/sync', { force })
