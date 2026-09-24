import request from '@/shared/api/request'

export const listRoutes = (params) => request.get('/admin/agent/routes', { params })
export const createRoute = (data) => request.post('/admin/agent/routes', data)
export const updateRoute = (id, data) => request.put(`/admin/agent/routes/${id}`, data)
export const deleteRoute = (id) => request.delete(`/admin/agent/routes/${id}`)
