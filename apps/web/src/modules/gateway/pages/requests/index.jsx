import { requestStatusLabels as labels, requestStatuses } from '@/modules/gateway/request-status'
import { usageQueryParams } from '@/modules/gateway/usage-query'
import { useSearchParams } from 'react-router-dom'
import UsageAnalytics from '@/modules/gateway/components/UsageAnalytics'
import Quotas from '@/modules/gateway/pages/requests/Quotas'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useTranslation } from 'react-i18next'
import { useEffect, useRef, useState } from 'react'
import PageHeader from '@/shared/components/PageHeader'
import DataTable from '@/shared/components/DataTable'
import StatusBadge from '@/shared/components/StatusBadge'
import { DetailSheet, DescriptionList } from '@/shared/components/FormDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listAdminUsage, listGateway } from '@/modules/gateway/api/gateway'
import UsageDetails from '@/modules/gateway/pages/requests/UsageDetails'
import { toast } from '@/lib/toast'

function RequestLog() {
  const { t } = useTranslation()

  const [params, setParams] = useSearchParams()
  const defaults = { days: '7', model: '', user_id: '', pat_id: '', status: '' }
  const initial = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, params.get(key) || value]))
  const [draft, setDraft] = useState(initial)
  const [query, setQuery] = useState({ ...initial, page: 1 })
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState({ items: [], total: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState(null)
  const [attempts, setAttempts] = useState([])
  const [inspecting, setInspecting] = useState(null)
  const detailGeneration = useRef(0)
  const beginLoad = () => {
    setLoading(true)
    setError('')
    detailGeneration.current++
    setInspecting(null)
    setDetail(null)
  }
  const load = () => {
    beginLoad()
    setRefresh((value) => value + 1)
  }
  const changeQuery = (next) => {
    beginLoad()
    setQuery(next)
  }
  useEffect(() => {
    let current = true
    listAdminUsage({ ...query, per_page: 20 })
      .then((result) => {
        if (current) setData(result)
      })
      .catch((e) => {
        if (current) {
          setData({ items: [], total: 0 })
          setError(e.message || t('加载失败'))
        }
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [query, refresh, t])
  useEffect(
    () => () => {
      detailGeneration.current++
    },
    [],
  )
  const inspect = async (row) => {
    const generation = ++detailGeneration.current
    setInspecting(row.id)
    try {
      const [request, result] = await Promise.all([
        listGateway(`requests/${row.id}`),
        listGateway(`requests/${row.id}/attempts`),
      ])
      if (generation !== detailGeneration.current) return
      setAttempts(result.items)
      setDetail({ ...request, username: row.username, pat_name: row.pat_name })
    } catch (e) {
      if (generation === detailGeneration.current)
        toast.apiError(e, '加载详情失败')
    } finally {
      if (generation === detailGeneration.current) setInspecting(null)
    }
  }
  const cols = [
    {
      key: 'time',
      title: '时间',
      dataIndex: 'created_at',
      render: (v) => new Date(v).toLocaleString(),
    },
    { key: 'model', title: '模型', dataIndex: 'model' },
    { key: 'username', title: '用户名', dataIndex: 'username' },
    { key: 'pat', title: '令牌名称', dataIndex: 'pat_name' },
    { key: 'account', title: '服务名称', dataIndex: 'credential_name' },
    { key: 'protocol', title: '协议', dataIndex: 'inbound_protocol' },
    {
      key: 'status',
      title: '状态',
      dataIndex: 'status',
      render: (v) => (
        <StatusBadge
          tone={v === 'ok' ? 'success' : v === 'reserved' ? 'info' : 'warning'}
          dot
        >
          {t(labels[v] || v)}
        </StatusBadge>
      ),
    },
    {
      key: 'tokens',
      title: 'Token',
      align: 'right',
      render: (_, r) => (
        <span className="tabular-nums">
          {r.total_tokens.toLocaleString()}
          {r.usage_source === 'estimated' ? '（估算）' : ''}
        </span>
      ),
    },
    {
      key: 'duration',
      title: '耗时',
      dataIndex: 'latency_ms',
      align: 'right',
      render: (v) => (v === null ? '—' : `${v} ms`),
    },
    {
      key: 'detail',
      title: '详情',
      render: (_, r) => (
        <Button
          variant="ghost"
          size="sm"
          disabled={inspecting === r.id}
          onClick={() => inspect(r)}
        >
          {t('查看')}
        </Button>
      ),
    },
  ]
  return (
    <>
      <PageHeader
        title="请求日志"
        actions={
          <Button variant="outline" onClick={load}>
            {t('刷新')}
          </Button>
        }
      />
      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          changeQuery({ ...draft, page: 1 })
          setParams(current => usageQueryParams(current, draft))
        }}
      >
        {[
          ['days', '最近天数'],
          ['model', '模型'],
          ['user_id', '用户 ID'],
          ['pat_id', '令牌 ID'],
        ].map(([name, label]) => (
          <label key={name} className="flex flex-col gap-2 text-sm">
            {t(label)}
            <Input
              className="w-36"
              value={draft[name]}
              onChange={(e) =>
                setDraft((value) => ({ ...value, [name]: e.target.value }))
              }
              type={name === 'model' ? 'text' : 'number'}
              min={1}
              max={name === 'days' ? 365 : undefined}
              required={name === 'days'}
              maxLength={name === 'model' ? 128 : undefined}
            />
          </label>
        ))}
        <label className="flex flex-col gap-2 text-sm">
          {t('状态')}
          <select
            className="h-9 rounded-md border bg-background px-3"
            value={draft.status}
            onChange={(e) =>
              setDraft((value) => ({ ...value, status: e.target.value }))
            }
          >
            <option value="">{t('已结束请求')}</option>
            {Object.entries(requestStatuses)
              .map(([value, label]) => (
                <option key={value} value={value}>
                  {t(label)}
                </option>
              ))}
          </select>
        </label>
        <Button type="submit">{t('查询')}</Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setDraft(defaults)
            changeQuery({ ...defaults, page: 1 })
            setParams(current => usageQueryParams(current, defaults))
          }}
        >
          {t('重置')}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : (
        <DataTable
          columns={cols}
          data={data.items}
          loading={loading}
          pagination={{
            page: query.page,
            perPage: 20,
            total: data.total,
            onChange: (page) => changeQuery({ ...query, page }),
          }}
        />
      )}
      <DetailSheet
        open={Boolean(detail)}
        onOpenChange={(v) => {
          if (!v) {
            detailGeneration.current++
            setInspecting(null)
            setDetail(null)
          }
        }}
        title="请求详情"
        description="包含上游尝试与脱敏后的错误原因。"
      >
        <DescriptionList
          items={
            detail
              ? Object.entries({
                  请求编号: detail.id,
                  模型: detail.model,
                  用户名: detail.username,
                  令牌名称: detail.pat_name,
                  [t('路由名称')]: detail.execution?.route_name ?? t('未报告'),
                  [t('服务名称')]:
                    detail.execution?.upstream_name ?? t('未报告'),
                  [t('供应商分类')]: detail.execution?.provider ?? t('未报告'),
                  [t('实际模型')]:
                    detail.execution?.upstream_model ?? t('未报告'),
                  状态: t(labels[detail.status] || detail.status),
                  [t('网关 HTTP 状态')]: detail.http_status ?? t('未报告'),
                  入站协议: detail.protocol,
                  上游协议: detail.execution?.upstream_protocol || detail.upstream_protocol || t('未报告'),
                  用量来源:
                    detail.usage_source === 'upstream'
                      ? t('上游报告')
                      : detail.usage_source === 'estimated'
                        ? t('估算')
                        : t('未报告'),
                  错误: detail.error,
                }).map(([label, value]) => ({ label, value }))
              : []
          }
        />
        {detail && <UsageDetails request={detail} />}
        <h3 className="mt-6 mb-3 font-medium">{t('上游尝试')}</h3>
        {attempts.map((a) => (
          <div key={a.id} className="border-b py-3 text-sm">
            <p>
              {t('服务 #')}
              {a.upstream_id} · HTTP {a.status || '连接失败'} · {a.duration_ms}{' '}
              ms
            </p>
            {a.execution && (
              <p className="mt-2 break-all">
                {a.execution.upstream_name} · {a.execution.upstream_model} ·{' '}
                {a.execution.upstream_protocol} · {a.execution.provider}
              </p>
            )}
            {a.error && <p className="text-danger mt-2 break-all">{a.error}</p>}
          </div>
        ))}
      </DetailSheet>
    </>
  )
}

export default function Requests() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const tab = ['requests', 'analytics', 'quotas'].includes(params.get('tab')) ? params.get('tab') : 'requests'
  return (
    <Tabs value={tab} onValueChange={value => setParams(previous => { previous.set('tab', value); return previous })}>
      <TabsList className="mb-4">
        <TabsTrigger value="requests">{t('请求日志')}</TabsTrigger>
        <TabsTrigger value="analytics">{t('用量统计')}</TabsTrigger>
        <TabsTrigger value="quotas">{t('用户配额')}</TabsTrigger>
      </TabsList>
      <TabsContent value="requests">
        <RequestLog key={params.toString()} />
      </TabsContent>
      <TabsContent value="analytics"><UsageAnalytics key={params.toString()} scope="admin" /></TabsContent>
      <TabsContent value="quotas">
        <Quotas />
      </TabsContent>
    </Tabs>
  )
}
