import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { useSearchParams } from 'react-router-dom'
import {
  Banner, Button, Input, InputNumber, Progress, Select, Space, Table, TabPane, Tabs, Tag, Toast, Typography,
} from '@douyinfe/semi-ui'
import { IconAlertTriangle, IconBolt, IconHistogram, IconLayers, IconRefresh } from '@douyinfe/semi-icons'
import { getUsageAnalytics, listQuotas, listUsage, updateQuota } from '@/modules/agent/api/usage'
import { AgentPage, AgentStatCards } from '@/modules/agent/components/AgentPage'
import UsageDetailSheet from '@/modules/agent/components/UsageDetailSheet'
import { UsageAnalyticsCard, UsageRanking } from '@/modules/agent/components/UsageAnalytics'
import {
  formatCompactNumber, formatNumber, formatTime, formatTokenCount,
  buildUsageQuery, getUsageCacheInfo, buildModelRankRows, buildUserRankRows,
  USAGE_PERIOD_LABELS, USAGE_PERIOD_OPTIONS,
} from '@/modules/agent/utils'
import './usage-page.css'

const EMPTY_SUMMARY = {
  requests: 0, prompt_tokens: 0, completion_tokens: 0, tokens: 0,
  errors: 0, success_rate: 0, avg_latency_ms: 0, p95_latency_ms: 0, active_models: 0,
}
const EMPTY_ANALYTICS = {
  summary: EMPTY_SUMMARY, trend: [], users: [],
  models: { items: [], tokens: 0 },
  filter_options: { users: [], models: [] },
  daily_quota_per_user: null,
}
const PROVIDER_LABELS = {
  deepseek: 'DeepSeek', openai: 'OpenAI', 'openai-compatible': 'OpenAI 兼容',
  custom: '自定义兼容', environment: '环境变量',
}
const PROTOCOL_LABELS = {
  'openai-chat': 'OpenAI Chat Completions',
  'anthropic-messages': 'Anthropic Messages',
  'openai-responses': 'OpenAI Responses',
}
const STATUS_META = {
  ok: { label: '成功', color: 'green' },
  upstream_error: { label: '上游错误', color: 'red' },
  stream_error: { label: '流式中断', color: 'orange' },
  client_error: { label: '客户端中断', color: 'amber' },
  routing_error: { label: '没有可用账号', color: 'violet' },
  protocol_error: { label: '协议不兼容', color: 'violet' },
  quota_exceeded: { label: '超过配额', color: 'grey' },
}
const shortTraceId = (value) => (value?.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : (value || '—'))
const REQUEST_TABLE_SCROLL = { x: 1800 }

export default function AgentUsagePage() {
  const [searchParams] = useSearchParams()
  const [activeTab, setActiveTab] = useState('requests')
  // 运维看板的模型排行通过 ?model= 深链进来，首屏就要带上该筛选。
  const [filters, setFilters] = useState(() => ({
    days: 7, user_id: '', status: '', model: searchParams.get('model') || '',
  }))
  const [page, setPage] = useState(1)
  const [listData, setListData] = useState({ items: [], total: 0 })
  const [analytics, setAnalytics] = useState(EMPTY_ANALYTICS)
  const [listLoading, setListLoading] = useState(true)
  const [analyticsLoading, setAnalyticsLoading] = useState(true)
  const [quotaData, setQuotaData] = useState({ items: [], total: 0, default_daily_quota: null })
  const [quotaQuery, setQuotaQuery] = useState({ page: 1, per_page: 10, search: '' })
  const [quotaDrafts, setQuotaDrafts] = useState({})
  const [quotaLoading, setQuotaLoading] = useState(false)
  const [savingQuotaId, setSavingQuotaId] = useState(null)
  const [selectedDetail, setSelectedDetail] = useState(null)

  const loadList = useCallback(() => {
    setListLoading(true)
    return listUsage(buildUsageQuery({ filters, page, per_page: 20 }))
      .then(setListData)
      .catch((error) => Toast.error(error?.error || '加载请求记录失败'))
      .finally(() => setListLoading(false))
  }, [filters, page])

  const loadAnalytics = useCallback(() => {
    setAnalyticsLoading(true)
    return getUsageAnalytics(buildUsageQuery({ filters }))
      .then((data) => {
        setAnalytics(data)
        // 时间范围收窄后，之前选中的用户 / 模型可能已经没有数据。
        // 这里在事件回调里收敛筛选条件，而不是放到 effect 里再 setState。
        const options = data?.filter_options || {}
        const dropped = {}
        if (filters.user_id && !(options.users || []).some((item) => item.value === filters.user_id)) dropped.user_id = ''
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

  const loadQuotas = useCallback(() => {
    setQuotaLoading(true)
    return listQuotas(quotaQuery)
      .then(setQuotaData)
      .catch((error) => Toast.error(error?.error || '加载用户配额失败'))
      .finally(() => setQuotaLoading(false))
  }, [quotaQuery])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => { loadAnalytics() }, [loadAnalytics])
  useEffect(() => { if (activeTab === 'quotas') loadQuotas() }, [activeTab, loadQuotas])

  const setFilter = (name, value) => {
    setPage(1)
    setFilters((current) => ({ ...current, [name]: value }))
  }

  const saveQuota = (row) => {
    const hasDraft = Object.prototype.hasOwnProperty.call(quotaDrafts, row.user_id)
    const value = hasDraft ? quotaDrafts[row.user_id] : row.daily_token_quota
    setSavingQuotaId(row.user_id)
    updateQuota(row.user_id, { daily_token_quota: value ?? null })
      .then(() => {
        Toast.success('配额已更新')
        setQuotaDrafts((current) => { const next = { ...current }; delete next[row.user_id]; return next })
        return loadQuotas()
      })
      .catch((error) => Toast.error(error?.error || '更新配额失败'))
      .finally(() => setSavingQuotaId(null))
  }

  const summary = analytics.summary || EMPTY_SUMMARY
  const users = analytics.filter_options?.users || []
  const modelOptions = analytics.filter_options?.models || []
  const modelBreakdown = analytics.models || EMPTY_ANALYTICS.models
  const modelRows = modelBreakdown.items || []
  const modelTokens = Number(modelBreakdown.tokens || 0)
  // 排行榜只展示 Top 5，保持三张卡同一行高度；完整数值与占比放在 tooltip。
  const modelRankRows = buildModelRankRows(modelRows)
  const userRankRows = buildUserRankRows(analytics.users, summary.tokens)
  const periodLabel = USAGE_PERIOD_LABELS[filters.days] || `近 ${filters.days} 天`
  const activeUserLabel = users.find((item) => item.value === filters.user_id)?.label
  const scopeParts = [
    periodLabel,
    activeUserLabel ? `用户：${activeUserLabel}` : null,
    filters.model ? `模型：${filters.model}` : null,
    filters.status ? (STATUS_META[filters.status]?.label || filters.status) : null,
  ].filter(Boolean)
  const scopeHint = scopeParts.length ? `下列统计、图表与列表：${scopeParts.join(' · ')}` : null
  const trendOption = useMemo(() => ({
    animationDuration: 250,
    color: ['#2563eb', '#10b981', '#ef4444'],
    tooltip: { trigger: 'axis' },
    legend: {
      top: 0,
      right: 0,
      icon: 'roundRect',
      itemWidth: 14,
      itemHeight: 8,
      itemGap: 16,
      textStyle: { color: '#64748b' },
    },
    grid: { left: 12, right: 18, top: 38, bottom: 4, containLabel: true },
    xAxis: {
      type: 'category', boundaryGap: false,
      data: analytics.trend.map((item) => item.bucket.slice(filters.days === 1 ? 11 : 5, filters.days === 1 ? 16 : 10)),
      axisLine: { lineStyle: { color: '#e5e7eb' } }, axisLabel: { color: '#94a3b8' },
    },
    yAxis: [
      { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: '#f1f5f9' } }, axisLabel: { color: '#94a3b8' } },
      { type: 'value', splitLine: { show: false }, axisLabel: { color: '#94a3b8', formatter: formatCompactNumber } },
    ],
    series: [
      { name: '请求数', type: 'line', smooth: true, symbolSize: 5, areaStyle: { opacity: 0.08 }, data: analytics.trend.map((item) => item.requests) },
      { name: '计费 Token', type: 'line', smooth: true, symbol: 'none', yAxisIndex: 1, data: analytics.trend.map((item) => item.tokens) },
      { name: '异常', type: 'bar', barMaxWidth: 8, data: analytics.trend.map((item) => item.errors) },
    ],
  }), [analytics.trend, filters.days])

  const requestColumns = [
    { title: '时间', dataIndex: 'created_at', width: 165, render: formatTime },
    {
      title: '用户', width: 140,
      render: (_, row) => <Typography.Text ellipsis={{ showTooltip: true }}>{row.username || (row.user_id ? `用户 #${row.user_id}` : '—')}</Typography.Text>,
    },
    {
      title: '会话/步骤', width: 170,
      render: (_, row) => <div><div>{row.session_id ? shortTraceId(row.session_id) : '未上报会话 ID'}</div><Typography.Text type="tertiary" size="small">{row.step_index == null ? '步骤 —' : `步骤 ${row.step_index}`}</Typography.Text></div>,
    },
    {
      title: '模型', width: 210,
      render: (_, row) => <div>{row.model || '—'}</div>,
    },
    {
      title: '调用账号', width: 180,
      render: (_, row) => <div><div>{row.credential_name || (row.credential_id ? `账号 #${row.credential_id}` : '未记录')}</div><Typography.Text type="tertiary" size="small">{PROTOCOL_LABELS[row.upstream_protocol] || PROVIDER_LABELS[row.provider] || row.provider || '—'}</Typography.Text></div>,
    },
    {
      title: 'Token', width: 130,
      render: (_, row) => <div><Typography.Text strong>{formatTokenCount(row.total_tokens)}</Typography.Text><Typography.Text type="tertiary" size="small" style={{ display: 'block' }}>入 {formatTokenCount(row.prompt_tokens)} / 出 {formatTokenCount(row.completion_tokens)}</Typography.Text></div>,
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
      render: (_, row) => <div><div>{row.latency_ms == null ? '—' : `${formatNumber(row.latency_ms)} ms`}</div>{row.fallback_used && <Typography.Text type="tertiary" size="small">切换 {row.attempt_count} 次</Typography.Text>}</div>,
    },
    {
      title: '状态', dataIndex: 'status', minWidth: 180,
      render: (value) => { const meta = STATUS_META[value] || { label: value, color: 'grey' }; return <Tag color={meta.color}>{meta.label}</Tag> },
    },
    {
      title: '详情', width: 76, fixed: 'right',
      render: (_, row) => <Button theme="borderless" type="primary" onClick={() => setSelectedDetail(row)}>查看</Button>,
    },
  ]

  const quotaColumns = [
    { title: '用户', width: 150, dataIndex: 'username' },
    {
      title: '今日使用', width: 210,
      render: (_, row) => <div><div>{formatTokenCount(row.used_today)} Token</div>{row.effective_quota ? <Progress className="usage-quota-progress" percent={Math.min(100, Math.max(0, Number(row.usage_percent || 0)))} showInfo={false} size="small" aria-label={`${row.username} 今日配额使用率`} /> : <Typography.Text type="tertiary" size="small">不限制</Typography.Text>}</div>,
    },
    {
      title: '当前上限', width: 160,
      render: (_, row) => <div><div>{row.effective_quota ? formatTokenCount(row.effective_quota) : '不限制'}</div><Typography.Text type="tertiary" size="small">{row.quota_source === 'user' ? '单独设置' : '使用系统默认'}</Typography.Text></div>,
    },
    {
      title: '单独设置', width: 280,
      render: (_, row) => {
        const hasDraft = Object.prototype.hasOwnProperty.call(quotaDrafts, row.user_id)
        const value = hasDraft ? quotaDrafts[row.user_id] : row.daily_token_quota
        return <Space spacing={8}>
          <InputNumber
            value={value == null ? undefined : value}
            placeholder="留空使用默认"
            min={0}
            max={1000000000}
            onChange={(next) => setQuotaDrafts((current) => ({ ...current, [row.user_id]: next === '' || next == null ? null : Number(next) }))}
            style={{ width: 160 }}
          />
          <Button loading={savingQuotaId === row.user_id} onClick={() => saveQuota(row)}>保存</Button>
        </Space>
      },
    },
  ]

  const requestFilters = <>
    {scopeHint && (
      <Typography.Text type="tertiary" size="small" className="usage-filter-scope">{scopeHint}</Typography.Text>
    )}
    <Select value={filters.days} onChange={(value) => setFilter('days', value)} style={{ width: 130 }} optionList={USAGE_PERIOD_OPTIONS} />
    <Select value={filters.user_id} onChange={(value) => setFilter('user_id', value)} placeholder="全部用户" showClear filter style={{ width: 170 }} optionList={users} />
    <Select value={filters.model} onChange={(value) => setFilter('model', value)} placeholder="全部模型" showClear filter style={{ width: 210 }} optionList={modelOptions} />
    <Select value={filters.status} onChange={(value) => setFilter('status', value)} placeholder="全部状态" showClear style={{ width: 150 }} optionList={Object.entries(STATUS_META).map(([value, meta]) => ({ value, label: meta.label }))} />
  </>

  return <AgentPage
    title="用量配额"
    description="查看模型请求、异常和用户每日额度。系统不会保存提示词或模型回复。"
    actions={<Button icon={<IconRefresh />} loading={activeTab === 'requests' ? listLoading || analyticsLoading : quotaLoading} onClick={() => activeTab === 'requests' ? Promise.all([loadList(), loadAnalytics()]) : loadQuotas()}>刷新</Button>}
    stats={activeTab === 'requests' ? <AgentStatCards items={[
      { label: `${periodLabel} Token`, value: formatTokenCount(summary.tokens), hint: `计费 Token · 入 ${formatTokenCount(summary.prompt_tokens)} / 出 ${formatTokenCount(summary.completion_tokens)}`, tone: 'purple', icon: <IconBolt /> },
      { label: `${periodLabel} 请求`, value: formatNumber(summary.requests), hint: `成功率 ${summary.requests ? `${summary.success_rate}%` : '—'}`, tone: 'green', icon: <IconHistogram /> },
      { label: `${periodLabel} 活跃模型`, value: formatNumber(summary.active_models), hint: modelTokens ? `全部模型合计 ${formatTokenCount(modelTokens)} 计费 Token` : '尚无模型上报请求', tone: 'blue', icon: <IconLayers /> },
      { label: `${periodLabel} 异常`, value: formatNumber(summary.errors), hint: `平均 ${formatNumber(summary.avg_latency_ms)} ms · 多数 ${formatNumber(summary.p95_latency_ms)} ms`, tone: summary.errors ? 'orange' : 'green', icon: <IconAlertTriangle /> },
    ]} /> : null}
    filters={activeTab === 'requests' ? requestFilters : null}
    insights={activeTab === 'requests' ? <div className="usage-analytics-grid usage-analytics-grid--trio">
      <UsageAnalyticsCard title="调用趋势" empty={!analytics.trend.length}>
        <ReactECharts option={trendOption} style={{ height: 236 }} notMerge lazyUpdate />
      </UsageAnalyticsCard>
      <UsageAnalyticsCard
        title="模型消耗"
        extra={filters.model ? `已筛选 ${filters.model}` : '点击下钻'}
        empty={!modelRankRows.length}
      >
        <UsageRanking
          rows={modelRankRows}
          activeValue={filters.model}
          onSelect={(value) => setFilter('model', value)}
        />
      </UsageAnalyticsCard>
      <UsageAnalyticsCard
        title="用户消耗"
        extra={filters.user_id ? '已筛选用户' : '点击下钻'}
        empty={!userRankRows.length}
      >
        <UsageRanking
          rows={userRankRows}
          activeValue={filters.user_id}
          onSelect={(value) => setFilter('user_id', value)}
        />
      </UsageAnalyticsCard>
    </div> : null}
    contentTitle=""
  >
    <Tabs type="line" activeKey={activeTab} onChange={setActiveTab}>
      <TabPane tab="请求记录" itemKey="requests">
        <Table
          className="usage-data-table"
          columns={requestColumns}
          dataSource={listData.items}
          rowKey="id"
          loading={listLoading}
          onRow={(row) => ({
            className: 'usage-data-table__clickable-row',
            onClick: (event) => {
              if (event.target instanceof Element && event.target.closest('button, a, input, [role="checkbox"]')) return
              setSelectedDetail(row)
            },
          })}
          scroll={REQUEST_TABLE_SCROLL}
          pagination={{ currentPage: page, pageSize: 20, total: listData.total, onPageChange: (next) => setPage(next) }}
        />
      </TabPane>
      <TabPane tab="用户配额" itemKey="quotas">
        <Banner
          className="usage-quota-tip"
          type="info"
          fullMode={false}
          icon={null}
          description={<div className="usage-quota-tip__content">
            <span>系统默认：{quotaData.default_daily_quota ? `${formatTokenCount(quotaData.default_daily_quota)} Token / 人 / 日` : '不限制'}</span>
            <Typography.Text type="tertiary" size="small">留空使用系统默认，填写 0 表示不限制。</Typography.Text>
          </div>}
        />
        <Input
          placeholder="搜索用户"
          value={quotaQuery.search}
          onChange={(search) => setQuotaQuery((current) => ({ ...current, search, page: 1 }))}
          showClear
          style={{ width: 240, marginBottom: 12 }}
        />
        <Table
          className="usage-data-table"
          columns={quotaColumns}
          dataSource={quotaData.items}
          rowKey="user_id"
          loading={quotaLoading}
          pagination={{ currentPage: quotaQuery.page, pageSize: quotaQuery.per_page, total: quotaData.total, onPageChange: (next) => setQuotaQuery((current) => ({ ...current, page: next })) }}
        />
      </TabPane>
    </Tabs>
    <UsageDetailSheet row={selectedDetail} admin onClose={() => setSelectedDetail(null)} />
  </AgentPage>
}
