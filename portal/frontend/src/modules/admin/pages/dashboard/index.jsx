import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { useNavigate } from 'react-router-dom'
import { Banner, Button, Empty, Select, Spin, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBolt,
  IconFile,
  IconHistogram,
  IconLink,
  IconRefresh,
  IconTerminal,
  IconTickCircle,
  IconUser,
} from '@douyinfe/semi-icons'
import { useAuth } from '@/context/AuthContext'
import { useTheme } from '@/context/ThemeContext'
import StatCardGroup from '@/shared/components/statistics/StatCardGroup'
import UsageDetailSheet from '@/modules/agent/components/UsageDetailSheet'
import { UsageRanking } from '@/modules/agent/components/UsageAnalytics'
import { getMyUsageAnalytics, listMyUsage } from '@/modules/agent/api/usage'
import {
  formatCompactNumber, formatNumber, formatTime, formatTokenCount,
  getUsageCacheInfo, buildModelRankRows, USAGE_PERIOD_LABELS, USAGE_PERIOD_OPTIONS,
} from '@/modules/agent/utils'
import './dashboard.css'

const { Title } = Typography

const EMPTY_ANALYTICS = {
  summary: {
    requests: 0, tokens: 0, errors: 0, success_rate: 0,
    successful_requests: 0, avg_latency_ms: 0, p95_latency_ms: 0, active_users: 0,
    active_models: 0,
  },
  trend: [], users: [], models: { items: [], tokens: 0 }, daily_quota_per_user: null,
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

function StatusItem({ tone, icon, title, description, action, onClick }) {
  return <button type="button" className={`dashboard-status dashboard-status--${tone}`} onClick={onClick}>
    <span className="dashboard-status__icon">{icon}</span>
    <span className="dashboard-status__copy">
      <strong>{title}</strong>
      <small>{description}</small>
    </span>
    {action && <span className="dashboard-status__action">{action}<IconArrowRight /></span>}
  </button>
}

function formatRelativeTime(value) {
  if (!value) return '暂无请求'
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return formatTime(value)
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < 60 * 1000) return '刚刚'
  if (elapsed < 60 * 60 * 1000) return `${Math.floor(elapsed / (60 * 1000))} 分钟前`
  if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / (60 * 60 * 1000))} 小时前`
  return formatTime(value)
}

export default function Dashboard() {
  const { hasPermission } = useAuth()
  const { isDark } = useTheme()
  const navigate = useNavigate()
  const canViewTokens = hasPermission('agent_pat')
  const canViewMyLogs = hasPermission('agent_my_usage')
  const canViewMyChannels = hasPermission('agent_my_channels')
  const [loading, setLoading] = useState(true)
  const [dashboardPeriod, setDashboardPeriod] = useState(7)
  const [mine, setMine] = useState({ items: [], total: 0 })
  const [myAnalytics, setMyAnalytics] = useState({ ...EMPTY_ANALYTICS, quota: null })
  const [loadState, setLoadState] = useState({ list: 'loading', analytics: 'loading' })
  const [selectedDetail, setSelectedDetail] = useState(null)
  const loadSequence = useRef(0)

  const load = useCallback(() => {
    const sequence = ++loadSequence.current
    setLoading(true)
    setLoadState({ list: 'loading', analytics: 'loading' })
    return Promise.allSettled([
      listMyUsage({ page: 1, per_page: 6, days: dashboardPeriod }),
      getMyUsageAnalytics({ days: dashboardPeriod }),
    ])
      .then(([myUsageResult, myAnalyticsResult]) => {
        if (sequence !== loadSequence.current) return
        if (myUsageResult.status === 'fulfilled') setMine(myUsageResult.value || { items: [], total: 0 })
        if (myAnalyticsResult.status === 'fulfilled') setMyAnalytics(myAnalyticsResult.value || { ...EMPTY_ANALYTICS, quota: null })
        setLoadState({
          list: myUsageResult.status === 'fulfilled' ? 'success' : 'error',
          analytics: myAnalyticsResult.status === 'fulfilled' ? 'success' : 'error',
        })
        if (myUsageResult.status === 'rejected' || myAnalyticsResult.status === 'rejected') {
          Toast.warning('部分个人数据暂时无法加载，请刷新重试')
        }
      })
      .finally(() => {
        if (sequence === loadSequence.current) setLoading(false)
      })
  }, [dashboardPeriod])

  useEffect(() => {
    const timer = setTimeout(() => { load() }, 0)
    return () => clearTimeout(timer)
  }, [load])

  const mySummary = myAnalytics.summary || EMPTY_ANALYTICS.summary
  const myQuota = useMemo(() => myAnalytics.quota || {}, [myAnalytics.quota])
  const myTrend = useMemo(() => myAnalytics.trend || [], [myAnalytics.trend])
  const myModelRows = useMemo(() => buildModelRankRows(myAnalytics.models?.items, 4), [myAnalytics.models])
  const personalDataReady = loadState.analytics === 'success'
  const recentDataReady = loadState.list === 'success'
  const hasLoadError = loadState.list === 'error' || loadState.analytics === 'error'
  const latestRequest = mine.items?.[0] || null
  const periodLabel = USAGE_PERIOD_LABELS[dashboardPeriod] || `近 ${dashboardPeriod} 天`

  const statusItems = useMemo(() => {
    const items = []
    if (!personalDataReady) {
      items.push({
        tone: 'warning', icon: <IconAlertTriangle />, title: '个人数据暂时不可用',
        description: '请点击右上角刷新重试。',
      })
    } else if (myQuota.exhausted) {
      items.push({
        tone: 'danger', icon: <IconAlertTriangle />, title: '今日配额已用尽',
        description: '新的模型请求会被拦截，可查看自己的调用记录。',
        action: '查看日志', path: '/agent/my-usage',
      })
    } else if (Number(mySummary.errors || 0) > 0) {
      items.push({
        tone: 'warning', icon: <IconHistogram />, title: `${periodLabel}有 ${formatNumber(mySummary.errors)} 次异常请求`,
        description: '只包含你自己的调用，可在使用日志里查看原因。',
        action: '查看日志', path: '/agent/my-usage',
      })
    }
    if (!items.length) {
      items.push({
        tone: 'success', icon: <IconTickCircle />, title: '当前没有待处理问题',
        description: latestRequest
          ? `最近一次请求${formatRelativeTime(latestRequest.created_at)}，当前可正常使用。`
          : myQuota.daily_quota
            ? `今日剩余 ${formatTokenCount(myQuota.remaining)} / ${formatTokenCount(myQuota.daily_quota)} Token。`
            : '今日用量不限额。',
      })
    }
    return items.slice(0, 3)
  }, [latestRequest, myQuota, mySummary.errors, periodLabel, personalDataReady])

  const trendOption = useMemo(() => ({
    animationDuration: 260,
    color: ['#2563eb', '#38bdf8'],
    tooltip: {
      trigger: 'axis',
      backgroundColor: isDark ? '#1f2937' : '#fff',
      borderColor: isDark ? '#374151' : '#e2e8f0',
      textStyle: { color: isDark ? '#e5e7eb' : '#334155', fontSize: 13 },
    },
    grid: { left: 14, right: 18, top: 26, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category', boundaryGap: true,
      data: myTrend.map((item) => item.bucket.slice(dashboardPeriod === 1 ? 11 : 5, dashboardPeriod === 1 ? 16 : 10)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: isDark ? 'rgba(148, 163, 184, 0.24)' : '#e2e8f0' } },
      axisLabel: { color: '#94a3b8', fontSize: 12 },
    },
    yAxis: [
      {
        type: 'value', minInterval: 1,
        splitLine: { lineStyle: { color: isDark ? 'rgba(148, 163, 184, 0.12)' : '#f1f5f9' } },
        axisLabel: { color: '#94a3b8' },
      },
      {
        type: 'value',
        splitLine: { show: false },
        axisLabel: { color: '#94a3b8', formatter: formatCompactNumber },
      },
    ],
    series: [
      { name: '请求数', type: 'bar', barMaxWidth: 18, data: myTrend.map((item) => item.requests) },
      { name: '计费 Token', type: 'line', smooth: true, symbol: 'none', yAxisIndex: 1, data: myTrend.map((item) => item.tokens) },
    ],
  }), [dashboardPeriod, isDark, myTrend])

  const shortcuts = [
    canViewTokens && { title: '访问令牌', description: 'API Key', path: '/agent/tokens', icon: <IconUser /> },
    canViewMyLogs && { title: '使用日志', description: '我的调用记录', path: '/agent/my-usage', icon: <IconFile /> },
    canViewMyChannels && { title: '模型渠道', description: '个人渠道配置', path: '/agent/my-channels', icon: <IconLink /> },
  ].filter(Boolean)

  const successfulRequests = Number(mySummary.successful_requests ?? Math.max(0, Number(mySummary.requests || 0) - Number(mySummary.errors || 0)))
  const dailyQuota = Number(myQuota.daily_quota || 0)
  const quotaPercent = Number(myQuota.usage_percent)
  const quotaHint = !personalDataReady
    ? '数据暂不可用'
    : dailyQuota > 0
      ? `剩余 ${formatTokenCount(myQuota.remaining)} / ${formatTokenCount(dailyQuota)} · 已用 ${Number.isFinite(quotaPercent) ? quotaPercent.toFixed(1) : '0.0'}%`
      : '自然日计费 · 不限额'

  return <div className="dashboard-shell dashboard-shell--personal">
    <header className="dashboard-header">
      <div>
        <Title heading={5} className="dashboard-header__title">个人看板</Title>
        <Typography.Text type="tertiary">只展示你的用量、配额和调用状态 · 数据范围：{periodLabel}</Typography.Text>
      </div>
      <div className="dashboard-header__actions">
        <Select
          value={dashboardPeriod}
          onChange={setDashboardPeriod}
          optionList={USAGE_PERIOD_OPTIONS.filter((item) => [1, 7, 30].includes(item.value))}
          aria-label="个人看板时间范围"
          style={{ width: 118 }}
        />
        <Button icon={<IconRefresh />} loading={loading} onClick={load}>刷新</Button>
      </div>
    </header>

    <Spin spinning={loading}>
      {hasLoadError && (
        <Banner
          className="dashboard-banner"
          type="warning"
          fullMode={false}
          description="部分个人数据暂时无法加载，页面中的统计可能不完整，请刷新重试。"
        />
      )}
      <StatCardGroup className="dashboard-metrics" loading={loading} columns={4} items={[
        {
          label: '今日已用', value: personalDataReady ? formatTokenCount(myQuota.used_today) : '—', suffix: 'Token',
          hint: quotaHint,
          tone: myQuota.exhausted ? 'orange' : 'green', icon: <IconBolt />,
        },
        {
          label: `${periodLabel} 请求`, value: personalDataReady ? formatNumber(mySummary.requests) : '—', suffix: '次',
          hint: personalDataReady ? `${formatNumber(mySummary.active_models)} 个模型 · 不含进行中预留` : '数据暂不可用',
          icon: <IconHistogram />,
        },
        {
          label: `${periodLabel} Token`, value: personalDataReady ? formatTokenCount(mySummary.tokens) : '—', suffix: 'Token',
          hint: personalDataReady ? `入 ${formatTokenCount(mySummary.prompt_tokens)} / 出 ${formatTokenCount(mySummary.completion_tokens)}` : '数据暂不可用',
          tone: 'purple', icon: <IconBolt />,
        },
        {
          label: `${periodLabel} 成功率`, value: personalDataReady && mySummary.requests ? Number(mySummary.success_rate || 0).toFixed(1) : '—',
          suffix: personalDataReady && mySummary.requests ? '%' : '',
          hint: personalDataReady && mySummary.requests
            ? `成功 ${formatNumber(successfulRequests)} / ${formatNumber(mySummary.requests)} 次 · 异常 ${formatNumber(mySummary.errors)}`
            : personalDataReady ? '当前范围暂无请求' : '数据暂不可用',
          tone: Number(mySummary.errors || 0) > 0 ? 'orange' : 'green',
          icon: Number(mySummary.errors || 0) > 0 ? <IconAlertTriangle /> : <IconTickCircle />,
        },
      ]} />

      <section className="dashboard-primary-grid">
        <article className="dashboard-card dashboard-trend-card">
          <div className="dashboard-card__heading">
            <div>
              <Title heading={5}>我的趋势 · {periodLabel}</Title>
            </div>
            <div className="dashboard-chart-legend"><span><i className="is-bar" />请求数</span><span><i className="is-line" />计费 Token</span></div>
          </div>
          {myTrend.length ? (
            <ReactECharts option={trendOption} style={{ height: 260 }} notMerge lazyUpdate />
          ) : (
            <Empty className="dashboard-chart-empty" title={`${periodLabel}暂无请求`} />
          )}
        </article>

        <article className="dashboard-card dashboard-health-card">
          <div className="dashboard-card__heading">
            <div>
              <Title heading={5}>使用状态</Title>
            </div>
            <Tag
              size="small"
              type="light"
              color={statusItems[0]?.tone === 'success' ? 'green' : statusItems[0]?.tone === 'danger' ? 'red' : 'orange'}
            >
              {statusItems[0]?.tone === 'success' ? '正常' : '需关注'}
            </Tag>
          </div>
          <div className="dashboard-status-list">
            {statusItems.map((item) => <StatusItem
              key={item.title}
              {...item}
              onClick={item.path ? () => navigate(item.path) : undefined}
            />)}
          </div>
          <div className="dashboard-health-meta">
            <div><span>P95 耗时</span><strong>{personalDataReady && mySummary.requests ? `${formatNumber(mySummary.p95_latency_ms)} ms` : '—'}</strong></div>
            <div>
              <span>今日剩余</span>
              <strong>{personalDataReady ? (myQuota.daily_quota ? formatTokenCount(myQuota.remaining) : '不限额') : '—'}</strong>
            </div>
            <div><span>最近请求</span><strong>{recentDataReady ? formatRelativeTime(latestRequest?.created_at) : '—'}</strong></div>
          </div>
        </article>
      </section>

      <section className="dashboard-secondary-grid">
        <article className="dashboard-card dashboard-requests-card">
          <div className="dashboard-card__heading">
            <div>
              <Title heading={5}>我的最近请求</Title>
              <Typography.Text type="tertiary">仅展示本人的用量与状态</Typography.Text>
            </div>
            {canViewMyLogs && <Button theme="borderless" onClick={() => navigate('/agent/my-usage')}>全部记录<IconArrowRight /></Button>}
          </div>
          {recentDataReady && mine.items.length ? <div className="dashboard-request-list">
            {mine.items.map((item) => {
              const meta = STATUS_META[item.status] || { label: item.status, color: 'grey' }
              const cache = getUsageCacheInfo(item)
              return <button
                type="button"
                className="dashboard-request"
                key={item.id}
                onClick={() => setSelectedDetail(item)}
                aria-label={`查看 ${item.model || '未标记模型'} 请求详情`}
              >
                <span className="dashboard-request__model">
                  <strong>{item.model || '未标记模型'}</strong>
                  <small>{item.request_purpose?.label || '个人调用记录'}</small>
                </span>
                <span className="dashboard-request__tokens">{formatTokenCount(item.total_tokens)}<small>入 {formatTokenCount(item.prompt_tokens)} / 出 {formatTokenCount(item.completion_tokens)}</small></span>
                <span className="dashboard-request__cache">
                  <strong>{cache.hitRate === null ? (cache.hasAny ? '缓存待确认' : '缓存未上报') : `缓存 ${cache.hitRate}%`}</strong>
                  <small>{cache.hasAny ? `读 ${cache.readReported ? formatTokenCount(cache.read) : '—'} · 未命中 ${cache.missReported ? formatTokenCount(cache.miss) : '—'}` : '上游未提供缓存字段'}</small>
                </span>
                <span className="dashboard-request__latency">{item.latency_ms == null ? '—' : `${formatNumber(item.latency_ms)} ms`}</span>
                <Tag className="dashboard-request__status" size="small" type="light" color={meta.color}>{meta.label}</Tag>
                <span className="dashboard-request__time">{formatRelativeTime(item.created_at)}</span>
              </button>
            })}
          </div> : <Empty className="dashboard-list-empty" title={recentDataReady ? '暂无请求' : '暂时无法加载'} description={recentDataReady ? undefined : '请点击右上角刷新重试'} />}
        </article>

        <aside className="dashboard-side-stack">
          <article className="dashboard-card">
            <div className="dashboard-card__heading">
              <div>
                <Title heading={5}>我的模型消耗</Title>
                <Typography.Text type="tertiary">{canViewMyLogs ? `${periodLabel} · 点击进入使用日志` : `${periodLabel} · 按计费 Token 排序`}</Typography.Text>
              </div>
            </div>
            {personalDataReady ? <UsageRanking
              rows={myModelRows}
              className="usage-rank--compact"
              emptyTitle={`${periodLabel}暂无模型用量`}
              onSelect={canViewMyLogs ? (model) => navigate(`/agent/my-usage?model=${encodeURIComponent(model)}`) : undefined}
            /> : <Empty className="dashboard-list-empty" title="暂时无法加载" />}
          </article>

          {shortcuts.length > 0 && <article className="dashboard-card dashboard-shortcuts-card">
            <div className="dashboard-card__heading">
              <div>
                <Title heading={5}>常用操作</Title>
              </div>
            </div>
            <div className="dashboard-shortcuts">
              {shortcuts.map((item) => <button type="button" key={item.path} onClick={() => navigate(item.path)}>
                <span>{item.icon}</span>
                <span><strong>{item.title}</strong><small>{item.description}</small></span>
                <IconArrowRight />
              </button>)}
            </div>
          </article>}

          <article className="dashboard-cli-card">
            <div className="dashboard-cli-card__icon"><IconTerminal /></div>
            <div>
              <strong>从终端开始</strong>
              <span><code>coati login</code></span>
            </div>
          </article>
        </aside>
      </section>
    </Spin>
    <UsageDetailSheet row={selectedDetail} onClose={() => setSelectedDetail(null)} />
  </div>
}
