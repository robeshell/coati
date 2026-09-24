import { Button, Descriptions, SideSheet, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import { IconCopy } from '@douyinfe/semi-icons'
import {
  formatNumber, formatReportedToken, formatTime, formatTokenCount, getUsageCacheInfo,
} from '@/modules/agent/utils'

const PROVIDER_LABELS = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI 兼容',
  custom: '自定义兼容',
  environment: '环境变量',
}
const PROTOCOL_LABELS = {
  openai: 'OpenAI Chat Completions',
  anthropic: 'Anthropic Messages',
  responses: 'OpenAI Responses',
  'openai-chat': 'OpenAI Chat Completions',
  'anthropic-messages': 'Anthropic Messages',
  'openai-responses': 'OpenAI Responses',
}

const STATUS_META = {
  ok: { label: '成功', color: 'green' },
  upstream_error: { label: '上游错误', color: 'red' },
  stream_error: { label: '流式中断', color: 'orange' },
  client_error: { label: '客户端中断', color: 'amber' },
  routing_error: { label: '路由失败', color: 'violet' },
  protocol_error: { label: '协议不兼容', color: 'violet' },
  quota_exceeded: { label: '超过配额', color: 'grey' },
}

const REQUEST_PURPOSE_META = {
  model: { label: '模型请求', color: 'blue' },
  compaction: { label: '上下文压缩', color: 'orange' },
  title: { label: '会话标题', color: 'violet' },
}

const valueOrDash = (value) => value === null || value === undefined || value === '' ? '—' : value
const numberOrDash = (value) => value === null || value === undefined ? '—' : formatNumber(value)
const tokenOrDash = (value) => value === null || value === undefined ? '—' : formatTokenCount(value)
const bytesOrDash = (value) => value === null || value === undefined ? '—' : `${formatNumber(value)} B`

function CopyableValue({ value, onCopy }) {
  if (!value) return <Typography.Text type="tertiary">未上报</Typography.Text>
  return (
    <div className="usage-detail-copyable">
      <code>{value}</code>
      <Button
        size="small"
        theme="borderless"
        icon={<IconCopy />}
        aria-label="复制字段值"
        onClick={(event) => {
          event.stopPropagation()
          onCopy(value)
        }}
      />
    </div>
  )
}

function DetailSection({ title, data }) {
  return (
    <section className="usage-detail-section">
      <div className="usage-detail-section__header">
        <span className="usage-detail-section__marker" />
        <Typography.Text strong className="usage-detail-section__title">{title}</Typography.Text>
      </div>
      <div className="usage-detail-section__body">
        <Descriptions row size="small" data={data} />
      </div>
    </section>
  )
}

function DetailMetric({ label, value, hint }) {
  return (
    <div className="usage-detail-metric">
      <Typography.Text type="tertiary" size="small">{label}</Typography.Text>
      <Typography.Text strong className="usage-detail-metric__value">{value}</Typography.Text>
      {hint && <Typography.Text type="tertiary" size="small">{hint}</Typography.Text>}
    </div>
  )
}

function StatusValue({ row }) {
  const meta = STATUS_META[row.status] || { label: row.status || '未知', color: 'grey' }
  return <Tag color={meta.color}>{meta.label}</Tag>
}

function CacheValue({ row }) {
  const cache = getUsageCacheInfo(row)
  if (!cache.hasAny) return <Typography.Text type="tertiary">上游未上报缓存字段</Typography.Text>
  return (
    <div>
      <Tag size="small" color={cache.hitRate === null ? 'amber' : 'green'}>
        {cache.hitRate === null ? '缓存命中率不可用' : `缓存命中 ${cache.hitRate}%`}
      </Tag>
      <Typography.Text type="tertiary" size="small">
        输入 {formatTokenCount(row?.prompt_tokens)} tok · 输出 {formatTokenCount(row?.completion_tokens)} tok
      </Typography.Text>
      <Typography.Text type="tertiary" size="small" style={{ display: 'block' }}>
        缓存读取 {formatReportedToken(cache.read, cache.readReported)} · 缓存写入 {formatReportedToken(cache.write, cache.writeReported)} · 未命中 {formatReportedToken(cache.miss, cache.missReported)}
      </Typography.Text>
      {cache.prompt > 0 && (
        <Typography.Text type={cache.complete ? 'success' : 'tertiary'} size="small" style={{ display: 'block' }}>
          {cache.complete ? '缓存字段与输入 Token 对齐' : '上游缓存字段可能不完整，未计算严格命中率'}
        </Typography.Text>
      )}
    </div>
  )
}

export default function UsageDetailSheet({ row, admin = false, onClose }) {
  const copyValue = (value) => navigator.clipboard.writeText(value)
    .then(() => Toast.success('已复制'))
    .catch(() => Toast.error('复制失败'))

  const identityData = [
    { key: '请求 ID', value: <CopyableValue value={row?.request_id} onCopy={copyValue} /> },
    { key: '父请求 ID', value: <CopyableValue value={row?.parent_request_id} onCopy={copyValue} /> },
    { key: '会话 ID', value: <CopyableValue value={row?.session_id} onCopy={copyValue} /> },
    { key: '客户端请求 ID', value: <CopyableValue value={row?.client_request_id} onCopy={copyValue} /> },
  ]

  const flowData = [
    { key: '请求时间', value: formatTime(row?.created_at) },
    { key: '请求用途', value: row?.request_purpose ? <Tag color={REQUEST_PURPOSE_META[row.request_purpose.code]?.color || 'grey'}>{REQUEST_PURPOSE_META[row.request_purpose.code]?.label || row.request_purpose.label}</Tag> : '普通模型请求' },
    { key: '会话步骤', value: row?.step_index == null ? '—' : `第 ${formatNumber(row.step_index)} 步` },
    { key: '重试序号', value: row?.retry_index == null ? '—' : `第 ${formatNumber(row.retry_index)} 次重试` },
    { key: '尝试次数', value: numberOrDash(row?.attempt_count) },
    { key: '是否切换账号', value: row?.fallback_used ? '是' : '否' },
  ]

  const tokenData = [
    { key: '输入 Token', value: tokenOrDash(row?.prompt_tokens) },
    { key: '输出 Token', value: tokenOrDash(row?.completion_tokens) },
    { key: '合计 Token', value: tokenOrDash(row?.total_tokens) },
  ]

  const contextData = [
    { key: '估算上下文 Token', value: tokenOrDash(row?.context_tokens_estimate) },
    { key: '上下文字节数', value: bytesOrDash(row?.context_bytes) },
    { key: '消息数', value: numberOrDash(row?.message_count) },
    { key: '工具数', value: numberOrDash(row?.tool_count) },
    { key: '图片数', value: numberOrDash(row?.image_count) },
    { key: '工具结果字节数', value: bytesOrDash(row?.tool_result_bytes) },
    { key: '最大消息字节数', value: bytesOrDash(row?.largest_message_bytes) },
  ]

  const resultData = [
    { key: '耗时', value: row?.latency_ms == null ? '—' : `${formatNumber(row.latency_ms)} ms` },
    { key: '状态', value: <StatusValue row={row || {}} /> },
    { key: 'HTTP 状态', value: numberOrDash(row?.http_status) },
    { key: '错误详情', value: row?.error_summary || '—' },
  ]

  const platformData = admin ? [
    { key: '用户', value: valueOrDash(row?.username || (row?.user_id ? `用户 #${row.user_id}` : null)) },
    { key: '请求模型', value: valueOrDash(row?.model) },
    { key: '实际模型', value: valueOrDash(row?.upstream_model) },
    { key: '客户端协议', value: PROTOCOL_LABELS[row?.inbound_protocol] || valueOrDash(row?.inbound_protocol) },
    { key: '上游接口', value: PROTOCOL_LABELS[row?.upstream_protocol] || valueOrDash(row?.upstream_protocol) },
    { key: '路由', value: valueOrDash(row?.route_name || (row?.route_id ? `路由 #${row.route_id}` : null)) },
    { key: '服务账号', value: valueOrDash(row?.credential_name || (row?.credential_id ? `账号 #${row.credential_id}` : null)) },
    { key: '内部服务画像', value: PROVIDER_LABELS[row?.provider] || valueOrDash(row?.provider) },
    { key: '用户令牌', value: valueOrDash(row?.pat_name) },
    { key: '令牌类型', value: valueOrDash(row?.pat_token_type) },
  ] : null

  return (
    <SideSheet
      title={<div className="usage-detail-sheet__title"><span className="usage-detail-sheet__title-dot" />请求详情</div>}
      visible={!!row}
      onCancel={onClose}
      size="medium"
      bodyStyle={{ padding: '8px 24px 24px' }}
    >
      {row && (
        <div className="usage-detail-sheet">
          <div className="usage-detail-hero">
            <div className="usage-detail-hero__main">
              <div className="usage-detail-hero__mark">{admin ? '运' : '我'}</div>
              <div className="usage-detail-hero__heading">
                <Typography.Text type="tertiary" size="small">{admin ? '管理员调用记录' : '个人调用记录'}</Typography.Text>
                <Typography.Title heading={5} className="usage-detail-hero__model">{row.model || '未记录模型'}</Typography.Title>
                <div className="usage-detail-hero__meta">
                  <StatusValue row={row} />
                  <Typography.Text type="tertiary" size="small">{formatTime(row.created_at)}</Typography.Text>
                  <Typography.Text type="tertiary" size="small">{row.request_id ? `${row.request_id.slice(0, 10)}…` : '未生成请求 ID'}</Typography.Text>
                </div>
              </div>
            </div>
            <div className="usage-detail-metrics">
              <DetailMetric label="合计 Token" value={tokenOrDash(row.total_tokens)} hint={`入 ${tokenOrDash(row.prompt_tokens)} / 出 ${tokenOrDash(row.completion_tokens)}`} />
              <DetailMetric label="上下文规模" value={tokenOrDash(row.context_tokens_estimate)} hint={`${numberOrDash(row.message_count)} 条消息`} />
              <DetailMetric label="耗时" value={row.latency_ms == null ? '—' : `${formatNumber(row.latency_ms)} ms`} hint={row.fallback_used ? `切换 ${numberOrDash(row.attempt_count)} 次` : '未切换账号'} />
            </div>
          </div>
          {platformData && <DetailSection title="调用链" data={platformData} />}
          <DetailSection title="请求标识" data={identityData} />
          <DetailSection title="调用过程" data={flowData} />
          <DetailSection title="Token 用量" data={tokenData} />
          <DetailSection title="上下文规模" data={contextData} />
          <DetailSection title="缓存" data={[{ key: '缓存状态', value: <CacheValue row={row} /> }]} />
          <DetailSection title="性能与结果" data={resultData} />
        </div>
      )}
    </SideSheet>
  )
}
