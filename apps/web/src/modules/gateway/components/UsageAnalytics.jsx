import { requestStatuses as statuses } from '@/modules/gateway/request-status'
import { usageQueryParams } from '@/modules/gateway/usage-query'
import { Link, useSearchParams } from 'react-router-dom'
import { chartBase, useChartColors } from '@/lib/chart-theme'
import Panel from '@/shared/components/Panel'
import StatCard from '@/shared/components/StatCard'
import { FilterSelect } from '@/shared/components/Filters'
import { Skeleton } from '@/components/ui/skeleton'
import { Activity, Coins, CircleCheck, Gauge, RefreshCw, Search, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactECharts from 'echarts-for-react'
import PageHeader from '@/shared/components/PageHeader'
import DataTable from '@/shared/components/DataTable'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getUsageAnalytics, listMyUsage } from '@/modules/gateway/api/gateway'

const defaults = { days: '7', model: '', pat_id: '', status: '', user_id: '' }

export default function UsageAnalytics({ scope = 'personal' }) {
  const { t } = useTranslation()
  const colors = useChartColors()
  const base = chartBase(colors)
  const [params, setParams] = useSearchParams()
  const initial = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, params.get(key) || value]))
  const [draft, setDraft] = useState(initial)
  const [query, setQuery] = useState(initial)
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const beginLoad = () => {
    setLoading(true)
    setError('')
  }
  const reload = () => {
    beginLoad()
    setRefresh((v) => v + 1)
  }
  useEffect(() => {
    let current = true
    const { user_id: _userId, ...personal } = query
    Promise.all([getUsageAnalytics(scope, scope === 'admin' ? query : personal), scope === 'personal' ? listMyUsage({ ...personal, per_page: 6 }) : Promise.resolve(null)])
      .then(([analytics, recent]) => ({ ...analytics, recent: recent?.items || [] }))
      .then((value) => {
        if (current) setData(value)
      })
      .catch((e) => {
        if (current) {
          setData(null)
          setError(e.message || t('加载失败'))
        }
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [scope, query, refresh, t])
  const change = (name, value) => setDraft((d) => ({ ...d, [name]: value }))
  const select = (name, label, options) => {
    const choices = draft[name] && !options.some(option => String(option.value) === draft[name])
      ? [{ value: draft[name], label: draft[name] }, ...options] : options
    return <label className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground xl:flex-1">
      <span>{t(label)}</span>
      <FilterSelect value={draft[name]} onChange={value => change(name, value)} options={choices}
        placeholder={label} allLabel={name === 'status' ? '已结束请求' : '全部'} className="w-full text-foreground" />
    </label>
  }
  const count = (value) =>
    value == null ? t('未报告') : Number(value).toLocaleString()
  const trend = data?.trend || []
  const chart = {
    ...base,
    backgroundColor: 'transparent',
    aria: { enabled: true },
    tooltip: { ...base.tooltip, renderMode: 'richText' },
    legend: { top: 0, textStyle: { color: colors['muted-foreground'], fontSize: 11 }, data: [t('Token 用量'), t('请求数')] },
    grid: { left: 12, right: 12, top: 40, bottom: 44, containLabel: true },
    xAxis: {
      ...base.xAxis,
      type: 'category',
      data: trend.map((row) => row.bucket),
      axisLabel: { ...base.xAxis.axisLabel, formatter: (value) => value.slice(5, 16).replace('T', ' ') },
    },
    yAxis: [
      { ...base.yAxis, type: 'value', name: 'Token', nameTextStyle: { color: colors['muted-foreground'] } },
      { ...base.yAxis, type: 'value', minInterval: 1, splitLine: { show: false } },
    ],
    series: [
      {
        name: t('Token 用量'),
        type: 'line',
        data: trend.map((row) => row.tokens),
        showSymbol: trend.length < 20,
      },
      {
        name: t('请求数'),
        type: 'line',
        yAxisIndex: 1,
        data: trend.map((row) => row.requests),
        showSymbol: trend.length < 20,
      },
    ],
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 10 }],
  }
  return (
    <div className="space-y-4">
      <PageHeader
        title={scope === 'admin' ? '全员用量统计' : '我的用量统计'}
        actions={
          <Button size="sm" variant="outline" onClick={reload} disabled={loading}><RefreshCw />
            {t('刷新')}
          </Button>
        }
      />
      <form
        className="surface-card grid grid-cols-2 items-end gap-3 p-4 md:grid-cols-3 xl:flex xl:flex-wrap"
        onSubmit={(e) => {
          e.preventDefault()
          beginLoad()
          setQuery({ ...draft })
          setParams(current => usageQueryParams(current, draft))
        }}
      >
        <label className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
          {t('最近天数')}
          <Input
            className="h-8 w-full text-foreground xl:w-24"
            type="number"
            min={1}
            max={365}
            required
            value={draft.days}
            onChange={(e) => change('days', e.target.value)}
          />
        </label>
        {select('model', '模型', data?.filter_options?.models || [])}
        {scope === 'admin' ? (
          <>
            {select('user_id', '用户', data?.filter_options?.users || [])}
            <label className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
              {t('令牌 ID')}
              <Input
                className="h-8 w-full text-foreground xl:w-24"
                type="number"
                min={1}
                value={draft.pat_id}
                onChange={(e) => change('pat_id', e.target.value)}
              />
            </label>
          </>
        ) : (
          select('pat_id', '令牌名称', data?.filter_options?.pats || [])
        )}
        {select(
          'status',
          '状态',
          Object.entries(statuses).filter(([value]) => value !== 'reserved').map(([value, label]) => ({
            value,
            label: t(label),
          })),
        )}
        <div className="flex items-center gap-1"><Button size="sm" type="submit"><Search />{t('查询')}</Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(defaults)
            beginLoad()
            setQuery({ ...defaults })
            setParams(current => usageQueryParams(current, defaults))
          }}
        >
          <RotateCcw />{t('重置')}
        </Button></div>
      </form>
      {loading ? (
        <div role="status" className="space-y-4"><span className="sr-only">{t('加载中…')}</span><div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[0,1,2,3].map(key=><Skeleton key={key} className="h-28" />)}</div><Skeleton className="h-80" /></div>
      ) : error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : (
        data && (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard label="请求数" value={data.summary.requests} icon={Activity} hint={`${t('异常请求')} · ${count(data.summary.errors)}`} />
              <StatCard label="Token 用量" value={data.summary.tokens} icon={Coins} hint={`${t('活跃模型')} · ${count(data.summary.active_models)}`} />
              <StatCard label="成功率" value={data.summary.requests ? data.summary.success_rate : null} decimals={1} suffix="%" icon={CircleCheck} />
              <StatCard label="缓存命中率" value={data.summary.cache_hit_rate} decimals={1} suffix="%" icon={Gauge} />
            </div>
            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
            <Panel title="用量趋势" className="min-w-0" description={data.timezone}>
              {trend.length ? (
                <ReactECharts
                  option={chart}
                  notMerge
                  style={{ height: 300, width: '100%' }}
                />
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t('暂无数据')}
                </p>
              )}
              <details className="mt-2 text-muted-foreground">
                <summary className="cursor-pointer text-sm">
                  {t('查看趋势数据')}
                </summary>
                <DataTable bordered={false}
                  rowKey="bucket"
                  data={trend}
                  columns={[
                    { key: 'bucket', title: '时间', dataIndex: 'bucket' },
                    ...['requests', 'tokens', 'errors'].map((key, i) => ({
                      key,
                      title: ['请求数', 'Token 用量', '异常请求'][i],
                      dataIndex: key,
                      align: 'right',
                      render: count,
                    })),
                  ]}
                />
              </details>
            </Panel>
            <Panel title="使用状态" className="min-w-0">
              <dl className="divide-y text-[13px]">
                {[
                  ['平均耗时', `${count(data.summary.avg_latency_ms)} ms`],
                  ['P95 耗时', `${count(data.summary.p95_latency_ms)} ms`],
                  ['输入 Token（含缓存）', count(data.summary.prompt_tokens)],
                  ['输出 Token（含推理）', count(data.summary.completion_tokens)],
                  ['推理 Token', count(data.summary.reasoning_tokens)],
                  ['估算用量请求', count(data.summary.estimated_requests)],
                ].map(([label,value])=><div key={label} className="flex items-baseline justify-between gap-3 py-2.5"><dt className="text-muted-foreground">{t(label)}</dt><dd className="font-medium tabular-nums">{value}</dd></div>)}
              </dl>
              {scope === 'personal' && data.quota && <div className="mt-3 rounded-lg bg-muted/50 p-3 text-xs leading-6">
                <p>{t('今日已用')} <strong className="tabular-nums">{count(data.quota.used_today)}</strong></p>
                <p>{t('生效日额度')} {data.quota.daily_quota == null ? t('不限额') : count(data.quota.daily_quota)}</p>
                <p>{t('剩余额度')} {data.quota.remaining == null ? t('不限额') : count(data.quota.remaining)}</p>
              </div>}
              <p className={`mt-3 text-xs leading-relaxed ${data.summary.errors || data.quota?.exhausted ? 'text-warning' : 'text-muted-foreground'}`}>{t(data.quota?.exhausted ? '今日配额已用尽' : data.summary.errors ? '所选期间有异常请求，请查看日志排查' : '所选期间没有异常请求')}</p>
              <Button size="sm" className="mt-3" variant="outline" asChild><Link to={`${scope === 'admin' ? '/gateway/requests' : '/agent/my-usage'}?${new URLSearchParams({ ...query, tab: scope === 'admin' ? 'requests' : 'records' })}`}>{t('查看请求日志')}</Link></Button>
            </Panel>
            </div>
            <Panel title="缓存统计">
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                {t('仅累计已计费用量中已报告的缓存值；未报告不按零计算。')} {t('缓存命中率按已报告读取缓存的请求加权计算：缓存读取 Token / 对应输入 Token。')}
              </p>
              <DataTable bordered={false}
                rowKey="key"
                data={['read', 'write', 'miss', 'write_5m', 'write_1h'].map((key, i) => ({
                  key,
                  label: t(
                    ['缓存读取 Token', '缓存写入 Token', '缓存未命中 Token', '5 分钟缓存写入 Token', '1 小时缓存写入 Token'][i],
                  ),
                  tokens: data.summary[`cache_${key}_tokens`],
                  reported: data.summary[`cache_${key}_reported_requests`],
                }))}
                columns={[
                  { key: 'label', title: '缓存维度', dataIndex: 'label' },
                  {
                    key: 'tokens',
                    title: 'Token 用量',
                    dataIndex: 'tokens',
                    align: 'right',
                    render: count,
                  },
                  {
                    key: 'reported',
                    title: '已报告请求数',
                    dataIndex: 'reported',
                    align: 'right',
                    render: count,
                  },
                ]}
              />
            </Panel>
            <Panel title="模型用量分布">
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                {t(
                  '最多展示 8 个模型，占比按全部模型用量计算；此分布不受模型筛选限制。',
                )}
              </p>
              <DataTable bordered={false}
                rowKey="model"
                data={data.models.items}
                columns={[
                  { key: 'model', title: '模型', render: (_, row) => <Link className="break-all text-primary underline" to={`${scope === 'admin' ? '/gateway/requests' : '/agent/my-usage'}?${new URLSearchParams({ ...query, tab: scope === 'admin' ? 'requests' : 'records', model: row.model || '' })}`}>{row.model || t('未报告')}</Link> },
                  {
                    key: 'requests',
                    title: '请求数',
                    dataIndex: 'requests',
                    align: 'right',
                    render: count,
                  },
                  {
                    key: 'tokens',
                    title: 'Token 用量',
                    dataIndex: 'tokens',
                    align: 'right',
                    render: count,
                  },
                  {
                    key: 'share',
                    title: '占比',
                    dataIndex: 'share_percent',
                    align: 'right',
                    render: (value) => `${value}%`,
                  },
                ]}
              />
            </Panel>
            {scope === 'personal' && <Panel title="最近请求">
              <DataTable bordered={false} rowKey="id" data={data.recent} columns={[
                {key:'created_at',title:'时间',dataIndex:'created_at',render:value=><span className="whitespace-nowrap text-xs text-muted-foreground">{value ? new Date(value).toLocaleString() : '—'}</span>},
                {key:'model',title:'模型',dataIndex:'model'},
                {key:'status',title:'状态',render:(_,row)=>t(statuses[row.status] || row.status)},
                {key:'tokens',title:'Token 用量',dataIndex:'total_tokens',align:'right',render:count},
              ]}/>
            </Panel>}
            {scope === 'admin' && <Panel title="上游用量与缓存">
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{t('按请求执行时的上游快照分组，最多展示 100 项；缺失快照单独归类。')}</p>
              <DataTable bordered={false} rowKey={row => `${row.upstream_id}:${row.name}:${row.protocol}`} data={data.upstreams || []} columns={[
                {key:'name',title:'模型服务',dataIndex:'name'},
                {key:'protocol',title:'协议',dataIndex:'protocol'},
                ...[['requests','请求数'],['errors','异常请求'],['tokens','Token 用量'],['cache_read_tokens','缓存读取 Token'],['cache_read_reported_requests','已报告请求数']].map(([key,title])=>({key,title,dataIndex:key,align:'right',render:count})),
                {key:'cache_hit_rate',title:'缓存命中率',dataIndex:'cache_hit_rate',render:value=>value == null ? t('未报告') : `${Number(value).toFixed(1)}%`},
              ]}/>
            </Panel>}
            {scope === 'admin' && (
              <Panel title="用户用量排行">
                <DataTable bordered={false}
                  rowKey="user_id"
                  data={data.users}
                  columns={[
                    { key: 'name', title: '用户名', render: (_, row) => <Link className="text-primary underline" to={`/gateway/requests?${new URLSearchParams({ ...query, tab: 'requests', user_id: row.user_id })}`}>{row.username}</Link> },
                    ...['requests', 'tokens', 'errors'].map((key, i) => ({
                      key,
                      title: ['请求数', 'Token 用量', '异常请求'][i],
                      dataIndex: key,
                      align: 'right',
                      render: count,
                    })),
                  ]}
                />
              </Panel>
            )}
          </>
        )
      )}
    </div>
  )
}
