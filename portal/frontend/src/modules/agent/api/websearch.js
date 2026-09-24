import request from '@/shared/api/request'

// 网页搜索后端配置（网关能力配置，不是站点配置）
export const getWebSearchSettings = () => request.get('/admin/agent/web-search')
export const updateWebSearchSettings = (data) => request.put('/admin/agent/web-search', data)
export const testWebSearchSettings = () => request.post('/admin/agent/web-search/test')
