import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import ReactECharts from 'echarts-for-react'
import { useAuth } from '@/context/AuthContext'
import Panel from '@/shared/components/Panel'
import StatCard from '@/shared/components/StatCard'
import SegmentedTabs from '@/shared/components/SegmentedTabs'
import { chartBase, useChartColors } from '@/lib/chart-theme'
import { Activity, Coins, CircleAlert, Timer, RefreshCw, ArrowRight } from 'lucide-react'
import PageHeader from '@/shared/components/PageHeader'
import DataTable from '@/shared/components/DataTable'
import { Button } from '@/components/ui/button'
import { listGateway, getUsageAnalytics, listRouteHealth } from '@/modules/gateway/api/gateway'

const number = value => value == null ? '—' : Number(value).toLocaleString()
export default function Overview() {
  const { t } = useTranslation(), { hasPermission } = useAuth()
  const colors = useChartColors(), base = chartBase(colors)
  const [days, setDays] = useState('7'), [refresh, setRefresh] = useState(0)
  const [state, setState] = useState({ loading: true, data: {}, errors: [] })
  const canAccounts = hasPermission('gateway_upstreams'), canRoutes = hasPermission('gateway_routes'), canUsage = hasPermission('gateway_requests')
  useEffect(() => {
    let current = true
    const tasks = [
      ['today', listGateway('overview')],
      ...(canAccounts ? [['accounts', listGateway('upstreams')]] : []),
      ...(canRoutes ? [['routes', listRouteHealth()]] : []),
      ...(canUsage ? [['analytics', getUsageAnalytics('admin', { days })]] : []),
    ]
    Promise.allSettled(tasks.map(([, task]) => task)).then(results => {
      if (!current) return
      const data = {}, errors = []
      results.forEach((result, index) => {
        const key = tasks[index][0]
        if (result.status === 'fulfilled') data[key] = result.value
        else errors.push(t({ today: '今日概况加载失败', accounts: '账号健康加载失败', routes: '路由状态加载失败', analytics: '用量统计加载失败' }[key]))
      })
      setState({ loading: false, data, errors })
    })
    return () => { current = false }
  }, [days, refresh, canAccounts, canRoutes, canUsage, t])
  const reload = () => { setState({ loading: true, data: {}, errors: [] }); setRefresh(value => value + 1) }
  const { today, accounts, routes, analytics } = state.data
  const summary = analytics?.summary, health = accounts?.summary, routing = routes?.summary
  const alerts = [
    ...(health && !health.enabled ? [[t('尚未启用模型服务'), '/gateway/upstreams']] : []),
    ...(health?.unhealthy ? [[`${t('异常或冷却账号')}：${number(health.unhealthy)}`, '/gateway/upstreams']] : []),
    ...(health?.unknown ? [[`${t('尚未检测账号')}：${number(health.unknown)}`, '/gateway/upstreams']] : []),
    ...(health?.recovering ? [[`${t('待恢复探测账号')}：${number(health.recovering)}`, '/gateway/upstreams']] : []),
    ...(routing?.attention ? [[`${t('需要处理的路由')}：${number(routing.attention)}`, '/gateway/routes']] : []),
    ...(summary?.errors ? [[`${t('所选期间异常请求')}：${number(summary.errors)}`, `/gateway/requests?tab=analytics&days=${days}`]] : []),
  ]
  const trend = analytics?.trend || []
  const chart = {
    ...base,
    backgroundColor: 'transparent', tooltip: { ...base.tooltip, renderMode: 'richText' },
    legend: { top: 0, textStyle: { color: colors['muted-foreground'], fontSize: 11 }, data: [t('请求数'), t('Token 用量'), t('异常请求')] },
    grid: { left: 12, right: 12, top: 40, bottom: 12, containLabel: true },
    xAxis: { ...base.xAxis, type: 'category', data: trend.map(row => row.bucket.slice(5, 16).replace('T', ' ')) },
    yAxis: [{ ...base.yAxis, type: 'value', minInterval: 1 }, { ...base.yAxis, type: 'value', name: 'Token', splitLine: { show: false } }],
    series: [
      { name: t('请求数'), type: 'line', data: trend.map(row => row.requests) },
      { name: t('Token 用量'), type: 'line', yAxisIndex: 1, data: trend.map(row => row.tokens) },
      { name: t('异常请求'), type: 'line', itemStyle: { color: colors.danger }, data: trend.map(row => row.errors) },
    ],
  }
  return <div className="space-y-4">
    <PageHeader title="网关总览" description={today ? t('今日 · {{timezone}}', { timezone: today.timezone }) : t('网关运行状态与用量')} actions={<Button size="sm" variant="outline" disabled={state.loading} onClick={reload}><RefreshCw />{t('刷新')}</Button>} />
    {state.loading && <p role="status">{t('加载中…')}</p>}
    {state.errors.length > 0 && <div role="alert" className="rounded-md border border-destructive p-3 text-sm">{state.errors.join('；')} · {t('请刷新重试')}</div>}
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {[['今日请求数', today?.requests, Activity], ['今日 Token 用量', today?.tokens, Coins], ['今日异常请求', today?.failed, CircleAlert], ['进行中', today?.active, Timer]].map(([label,value,icon])=><StatCard key={label} label={label} value={value} icon={icon} loading={state.loading} />)}
    </div>
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
      {canUsage && <Panel title="平台调用趋势" className="min-w-0" actions={<SegmentedTabs variant="pill" value={days} onChange={value=>{setState({loading:true,data:{},errors:[]});setDays(value)}} items={[1,7,30,90].map(value=>({value:String(value),label:`${value}d`}))} />}>
        <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 border-b pb-3 text-xs text-muted-foreground">
          {[[t('请求数'),number(summary?.requests)],[t('成功率'),summary?.requests ? `${summary.success_rate}%` : '—'],[t('活跃用户'),number(summary?.active_users)],[t('P95 耗时'),summary ? `${number(summary.p95_latency_ms)} ms` : '—']].map(([label,value])=><span key={label}>{label} <strong className="ml-1 text-foreground font-medium tabular-nums">{value}</strong></span>)}
        </div>
        {trend.length ? <ReactECharts option={chart} notMerge style={{height:280}} /> : <div className="flex h-70 items-center justify-center text-sm text-muted-foreground">{t(state.loading ? '加载中…' : analytics ? '暂无数据' : '数据暂不可用')}</div>}
      </Panel>}
      <Panel title="运维状态" className="min-w-0" description={health ? `${t('启用')} ${health.enabled} / ${t('全部')} ${health.total}` : undefined}>
        <dl className="divide-y text-[13px]">
          {[...(canAccounts ? [['健康账号',number(health?.healthy)],['异常账号',number(health?.unhealthy)],['尚未检测账号',number(health?.unknown)],['待恢复探测账号',number(health?.recovering)]] : []),...(canRoutes ? [['启用模型路由',number(routing?.enabled)],['需要处理的路由',number(routing?.attention)]] : [])].map(([label,value])=><div key={label} className="flex items-center justify-between gap-3 py-2.5"><dt className="text-muted-foreground">{t(label)}</dt><dd className="font-medium tabular-nums">{value}</dd></div>)}
        </dl>
        {alerts.length ? <ul className="mt-3 space-y-2 border-t pt-3">{alerts.map(([label,path])=><li key={label}><Link className="flex items-start justify-between gap-2 text-xs text-warning hover:underline" to={path}><span>{label}</span><ArrowRight className="size-3.5 shrink-0" /></Link></li>)}</ul> : <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t(state.loading ? '加载中…' : state.errors.length ? '部分数据不可用，无法确认整体状态' : '当前可查看的指标中没有待处理问题')}</p>}
      </Panel>
    </div>
    {canUsage && <>
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <Panel title="模型用量排行" className="min-w-0"><DataTable bordered={false} rowKey="model" data={analytics?.models.items || []} columns={[
          { key:'model', title:'模型', render:(_,row)=><Link className="break-all text-primary underline" to={`/gateway/requests?model=${encodeURIComponent(row.model || '')}&days=${days}`}>{row.model || t('未报告')}</Link> },
          { key:'requests',title:'请求数',dataIndex:'requests',align:'right',render:number },{ key:'tokens',title:'Token 用量',dataIndex:'tokens',align:'right',render:number },
        ]}/></Panel>
        <Panel title="用户用量排行" className="min-w-0"><DataTable bordered={false} rowKey="user_id" data={analytics?.users || []} columns={[
          { key:'username',title:'用户名',render:(_,row)=><Link className="text-primary underline" to={`/gateway/requests?user_id=${row.user_id}&days=${days}`}>{row.username}</Link> },
          { key:'requests',title:'请求数',dataIndex:'requests',align:'right',render:number },{ key:'tokens',title:'Token 用量',dataIndex:'tokens',align:'right',render:number },
        ]}/></Panel>
      </div>
      <Button variant="outline" asChild><Link to={`/gateway/requests?tab=analytics&days=${days}`}>{t('查看完整用量统计')}</Link></Button>
    </>}
    <section className="flex flex-wrap gap-3">
      {canAccounts && <Button variant="outline" asChild><Link to="/gateway/upstreams">{t('模型服务')}</Link></Button>}
      {canRoutes && <Button variant="outline" asChild><Link to="/gateway/routes">{t('模型与路由')}</Link></Button>}
      {hasPermission('gateway_keys') && <Button variant="outline" asChild><Link to="/gateway/keys">{t('访问与授权')}</Link></Button>}
      <Button variant="outline" asChild><Link to="/agent/my-usage?tab=analytics">{t('我的用量')}</Link></Button>
    </section>
  </div>
}
