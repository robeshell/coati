import request from '@/shared/api/request'

export const listMyChannels = (params) => request.get('/admin/agent/my-channels', { params })
export const listMyChannelProviders = () => request.get('/admin/agent/my-channels/providers')
export const listMyChannelUpstreamProtocols = () => request.get('/admin/agent/my-channels/upstream-protocols')
export const createMyChannel = (data) => request.post('/admin/agent/my-channels', data)
export const updateMyChannel = (id, data) => request.put(`/admin/agent/my-channels/${id}`, data)
export const deleteMyChannel = (id) => request.delete(`/admin/agent/my-channels/${id}`)
export const discoverMyChannelModels = (data) => request.post('/admin/agent/my-channels/discover-models', data)
export const checkMyChannel = (id) => request.post(`/admin/agent/my-channels/${id}/check`)
