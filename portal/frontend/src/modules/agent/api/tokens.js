import request from '@/shared/api/request'

export const listPats = (params) => request.get('/agent/auth/pat', { params })
export const createPat = (data) => request.post('/agent/auth/pat', data)
export const updatePat = (id, data) => request.put(`/agent/auth/pat/${id}`, data)
export const revokePat = (id) => request.delete(`/agent/auth/pat/${id}`)
export const rotatePat = (id) => request.post(`/agent/auth/pat/${id}/rotate`)
export const listPatUsage = (id, params) => request.get(`/agent/auth/pat/${id}/usage`, { params })
