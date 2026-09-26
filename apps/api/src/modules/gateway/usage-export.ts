import { z } from 'zod'
import {
  buildTable,
  sanitizeFormula,
  type TablePayload,
} from '@/common/tabular'
import { utils, write } from 'xlsx'
import { LegacyPatService } from './legacy-pat'

const fields = {
  created_at: '时间',
  request_id: '请求 ID',
  parent_request_id: '父请求 ID',
  session_id: '会话 ID',
  client_request_id: '客户端请求 ID',
  request_purpose: '请求用途',
  step_index: '步骤序号',
  retry_index: '重试序号',
  model: '模型',
  prompt_tokens: '输入 Token',
  completion_tokens: '输出 Token',
  total_tokens: '合计 Token',
  context_tokens_estimate: '估算上下文 Token',
  context_bytes: '上下文字节数',
  message_count: '消息数',
  tool_count: '工具数',
  image_count: '图片数',
  tool_result_bytes: '工具结果字节数',
  largest_message_bytes: '最大消息字节数',
  cache_read_tokens: '缓存读取 Token',
  cache_write_tokens: '缓存写入 Token',
  cache_miss_tokens: '缓存未命中 Token',
  latency_ms: '耗时(ms)',
  status: '状态',
  error_summary: '错误摘要',
  fallback_used: '是否换号',
  attempt_count: '尝试次数',
} as const
const statuses: Record<string, string> = {
  ok: '成功',
  upstream_error: '上游错误',
  stream_error: '流式中断',
  client_error: '客户端中断',
  routing_error: '路由失败',
  protocol_error: '协议不兼容',
  quota_exceeded: '超过配额',
  reserved: '进行中',
  interrupted: '进程中断',
}
const zeroFields = new Set([
  'context_tokens_estimate',
  'context_bytes',
  'message_count',
  'tool_count',
  'image_count',
  'tool_result_bytes',
  'largest_message_bytes',
])
export async function exportPersonalUsage(
  pats: LegacyPatService,
  owner: number,
  body: unknown,
): Promise<TablePayload> {
  const data = z
    .object({
      fields: z.array(z.string()).nullish(),
      file_type: z.string().nullish(),
      export_mode: z.string().nullish(),
      ids: z.array(z.string().min(1).max(100)).max(5000).nullish(),
      filters: z.record(z.string(), z.unknown()).nullish(),
    })
    .passthrough()
    .parse(body ?? {})
  const selected = data.export_mode?.trim() === 'selected'
  const ids = selected
    ? z
        .array(z.string())
        .min(1, '请先勾选要导出的记录')
        .parse(data.ids ?? [])
    : undefined
  const valid = (data.fields ?? []).filter(
    (field): field is keyof typeof fields => Object.hasOwn(fields, field),
  )
  const columns = valid.length
    ? valid
    : (Object.keys(fields) as (keyof typeof fields)[])
  const result = await pats.usage(owner, undefined, data.filters ?? data, {
    limit: ids?.length ?? 5000,
    ids,
  })
  const rows = result.items.map((row) =>
    columns.map((field) => {
      if (field === 'request_purpose') return row.request_purpose?.label ?? ''
      if (field === 'status') return statuses[row.status] ?? row.status
      if (field === 'fallback_used') return row.fallback_used ? '是' : '否'
      const value = row[field]
      return value ?? (zeroFields.has(field) ? 0 : '')
    }),
  )
  const headers = columns.map((field) => fields[field])
  const type = data.file_type?.trim().toLowerCase()
  if (type !== 'xls')
    return buildTable(
      headers,
      rows,
      'my_usage_export',
      type === 'csv' ? 'csv' : 'xlsx',
    )
  const workbook = utils.book_new()
  utils.book_append_sheet(
    workbook,
    utils.aoa_to_sheet(
      [headers, ...rows].map((row) => row.map(sanitizeFormula)),
    ),
    'Sheet',
  )
  return {
    payload: write(workbook, { type: 'buffer', bookType: 'biff8' }),
    contentType: 'application/vnd.ms-excel',
    filename: 'my_usage_export.xls',
  }
}
