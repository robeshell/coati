import request from '@/shared/api/request'

export const confirmDevice = (user_code) => request.post('/agent/auth/device/confirm', { user_code })
