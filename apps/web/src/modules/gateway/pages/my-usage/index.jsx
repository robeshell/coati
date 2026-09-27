import { requestStatuses as statuses } from '@/modules/gateway/request-status'
import { usageQueryParams } from '@/modules/gateway/usage-query'
import { useSearchParams } from 'react-router-dom'
import UsageAnalytics from '@/modules/gateway/components/UsageAnalytics'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/AuthContext'
import PageHeader from '@/shared/components/PageHeader'
import DataTable from '@/shared/components/DataTable'
import ExportDialog from '@/shared/components/data-transfer/ExportDialog'
import { DetailSheet, DescriptionList } from '@/shared/components/FormDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { listMyUsage, exportMyUsage } from '@/modules/gateway/api/gateway'
import { downloadBlobFile } from '@/shared/utils/file'
import { toast } from '@/lib/toast'
import { exportFields } from '@/modules/gateway/pages/my-usage/fields'
const defaults = { days: '7', model: '', pat_id: '', status: '' }

function PersonalRecords() {
  const { t } = useTranslation()
  const { hasPermission } = useAuth()
  const canExport = hasPermission('gateway_my_usage_export')
  const [params, setParams] = useSearchParams()
  const initial = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, params.get(key) || value]))
  const [draft, setDraft] = useState(initial)
  const [query, setQuery] = useState({ ...initial, page: 1 })
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState({ items: [], total: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState([])
  const [detail, setDetail] = useState(null)
  const [exportMode, setExportMode] = useState(null)
  const exporting = useRef(false)
  const beginLoad = () => { setLoading(true); setError(''); setSelected([]); setDetail(null) }
  const reload = () => { beginLoad(); setRefresh(value => value + 1) }
  const changeQuery = next => { beginLoad(); setQuery(next) }
  useEffect(() => {
    let current = true
    listMyUsage({ ...query, per_page: 20 })
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
  const count = (value) =>
    value == null ? t('未报告') : Number(value).toLocaleString()
  const columns = [
    {
      key: 'time',
      title: '时间',
      dataIndex: 'created_at',
      render: (value) => new Date(value).toLocaleString(),
    },
    { key: 'model', title: '模型', dataIndex: 'model' },
    { key: 'pat', title: '令牌名称', dataIndex: 'pat_name' },
    {
      key: 'status',
      title: '状态',
      dataIndex: 'status',
      render: (value) => t(statuses[value] || value),
    },
    {
      key: 'total',
      title: '合计 Token',
      dataIndex: 'total_tokens',
      align: 'right',
      render: (value, row) => (
        <span className="tabular-nums">
          {count(value)}
          {row.usage_source === 'estimated' ? t('（估算）') : ''}
        </span>
      ),
    },
    {
      key: 'cache',
      title: '缓存读取 Token',
      dataIndex: 'cache_read_tokens',
      align: 'right',
      render: count,
    },
    {
      key: 'detail',
      title: '详情',
      render: (_, row) => (
        <Button variant="ghost" size="sm" onClick={() => setDetail(row)}>
          {t('查看')}
        </Button>
      ),
    },
  ]
  const exportData = async ({ fields, fileType }) => {
    if (exporting.current) return
    exporting.current = true
    try {
      const blob = await exportMyUsage({
        fields,
        file_type: fileType,
        export_mode: exportMode,
        ids: exportMode === 'selected' ? selected : undefined,
        filters: query,
      })
      downloadBlobFile(blob, `my_usage_export.${fileType}`)
      setExportMode(null)
    } catch (e) {
      toast.apiError(e, '导出失败')
    } finally {
      exporting.current = false
    }
  }
  return (
    <>
      <PageHeader
        title="我的用量"
        description="查看自己的模型请求、缓存用量与错误记录。"
        actions={
          <Button
            variant="outline"
            disabled={loading}
            onClick={reload}
          >
            {t('刷新')}
          </Button>
        }
      />
      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          setSelected([])
          changeQuery({ ...draft, page: 1 })
          setParams(current => usageQueryParams(current, draft))
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('最近天数')}</span>
          <Input
            className="w-28"
            type="number"
            min="1"
            max="365"
            required
            value={draft.days}
            onChange={(event) =>
              setDraft({ ...draft, days: event.target.value })
            }
          />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-1 text-sm">
          <span>{t('模型')}</span>
          <Input
            value={draft.model}
            onChange={(event) =>
              setDraft({ ...draft, model: event.target.value })
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('令牌 ID')}</span>
          <Input
            className="w-32"
            type="number"
            min="1"
            value={draft.pat_id}
            onChange={(event) =>
              setDraft({ ...draft, pat_id: event.target.value })
            }
          />
        </label>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="usage-status">{t('状态')}</label>
          <Select
            value={draft.status || 'all'}
            onValueChange={(value) =>
              setDraft({ ...draft, status: value === 'all' ? '' : value })
            }
          >
            <SelectTrigger id="usage-status" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('已结束请求')}</SelectItem>
              {Object.entries(statuses).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {t(label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit">{t('查询')}</Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setDraft(defaults)
            setSelected([])
            changeQuery({ ...defaults, page: 1 })
            setParams(current => usageQueryParams(current, defaults))
          }}
        >
          {t('重置')}
        </Button>
      </form>
      {canExport && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={loading || Boolean(error) || !data.total}
            onClick={() => setExportMode('filtered')}
          >
            {t('导出筛选结果')}
          </Button>
          <Button
            variant="outline"
            disabled={loading || !selected.length}
            onClick={() => setExportMode('selected')}
          >
            {t('导出选中记录')} ({selected.length})
          </Button>
          <span className="text-sm text-muted-foreground">
            {t('筛选导出最多 5000 条；选中仅保留当前页。')}
          </span>
        </div>
      )}
      {error ? (
        <div role="alert" className="space-y-2 text-danger">
          <p>{error}</p>
          <Button
            variant="outline"
            onClick={reload}
          >
            {t('重试')}
          </Button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={data.items}
          loading={loading}
          selectable={canExport && !loading}
          selectedKeys={selected}
          onSelectionChange={setSelected}
          minWidth={820}
          pagination={{
            page: query.page,
            perPage: 20,
            total: data.total,
            onChange: (page) => {
              setSelected([])
              changeQuery({ ...query, page })
            },
          }}
        />
      )}
      <ExportDialog
        open={Boolean(exportMode)}
        onOpenChange={(open) => {
          if (!open) setExportMode(null)
        }}
        fieldOptions={exportFields}
        fileTypeOptions={[
          { value: 'xlsx', label: 'Excel', description: '.xlsx' },
          { value: 'csv', label: 'CSV', description: '.csv' },
          { value: 'xls', label: 'Excel 97–2003', description: '.xls' },
        ]}
        ruleHint={
          exportMode === 'selected'
            ? '仅导出当前选中的记录。'
            : '导出已应用的筛选结果，最多 5000 条。'
        }
        onConfirm={exportData}
      />
      <DetailSheet
        open={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
        title="请求详情"
        description="仅显示当前账号的请求信息。"
      >
        <DescriptionList
          items={
            detail
              ? exportFields.map((field) => ({
                  label: t(field.label),
                  value:
                    field.value === 'status'
                      ? t(statuses[detail.status] || detail.status)
                      : field.value === 'request_purpose'
                        ? detail.request_purpose?.label
                        : field.value === 'fallback_used'
                          ? detail.fallback_used
                            ? t('是')
                            : t('否')
                          : (detail[field.value] ?? t('未报告')),
                }))
              : []
          }
        />
      </DetailSheet>
    </>
  )
}

export default function MyUsage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  return <Tabs value={params.get('tab') === 'records' ? 'records' : 'analytics'} onValueChange={value => setParams(previous => { previous.set('tab', value); return previous })}><TabsList className="mb-4"><TabsTrigger value="records">{t('使用日志')}</TabsTrigger><TabsTrigger value="analytics">{t('用量统计')}</TabsTrigger></TabsList><TabsContent value="records"><PersonalRecords key={params.toString()} /></TabsContent><TabsContent value="analytics"><UsageAnalytics key={params.toString()} /></TabsContent></Tabs>
}
