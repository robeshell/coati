import request from '@/shared/api/request'

// 系统设置 —— 桌面端更新配置
export const getDesktopUpdateSettings = () => request.get('/admin/settings/desktop-update')
export const updateDesktopUpdateSettings = (data) => request.put('/admin/settings/desktop-update', data)

// 系统设置 —— 产品站下载配置
export const getSiteDownloadSettings = () => request.get('/admin/settings/site-download')
export const updateSiteDownloadSettings = (data) => request.put('/admin/settings/site-download', data)
