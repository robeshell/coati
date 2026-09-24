import request from '@/shared/api/request'

const BASE = '/admin/agent/cache-tests'

export const getCacheTestModels = () => request.get(`${BASE}/models`)
export const listCacheTests = (params) => request.get(BASE, { params })
// 运行测试为同步执行 N 轮上游调用，放宽单请求超时
export const runCacheTest = (data) => request.post(BASE, data, { timeout: 180000 })
export const getCacheTest = (id) => request.get(`${BASE}/${id}`)
export const deleteCacheTest = (id) => request.delete(`${BASE}/${id}`)
