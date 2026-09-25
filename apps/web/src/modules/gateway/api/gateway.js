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
