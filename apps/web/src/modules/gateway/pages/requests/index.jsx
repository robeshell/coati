import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useState } from 'react'
import PageHeader from '@/shared/components/PageHeader'
import DataTable from '@/shared/components/DataTable'
import StatusBadge from '@/shared/components/StatusBadge'
import { DetailSheet, DescriptionList } from '@/shared/components/FormDialog'
import { Button } from '@/components/ui/button'
import { listGateway } from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'
const labels = {
  ok: '成功',
  reserved: '进行中',
  error: '失败',
  stream_error: '流中断',
  cancelled: '已取消',
  interrupted: '进程中断',
}
export default function Requests() {
  const { t } = useTranslation()

  const [data, setData] = useState({ items: [], total: 0 }),
    [page, setPage] = useState(1),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [detail, setDetail] = useState(null),
    [attempts, setAttempts] = useState([])
  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await listGateway('requests', { page }))
      setError('')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [page])
  useEffect(() => {
    void load()
  }, [load])
  const inspect = async (row) => {
    try {
      const r = await listGateway(`requests/${row.id}/attempts`)
      setAttempts(r.items)
      setDetail(row)
    } catch (e) {
      toast.apiError(e, '加载详情失败')
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
    { key: 'protocol', title: '协议', dataIndex: 'protocol' },
    {
      key: 'status',
      title: '状态',
      dataIndex: 'status',
      render: (v) => (
        <StatusBadge
          tone={v === 'ok' ? 'success' : v === 'reserved' ? 'info' : 'warning'}
          dot
        >
          {labels[v] || v}
        </StatusBadge>
      ),
    },
    {
      key: 'tokens',
      title: 'Token',
      align: 'right',
      render: (_, r) => (
        <span className="tabular-nums">
          {(r.input_tokens + r.output_tokens).toLocaleString()}
          {r.usage_source === 'estimated' ? '（估算）' : ''}
        </span>
      ),
    },
    {
      key: 'duration',
      title: '耗时',
      dataIndex: 'duration_ms',
      align: 'right',
      render: (v) => (v === null ? '—' : `${v} ms`),
    },
    {
      key: 'detail',
      title: '详情',
      render: (_, r) => (
        <Button variant="ghost" size="sm" onClick={() => inspect(r)}>
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
            page,
            perPage: 20,
            total: data.total,
            onChange: setPage,
          }}
        />
      )}
      <DetailSheet
        open={Boolean(detail)}
        onOpenChange={(v) => {
          if (!v) setDetail(null)
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
                  状态: labels[detail.status],
                  用量来源: detail.usage_source,
                  错误: detail.error,
                }).map(([label, value]) => ({ label, value }))
              : []
          }
        />
        <h3 className="mt-6 mb-3 font-medium">{t('上游尝试')}</h3>
        {attempts.map((a) => (
          <div key={a.id} className="border-b py-3 text-sm">
            <p>
              {t('服务 #')}
              {a.upstream_id} · HTTP {a.status || '连接失败'} · {a.duration_ms}{' '}
              ms
            </p>
            {a.error && <p className="text-danger mt-2 break-all">{a.error}</p>}
          </div>
        ))}
      </DetailSheet>
    </>
  )
}
