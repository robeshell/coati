import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { useSearchParams } from 'react-router-dom'
import { Button, Select, Table, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import { IconAlertTriangle, IconBolt, IconDownload, IconHistogram, IconRefresh } from '@douyinfe/semi-icons'
import { useAuth } from '@/context/AuthContext'
import { exportMyUsage, getMyUsageAnalytics, listMyUsage } from '@/modules/agent/api/usage'
import { AgentPage, AgentStatCards } from '@/modules/agent/components/AgentPage'
import UsageDetailSheet from '@/modules/agent/components/UsageDetailSheet'
import { UsageAnalyticsCard, UsageRanking } from '@/modules/agent/components/UsageAnalytics'
import {
  formatCompactNumber, formatNumber, formatTime, formatTokenCount,
  buildUsageQuery, getUsageCacheInfo, buildModelRankRows,
  USAGE_PERIOD_LABELS, USAGE_PERIOD_OPTIONS,
} from '@/modules/agent/utils'
import ExportFieldsModal from '@/shared/components/import-export/ExportFieldsModal'
import { downloadBlobFile } from '@/shared/utils/file'
import '../usage_page/usage-page.css'

const EMPTY_SUMMARY = {
  requests: 0, prompt_tokens: 0, completion_tokens: 0, tokens: 0,
  errors: 0, success_rate: 0, avg_latency_ms: 0, p95_latency_ms: 0,
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
const EXPORT_FIELDS = [
  { label: '时间', value: 'created_at' },
  { label: '请求 ID', value: 'request_id' },
  { label: '父请求 ID', value: 'parent_request_id' },
  { label: '会话 ID', value: 'session_id' },
  { label: '客户端请求 ID', value: 'client_request_id' },
  { label: '请求用途', value: 'request_purpose' },
  { label: '步骤序号', value: 'step_index' },
  { label: '重试序号', value: 'retry_index' },
  { label: '模型', value: 'model' },
  { label: '输入 Token', value: 'prompt_tokens' },
  { label: '输出 Token', value: 'completion_tokens' },
  { label: '合计 Token', value: 'total_tokens' },
  { label: '估算上下文 Token', value: 'context_tokens_estimate' },
  { label: '上下文字节数', value: 'context_bytes' },
  { label: '消息数', value: 'message_count' },
  { label: '工具数', value: 'tool_count' },
  { label: '图片数', value: 'image_count' },
  { label: '工具结果字节数', value: 'tool_result_bytes' },
  { label: '最大消息字节数', value: 'largest_message_bytes' },
  { label: '缓存读取 Token', value: 'cache_read_tokens' },
  { label: '缓存写入 Token', value: 'cache_write_tokens' },
  { label: '缓存未命中 Token', value: 'cache_miss_tokens' },
  { label: '耗时(ms)', value: 'latency_ms' },
  { label: '状态', value: 'status' },
  { label: '错误摘要', value: 'error_summary' },
  { label: '是否换号', value: 'fallback_used' },
  { label: '尝试次数', value: 'attempt_count' },
]

const normalizeFileType = (raw) => (['csv', 'xls', 'xlsx'].includes(raw) ? raw : 'xlsx')
const shortTraceId = (value) => (value?.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : (value || '—'))
const USAGE_TABLE_SCROLL = { x: 1650 }

export default function MyUsagePage() {
  const { hasPermission } = useAuth()
  const canExport = hasPermission('agent_my_usage_export')
  const [searchParams] = useSearchParams()
  // 个人看板的模型排行通过 ?model= 深链进来，首屏就要带上该筛选。
  const [filters, setFilters] = useState(() => ({
    days: 7, status: '', pat_id: '', model: searchParams.get('model') || '',
  }))
  const [page, setPage] = useState(1)
  const [listData, setListData] = useState({ items: [], total: 0 })
  const [analytics, setAnalytics] = useState({
    summary: EMPTY_SUMMARY, trend: [], models: { items: [], tokens: 0 }, quota: null,
  })
  const [listLoading, setListLoading] = useState(true)
  const [analyticsLoading, setAnalyticsLoading] = useState(true)
  const [selectedRowKeys, setSelectedRowKeys] = useState([])
  const [exportVisible, setExportVisible] = useState(false)
  const [selectedDetail, setSelectedDetail] = useState(null)

  const loadList = useCallback(() => {
    setListLoading(true)
    return listMyUsage(buildUsageQuery({ filters, page, per_page: 20 }))
      .then((data) => {
        setListData(data)
        setSelectedRowKeys([])
      })
      .catch((error) => Toast.error(error?.error || '加载使用日志失败'))
      .finally(() => setListLoading(false))
  }, [filters, page])

  const loadAnalytics = useCallback(() => {
    setAnalyticsLoading(true)
    return getMyUsageAnalytics(buildUsageQuery({ filters }))
      .then((data) => {
        setAnalytics(data)
        // 时间范围收窄后，之前选的令牌 / 模型可能已经没有数据；
        // 在事件回调里收敛筛选条件，而不是放到 effect 里再 setState。
        const options = data?.filter_options || {}
        const dropped = {}
        if (filters.pat_id && !(options.pats || []).some((item) => item.value === filters.pat_id)) dropped.pat_id = ''
        if (filters.model && !(options.models || []).some((item) => item.value === filters.model)) dropped.model = ''
        if (Object.keys(dropped).length) {
          setPage(1)
          setFilters((current) => ({ ...current, ...dropped }))
        }
        return data
      })
      .catch((error) => Toast.error(error?.error || '加载用量概览失败'))
      .finally(() => setAnalyticsLoading(false))
  }, [filters])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => { loadAnalytics() }, [loadAnalytics])

  const setFilter = (name, value) => {
    setPage(1)
    setFilters((current) => ({ ...current, [name]: value }))
  }

  const handleExport = ({ fields, fileType }) => {
    const finalFileType = normalizeFileType(fileType)
    const hasSelected = selectedRowKeys.length > 0
    const payload = {
      fields,
      file_type: finalFileType,
      export_mode: hasSelected ? 'selected' : 'filtered',
    }
    if (hasSelected) payload.ids = selectedRowKeys
    else payload.filters = { days: filters.days, status: filters.status, pat_id: filters.pat_id, model: filters.model }
    return exportMyUsage(payload)
      .then((blob) => {
        downloadBlobFile(blob, `my_usage_export.${finalFileType}`)
        setExportVisible(false)
        Toast.success('导出成功')
      })
      .catch((error) => {
        Toast.error(error?.error || '导出失败')
        throw error
      })
  }

  const summary = analytics.summary || EMPTY_SUMMARY
  const quota = analytics.quota || {}
  const periodLabel = USAGE_PERIOD_LABELS[filters.days] || `近 ${filters.days} 天`
  const patOptions = analytics.filter_options?.pats || []
  const modelOptions = analytics.filter_options?.models || []
  const modelRankRows = buildModelRankRows(analytics.models?.items, 5)
  const activePatLabel = patOptions.find((item) => item.value === filters.pat_id)?.label
  const scopeParts = [
    periodLabel,
    activePatLabel ? `令牌：${activePatLabel}` : null,
    filters.model ? `模型：${filters.model}` : null,
    filters.status ? (STATUS_META[filters.status]?.label || filters.status) : null,
  ].filter(Boolean)
  const scopeHint = scopeParts.length ? `下列统计、图表与列表：${scopeParts.join(' · ')}` : null
  const trendOption = useMemo(() => ({
    animationDuration: 250,
    color: ['#2563eb', '#10b981', '#ef4444'],
    tooltip: { trigger: 'axis' },
    legend: {
      top: 0, right: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 8, itemGap: 16,
      textStyle: { color: '#64748b' },
    },
    grid: { left: 12, right: 18, top: 38, bottom: 4, containLabel: true },
    xAxis: {
      type: 'category', boundaryGap: false,
      data: (analytics.trend || []).map((item) => item.bucket.slice(filters.days === 1 ? 11 : 5, filters.days === 1 ? 16 : 10)),
      axisLine: { lineStyle: { color: '#e5e7eb' } }, axisLabel: { color: '#94a3b8' },
    },
    yAxis: [
      { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#f1f5f9' } }, axisLabel: { color: '#94a3b8' } },
      { type: 'value', splitLine: { show: false }, axisLabel: { color: '#94a3b8', formatter: formatCompactNumber } },
    ],
    series: [
      { name: '请求数', type: 'line', smooth: true, symbolSize: 5, areaStyle: { opacity: 0.08 }, data: (analytics.trend || []).map((item) => item.requests) },
      { name: '计费 Token', type: 'line', smooth: true, symbol: 'none', yAxisIndex: 1, data: (analytics.trend || []).map((item) => item.tokens) },
      { name: '异常', type: 'bar', barMaxWidth: 8, data: (analytics.trend || []).map((item) => item.errors) },
    ],
  }), [analytics.trend, filters.days])

  const columns = [
    { title: '时间', dataIndex: 'created_at', width: 165, render: formatTime },
    {
      title: '会话/步骤', width: 170,
      render: (_, row) => <div><div>{row.session_id ? shortTraceId(row.session_id) : '未上报会话 ID'}</div><Typography.Text type="tertiary" size="small">{row.step_index == null ? '步骤 —' : `步骤 ${row.step_index}`}</Typography.Text></div>,
    },
    {
      title: '令牌', width: 160,
      render: (_, row) => (
        <div>
          <div>{row.pat_name || '—'}</div>
          {row.pat_token_type === 'device' && (
            <Typography.Text type="tertiary" size="small">设备</Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: '模型', width: 220,
      render: (_, row) => (
        <div>
          <div>{row.model || '—'}</div>
        </div>
      ),
    },
    {
      title: 'Token', width: 140,
      render: (_, row) => (
        <div>
          <Typography.Text strong>{formatTokenCount(row.total_tokens)}</Typography.Text>
          <Typography.Text type="tertiary" size="small" style={{ display: 'block' }}>
            入 {formatTokenCount(row.prompt_tokens)} / 出 {formatTokenCount(row.completion_tokens)}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: '上下文特征', width: 220,
      render: (_, row) => <div><div>估算 {formatTokenCount(row.context_tokens_estimate)} Token</div><Typography.Text type="tertiary" size="small">{row.message_count} 消息 · {row.tool_count} 工具 · {row.image_count} 图片</Typography.Text>{row.tool_result_bytes > 0 && <Typography.Text type="tertiary" size="small" style={{ display: 'block' }}>工具结果 {formatNumber(row.tool_result_bytes)} B</Typography.Text>}</div>,
    },
    {
      title: '缓存', width: 150,
      render: (_, row) => {
        const cache = getUsageCacheInfo(row)
        return (
          <div>
            <div>{cache.hasAny ? (cache.hitRate === null ? '缓存命中 —' : `缓存命中 ${cache.hitRate}%`) : '缓存未上报'}</div>
            <Typography.Text type="tertiary" size="small">
              输入 {formatTokenCount(row.prompt_tokens)} tok · 输出 {formatTokenCount(row.completion_tokens)} tok
            </Typography.Text>
          </div>
        )
      },
    },
    {
      title: '耗时', width: 130,
      render: (_, row) => (
        <div>
          <div>{row.latency_ms == null ? '—' : `${formatNumber(row.latency_ms)} ms`}</div>
          {row.fallback_used && <Typography.Text type="tertiary" size="small">切换 {row.attempt_count} 次</Typography.Text>}
        </div>
      ),
    },
    {
      title: '状态', dataIndex: 'status', minWidth: 180,
      render: (value) => {
        const meta = STATUS_META[value] || { label: value, color: 'grey' }
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    {
      title: '详情', width: 76, fixed: 'right',
      render: (_, row) => <Button theme="borderless" type="primary" onClick={() => setSelectedDetail(row)}>查看</Button>,
    },
  ]

  return (
    <AgentPage
      title="使用日志"
      description="只显示你自己的用量与请求状态，不展示平台内部账号和路由。系统不会保存提示词或模型回复。"
      actions={(
        <>
          {canExport && <Button icon={<IconDownload />} onClick={() => setExportVisible(true)}>导出</Button>}
          <Button icon={<IconRefresh />} loading={listLoading || analyticsLoading} onClick={() => Promise.all([loadList(), loadAnalytics()])}>刷新</Button>
        </>
      )}
      stats={<AgentStatCards items={[
        {
          label: '今日已用',
          value: formatTokenCount(quota.used_today),
          hint: quota.daily_quota
            ? `剩余 ${formatTokenCount(quota.remaining)} / ${formatTokenCount(quota.daily_quota)} · 不受下列筛选影响`
            : '当日全部令牌 · 不受下列筛选影响',
          tone: quota.exhausted ? 'orange' : 'green',
          icon: <IconBolt />,
        },
        {
          label: `${periodLabel} Token`,
          value: formatTokenCount(summary.tokens),
          hint: `计费 Token · 入 ${formatTokenCount(summary.prompt_tokens)} / 出 ${formatTokenCount(summary.completion_tokens)}`,
          tone: 'purple',
          icon: <IconBolt />,
        },
        {
          label: `${periodLabel} 请求`,
          value: formatNumber(summary.requests),
          hint: `成功率 ${summary.requests ? `${summary.success_rate}%` : '—'}`,
          tone: 'green',
          icon: <IconHistogram />,
        },
        {
          label: `${periodLabel} 异常`,
          value: formatNumber(summary.errors),
          hint: `平均 ${formatNumber(summary.avg_latency_ms)} ms · 多数 ${formatNumber(summary.p95_latency_ms)} ms`,
          tone: summary.errors ? 'orange' : 'green',
          icon: <IconAlertTriangle />,
        },
      ]} />}
      filters={(
        <>
          {scopeHint && (
            <Typography.Text type="tertiary" size="small" className="usage-filter-scope">{scopeHint}</Typography.Text>
          )}
          <Select
            value={filters.days}
            onChange={(value) => setFilter('days', value)}
            style={{ width: 130 }}
            optionList={USAGE_PERIOD_OPTIONS}
          />
          <Select
            value={filters.pat_id}
            onChange={(value) => setFilter('pat_id', value)}
            placeholder="全部令牌"
            showClear
            filter
            style={{ width: 200 }}
            optionList={patOptions}
          />
          <Select
            value={filters.model}
            onChange={(value) => setFilter('model', value)}
            placeholder="全部模型"
            showClear
            filter
            style={{ width: 210 }}
            optionList={modelOptions}
          />
          <Select
            value={filters.status}
            onChange={(value) => setFilter('status', value)}
            placeholder="全部状态"
            showClear
            style={{ width: 150 }}
            optionList={Object.entries(STATUS_META).map(([value, meta]) => ({ value, label: meta.label }))}
          />
        </>
      )}
      insights={(analytics.trend?.length || modelRankRows.length) ? (
        <div className="usage-analytics-grid usage-analytics-grid--duo">
          <UsageAnalyticsCard title={`我的趋势 · ${periodLabel}`} empty={!analytics.trend?.length} emptyTitle="暂无请求">
            <ReactECharts option={trendOption} style={{ height: 236 }} notMerge lazyUpdate />
          </UsageAnalyticsCard>
          <UsageAnalyticsCard
            title="我的模型消耗"
            extra={filters.model ? `已筛选 ${filters.model}` : '点击下钻'}
            empty={!modelRankRows.length}
            emptyTitle="暂无模型用量"
          >
            <UsageRanking
              rows={modelRankRows}
              activeValue={filters.model}
              onSelect={(value) => setFilter('model', value)}
            />
          </UsageAnalyticsCard>
        </div>
      ) : null}
      contentTitle="我的请求"
    >
      <Table
        className="usage-data-table"
        columns={columns}
        dataSource={listData.items}
        rowKey="id"
        loading={listLoading}
        rowSelection={canExport ? {
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        } : undefined}
        onRow={(row) => ({
          className: 'usage-data-table__clickable-row',
          onClick: (event) => {
            if (event.target instanceof Element && event.target.closest('button, a, input, [role="checkbox"]')) return
            setSelectedDetail(row)
          },
        })}
        scroll={USAGE_TABLE_SCROLL}
        pagination={{ currentPage: page, pageSize: 20, total: listData.total, onPageChange: (next) => setPage(next) }}
      />
      <ExportFieldsModal
        visible={exportVisible}
        title="导出使用日志"
        fieldOptions={EXPORT_FIELDS}
        onCancel={() => setExportVisible(false)}
        onConfirm={handleExport}
      />
      <UsageDetailSheet row={selectedDetail} onClose={() => setSelectedDetail(null)} />
    </AgentPage>
  )
}
