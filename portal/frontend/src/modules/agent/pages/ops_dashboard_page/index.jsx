import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { useNavigate } from 'react-router-dom'
import { Banner, Button, Empty, Progress, Spin, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBranch,
  IconFile,
  IconHistogram,
  IconKey,
  IconRefresh,
  IconTerminal,
  IconTickCircle,
} from '@douyinfe/semi-icons'
import { useAuth } from '@/context/AuthContext'
import { useTheme } from '@/context/ThemeContext'
import { listCredentials } from '@/modules/agent/api/credentials'
import { listRoutes } from '@/modules/agent/api/routes'
import { getUsageAnalytics } from '@/modules/agent/api/usage'
import { formatCompactNumber, formatNumber, formatTokenCount } from '@/modules/agent/utils'
import AnimatedNumber from '@/shared/components/AnimatedNumber'
import StatCardGroup from '@/shared/components/statistics/StatCardGroup'
import '@/modules/admin/pages/dashboard/dashboard.css'
import './ops-dashboard.css'

const { Title } = Typography

const EMPTY_CREDENTIALS = {
  items: [], total: 0,
  summary: { total: 0, enabled: 0, healthy: 0, unhealthy: 0, unknown: 0 },
}
const EMPTY_ROUTES = {
  items: [], total: 0,
  summary: { total: 0, enabled: 0, disabled: 0, attention: 0 },
}
const EMPTY_ANALYTICS = {
  summary: {
    requests: 0, tokens: 0, errors: 0, success_rate: 0,
    avg_latency_ms: 0, p95_latency_ms: 0, active_users: 0, active_models: 0,
  },
  trend: [], users: [], models: { items: [], tokens: 0 }, daily_quota_per_user: null,
}
function Ranking({ items }) {
  const maximum = Math.max(...items.map((item) => Number(item.tokens || 0)), 1)
  if (!items.length) return <Empty className="ops-ranking-empty" title="暂无用户用量" />
  return <div className="ops-ranking">
    {items.slice(0, 8).map((item, index) => {
      const value = Number(item.tokens || 0)
      return <div className="ops-ranking__item" key={item.user_id}>
        <div className="ops-ranking__meta">
          <span><b>{index + 1}</b>{item.username}</span>
          <span><AnimatedNumber value={value} /> Token</span>
        </div>
        <Progress
          percent={Math.max(4, value / maximum * 100)}
          showInfo={false}
          size="small"
          aria-label={`${item.username} Token 占比`}
        />
      </div>
    })}
  </div>
}

/** 模型维度排行；点击进入用量配额页并按该模型筛选。 */
function ModelRanking({ items, onSelect }) {
  const maximum = Math.max(...items.map((item) => Number(item.tokens || 0)), 1)
  if (!items.length) return <Empty className="ops-ranking-empty" title="暂无模型用量" />
  return <div className="ops-ranking">
    {items.slice(0, 6).map((item, index) => {
      const value = Number(item.tokens || 0)
      const label = item.model || '未上报模型'
      return <button
        type="button"
        className="ops-ranking__item ops-ranking__trigger"
        key={label}
        disabled={!item.model}
        title={item.model ? `${formatNumber(item.requests)} 次请求 · 点击查看明细` : '这部分请求未上报模型名'}
        onClick={() => item.model && onSelect(item.model)}
      >
        <div className="ops-ranking__meta">
          <span><b>{index + 1}</b>{label}</span>
          <span><AnimatedNumber value={value} /> Token · {Number(item.share_percent || 0).toFixed(1)}%</span>
        </div>
        <Progress
          percent={Math.max(4, value / maximum * 100)}
          showInfo={false}
          size="small"
          aria-label={`${label} Token 占比`}
        />
      </button>
    })}
  </div>
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

export default function OpsDashboardPage() {
  const { hasPermission } = useAuth()
  const { isDark } = useTheme()
  const navigate = useNavigate()
  const canViewKeys = hasPermission('agent_llm_keys')
  const canViewRoutes = hasPermission('agent_routes')
  const canViewUsage = hasPermission('agent_usage')
  const [loading, setLoading] = useState(true)
  const [credentials, setCredentials] = useState(EMPTY_CREDENTIALS)
  const [routes, setRoutes] = useState(EMPTY_ROUTES)
  const [analytics, setAnalytics] = useState(EMPTY_ANALYTICS)
  const [loadState, setLoadState] = useState({ credentials: 'loading', routes: 'loading', analytics: 'loading' })

  const load = useCallback(() => {
    setLoading(true)
    setLoadState({
      credentials: canViewKeys ? 'loading' : 'skipped',
      routes: canViewRoutes ? 'loading' : 'skipped',
      analytics: canViewUsage ? 'loading' : 'skipped',
    })
    const tasks = [
      canViewKeys ? listCredentials({ page: 1, per_page: 100 }) : Promise.resolve(null),
      canViewRoutes ? listRoutes({ page: 1, per_page: 100, include_summary: true }) : Promise.resolve(null),
      canViewUsage ? getUsageAnalytics({ days: 7 }) : Promise.resolve(null),
    ]
    return Promise.allSettled(tasks)
      .then(([credentialResult, routeResult, analyticsResult]) => {
        if (credentialResult.status === 'fulfilled' && credentialResult.value) setCredentials(credentialResult.value)
        if (routeResult.status === 'fulfilled' && routeResult.value) setRoutes(routeResult.value)
        if (analyticsResult.status === 'fulfilled' && analyticsResult.value) setAnalytics(analyticsResult.value)
        const nextState = {
          credentials: !canViewKeys ? 'skipped' : credentialResult.status === 'fulfilled' ? 'success' : 'error',
          routes: !canViewRoutes ? 'skipped' : routeResult.status === 'fulfilled' ? 'success' : 'error',
          analytics: !canViewUsage ? 'skipped' : analyticsResult.status === 'fulfilled' ? 'success' : 'error',
        }
        setLoadState(nextState)
        if (Object.values(nextState).includes('error')) Toast.warning('部分运维数据暂时无法加载，请刷新重试')
      })
      .finally(() => setLoading(false))
  }, [canViewKeys, canViewRoutes, canViewUsage])

  useEffect(() => { load() }, [load])

  const credentialSummary = credentials.summary || EMPTY_CREDENTIALS.summary
  const routeSummary = useMemo(() => routes.summary || {
    total: routes.total || 0,
    enabled: routes.items.filter((item) => item.enabled).length,
    disabled: routes.items.filter((item) => !item.enabled).length,
    attention: routes.items.filter((item) => item.enabled && item.readiness === 'attention').length,
  }, [routes.items, routes.summary, routes.total])
  const summary = analytics.summary || EMPTY_ANALYTICS.summary
  const modelRows = analytics.models?.items || []
  const credentialsReady = loadState.credentials === 'success'
  const routesReady = loadState.routes === 'success'
  const analyticsReady = loadState.analytics === 'success'
  const hasLoadError = Object.values(loadState).includes('error')

  const statusItems = useMemo(() => {
    const items = []
    if (canViewKeys && !credentialsReady) {
      items.push({ tone: 'warning', icon: <IconAlertTriangle />, title: '模型账号数据暂不可用', description: '请刷新重试。' })
    } else if (canViewKeys && credentialSummary.enabled === 0) {
      items.push({
        tone: 'danger', icon: <IconAlertTriangle />, title: '网关尚未接入模型服务',
        description: '添加并检测一个模型账号后才能处理请求。', action: '去添加', path: '/agent/keys',
      })
    } else if (canViewKeys && credentialSummary.unhealthy > 0) {
      items.push({
        tone: 'danger', icon: <IconAlertTriangle />, title: `${credentialSummary.unhealthy} 个模型账号异常`,
        description: '异常账号不会参与新请求分流，请检查连接或密钥。', action: '去处理', path: '/agent/keys',
      })
    } else if (canViewKeys && credentialSummary.unknown > 0) {
      items.push({
        tone: 'warning', icon: <IconAlertTriangle />, title: `${credentialSummary.unknown} 个模型账号尚未检测`,
        description: '建议执行连接检测，确认模型列表和账号可用性。', action: '去检测', path: '/agent/keys',
      })
    }
    if (canViewRoutes && !routesReady) {
      items.push({ tone: 'warning', icon: <IconAlertTriangle />, title: '模型路由数据暂不可用', description: '请刷新重试。' })
    } else if (canViewRoutes && routeSummary.attention > 0) {
      items.push({
        tone: 'warning', icon: <IconBranch />, title: `${routeSummary.attention} 个模型路由需要处理`,
        description: '绑定账号已停用、异常或不支持目标模型。', action: '查看', path: '/agent/routes',
      })
    }
    if (canViewUsage && !analyticsReady) {
      items.push({ tone: 'warning', icon: <IconAlertTriangle />, title: '全员用量数据暂不可用', description: '请刷新重试。' })
    } else if (canViewUsage && Number(summary.errors || 0) > 0) {
      items.push({
        tone: 'warning', icon: <IconHistogram />, title: `近 7 天有 ${formatNumber(summary.errors)} 次异常请求`,
        description: '可在用量配额中查看请求详情。', action: '查看', path: '/agent/usage',
      })
    }
    if (!items.length) {
      items.push({
        tone: 'success', icon: <IconTickCircle />, title: '当前没有待处理问题',
        description: canViewKeys ? `${credentialSummary.healthy} 个健康账号可承接请求。` : '当前账号没有可查看的运维数据。',
      })
    }
    return items.slice(0, 4)
  }, [canViewKeys, canViewRoutes, canViewUsage, credentialSummary, credentialsReady, analyticsReady, routeSummary, routesReady, summary.errors])

  const trendOption = useMemo(() => ({
    animationDuration: 260,
    color: ['#2563eb', '#10b981', '#ef4444'],
    tooltip: {
      trigger: 'axis',
      backgroundColor: isDark ? '#1f2937' : '#fff',
      borderColor: isDark ? '#374151' : '#e2e8f0',
      textStyle: { color: isDark ? '#e5e7eb' : '#334155', fontSize: 13 },
    },
    legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 8, textStyle: { color: '#64748b' } },
    grid: { left: 14, right: 18, top: 34, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category', boundaryGap: false,
      data: (analytics.trend || []).map((item) => item.bucket.slice(5, 10)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: isDark ? 'rgba(148, 163, 184, 0.24)' : '#e2e8f0' } },
      axisLabel: { color: '#94a3b8', fontSize: 12 },
    },
    yAxis: [
      { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: isDark ? 'rgba(148, 163, 184, 0.12)' : '#f1f5f9' } }, axisLabel: { color: '#94a3b8' } },
      { type: 'value', splitLine: { show: false }, axisLabel: { color: '#94a3b8', formatter: formatCompactNumber } },
    ],
    series: [
      { name: '请求数', type: 'line', smooth: true, symbolSize: 5, areaStyle: { opacity: 0.08 }, data: (analytics.trend || []).map((item) => item.requests) },
      { name: '计费 Token', type: 'line', smooth: true, symbol: 'none', yAxisIndex: 1, data: (analytics.trend || []).map((item) => item.tokens) },
      { name: '异常', type: 'bar', barMaxWidth: 8, data: (analytics.trend || []).map((item) => item.errors) },
    ],
  }), [analytics.trend, isDark])

  const shortcuts = [
    canViewKeys && { title: '模型账号', description: '账号健康与密钥', path: '/agent/keys', icon: <IconKey /> },
    canViewRoutes && { title: '模型路由', description: '路由与绑定关系', path: '/agent/routes', icon: <IconBranch /> },
    canViewUsage && { title: '用量配额', description: '全员记录与额度', path: '/agent/usage', icon: <IconHistogram /> },
    { title: '个人使用日志', description: '查看自己的调用', path: '/agent/my-usage', icon: <IconFile /> },
  ].filter(Boolean)

  return <div className="dashboard-shell">
    <header className="dashboard-header">
      <div>
        <Title heading={5} className="dashboard-header__title">运维看板</Title>
        <Typography.Text type="tertiary">平台模型网关运行概览，仅管理员可见</Typography.Text>
      </div>
      <div className="dashboard-header__actions">
        <span className="dashboard-live is-ready"><i />平台运维</span>
        <Button icon={<IconRefresh />} loading={loading} onClick={load}>刷新</Button>
      </div>
    </header>

    <Spin spinning={loading}>
      {hasLoadError && (
        <Banner
          className="dashboard-banner"
          type="warning"
          fullMode={false}
          description="部分运维数据暂时无法加载，页面中的统计可能不完整，请刷新重试。"
        />
      )}
      <StatCardGroup className="dashboard-metrics" loading={loading} items={[
        {
          label: '健康模型账号', value: credentialsReady ? formatNumber(credentialSummary.healthy) : '—',
          suffix: credentialsReady ? `/ ${formatNumber(credentialSummary.enabled)}` : '',
          hint: credentialsReady ? `${formatNumber(credentialSummary.total)} 个账号 · ${formatNumber(credentialSummary.unknown)} 个待检测` : '数据暂不可用',
          tone: credentialsReady && credentialSummary.unhealthy > 0 ? 'orange' : 'green', icon: <IconKey />,
        },
        {
          label: '启用模型路由', value: routesReady ? formatNumber(routeSummary.enabled) : '—',
          suffix: routesReady ? `/ ${formatNumber(routeSummary.total)}` : '',
          hint: routesReady && routeSummary.attention ? `${formatNumber(routeSummary.attention)} 个需要处理` : '路由配置正常',
          tone: routesReady && routeSummary.attention ? 'orange' : 'blue', icon: <IconBranch />,
        },
        {
          label: '近 7 日请求', value: analyticsReady ? formatNumber(summary.requests) : '—', suffix: '次',
          hint: analyticsReady ? `${formatNumber(summary.active_users)} 位活跃用户 · ${formatNumber(summary.active_models)} 个活跃模型 · ${formatTokenCount(summary.tokens)} Token` : '数据暂不可用',
          icon: <IconHistogram />,
        },
        {
          label: '全员成功率', value: analyticsReady && summary.requests ? Number(summary.success_rate || 0).toFixed(1) : '—',
          suffix: analyticsReady && summary.requests ? '%' : '',
          hint: analyticsReady ? `P95 ${formatNumber(summary.p95_latency_ms)} ms · 异常 ${formatNumber(summary.errors)} 次` : '数据暂不可用',
          tone: analyticsReady && summary.errors > 0 ? 'orange' : 'green', icon: analyticsReady && summary.errors > 0 ? <IconAlertTriangle /> : <IconTickCircle />,
        },
      ]} />

      <section className="dashboard-primary-grid">
        <article className="dashboard-card dashboard-trend-card">
          <div className="dashboard-card__heading">
            <div>
              <Title heading={5}>平台调用趋势 · 近 7 天</Title>
              <Typography.Text type="tertiary">全员请求、计费 Token 与异常变化</Typography.Text>
            </div>
          </div>
          {analyticsReady && analytics.trend.length ? <ReactECharts option={trendOption} style={{ height: 260 }} notMerge lazyUpdate /> : <Empty className="dashboard-chart-empty" title={analyticsReady ? '暂无数据' : '数据暂不可用'} />}
        </article>

        <article className="dashboard-card dashboard-health-card">
          <div className="dashboard-card__heading">
            <div><Title heading={5}>运维状态</Title><Typography.Text type="tertiary">需要管理员处理的问题</Typography.Text></div>
            <Tag size="small" type="light" color={statusItems[0]?.tone === 'success' ? 'green' : statusItems[0]?.tone === 'danger' ? 'red' : 'orange'}>
              {statusItems[0]?.tone === 'success' ? '正常' : '需关注'}
            </Tag>
          </div>
          <div className="dashboard-status-list">
            {statusItems.map((item) => <StatusItem key={item.title} {...item} onClick={item.path ? () => navigate(item.path) : undefined} />)}
          </div>
          <div className="dashboard-health-meta">
            <div><span>平台账号</span><strong>{credentialsReady ? formatNumber(credentialSummary.total) : '—'}</strong></div>
            <div><span>模型路由</span><strong>{routesReady ? formatNumber(routeSummary.total) : '—'}</strong></div>
            <div><span>异常请求</span><strong>{analyticsReady ? formatNumber(summary.errors) : '—'}</strong></div>
          </div>
        </article>
      </section>

      <section className="dashboard-secondary-grid">
        <div className="ops-usage-stack">
          <article className="dashboard-card">
            <div className="dashboard-card__heading">
              <div><Title heading={5}>模型消耗 Top · 近 7 天</Title><Typography.Text type="tertiary">按计费 Token 排序，点击进入用量明细</Typography.Text></div>
            </div>
            {analyticsReady ? <ModelRanking
              items={modelRows}
              onSelect={(model) => navigate(`/agent/usage?model=${encodeURIComponent(model)}`)}
            /> : <Empty className="dashboard-list-empty" title="数据暂不可用" />}
          </article>
          <article className="dashboard-card">
            <div className="dashboard-card__heading">
              <div><Title heading={5}>用户消耗排行 · 近 7 天</Title><Typography.Text type="tertiary">按计费 Token 排序</Typography.Text></div>
            </div>
            {analyticsReady ? <Ranking items={(analytics.users || []).slice(0, 6)} /> : <Empty className="dashboard-list-empty" title="数据暂不可用" />}
          </article>
        </div>

        <aside className="dashboard-side-stack">
          {shortcuts.length > 0 && <article className="dashboard-card dashboard-shortcuts-card">
            <div className="dashboard-card__heading"><div><Title heading={5}>运维入口</Title></div></div>
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
            <div><strong>从终端开始</strong><span><code>coati login</code></span></div>
          </article>
        </aside>
      </section>
    </Spin>
  </div>
}
