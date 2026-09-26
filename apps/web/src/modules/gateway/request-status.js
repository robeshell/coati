/** Public usage APIs normalize legacy error/cancelled aliases before filtering. */
export const requestStatuses = {
  ok: '成功',
  upstream_error: '上游错误',
  stream_error: '流中断',
  client_error: '客户端中断',
  protocol_error: '协议转换失败',
  routing_error: '路由失败',
  quota_exceeded: '超过配额',
  interrupted: '进程中断',
  reserved: '进行中',
}
export const requestStatusLabels = {...requestStatuses, error:'失败', cancelled:'已取消'}
