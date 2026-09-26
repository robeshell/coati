import { useCallback, useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTx } from '@/i18n'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import PageHeader from '@/shared/components/PageHeader'
import DataTable from '@/shared/components/DataTable'
import { FormDialog } from '@/shared/components/FormDialog'
import {
  FormInput,
  FormNumber,
  FormSelect,
  FormTextarea,
} from '@/shared/components/FormFields'
import { SearchInput } from '@/shared/components/Filters'
import ConfirmAction from '@/shared/components/ConfirmAction'
import request from '@/shared/api/request'
import { toast, errorMessage } from '@/lib/toast'
const base = '/admin/gateway/cache-tests'
const ratio = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`)
const number = (value) => (value == null ? '—' : value.toLocaleString())
export default function CacheTests() {
  const tx = useTx(),
    { hasPermission } = useAuth()
  const [data, setData] = useState({ items: [], total: 0 }),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('')
  const [open, setOpen] = useState(false),
    [running, setRunning] = useState(false),
    [keys, setKeys] = useState([]),
    [modelResult, setModels] = useState(null),
    [detail, setDetail] = useState(null)
  const detailVersion = useRef(0)
  const [inspecting, setInspecting] = useState(null)
  const version = useRef(0),
    form = useForm({
      defaultValues: {
        name: '',
        key_id: 'current-user',
        model: '',
        prompt: '',
        rounds: 3,
        max_tokens: 32,
      },
    })
  const selectedKey = useWatch({ control: form.control, name: 'key_id' })
  const load = useCallback(async () => {
    const current = ++version.current
    setLoading(true)
    detailVersion.current++
    setInspecting(null)
    setDetail(null)
    try {
      const result = await request.get(base, {
        params: { page, per_page: 20, search },
      })
      if (current === version.current) {
        const lastPage = Math.max(1, Math.ceil(result.total / 20))
        if (page > lastPage) setPage(lastPage)
        setData(result)
        setError('')
      }
    } catch (err) {
      if (current === version.current) setError(errorMessage(err))
    } finally {
      if (current === version.current) setLoading(false)
    }
  }, [page, search])
  useEffect(() => {
    const ref = version
    const timer = setTimeout(() => void load(), 150)
    return () => {
      clearTimeout(timer)
      ref.current++
      detailVersion.current++
    }
  }, [load])
  useEffect(() => {
    if (!open) return
    let live = true
    request
      .get(base + '/keys')
      .then((result) => {
        if (live) setKeys(result.items)
      })
      .catch((err) => {
        if (live) toast.apiError(err)
      })
    return () => {
      live = false
    }
  }, [open])
  useEffect(() => {
    if (!open || !selectedKey) return
    let live = true
    request
      .get(base + '/models', { params: selectedKey === 'current-user' ? {} : { key_id: selectedKey } })
      .then((result) => {
        if (live) setModels({ key: selectedKey, items: result.models })
      })
      .catch((err) => {
        if (live) toast.apiError(err)
      })
    return () => {
      live = false
    }
  }, [open, selectedKey])
  const models = modelResult?.key === selectedKey ? modelResult.items : []
  const start = () => {
    form.reset({
      name: '',
      key_id: 'current-user',
      model: '',
      prompt: '',
      rounds: 3,
      max_tokens: 32,
    })
    setKeys([])
    setModels(null)
    setOpen(true)
  }
  const run = async (values) => {
    setRunning(true)
    try {
      const result = await request.post(base, { ...values, key_id: values.key_id === 'current-user' ? undefined : values.key_id }, { timeout: 920000 })
      setOpen(false)
      await load()
      setDetail(result)
    } catch (err) {
      toast.apiError(err, '缓存验证失败')
      throw err
    } finally {
      setRunning(false)
    }
  }
  const show = async (row) => {
    const current = ++detailVersion.current
    setInspecting(row.id)
    try {
      const result = await request.get(`${base}/${row.id}`)
      if (current === detailVersion.current) setDetail(result)
    } catch (err) {
      if (current === detailVersion.current) toast.apiError(err)
    } finally {
      if (current === detailVersion.current) setInspecting(null)
    }
  }
  const remove = async (row) => {
    try {
      await request.delete(`${base}/${row.id}`)
      await load()
    } catch (err) {
      toast.apiError(err)
      throw err
    }
  }
  const columns = [
    { key: 'name', title: '验证名称', dataIndex: 'name' },
    { key: 'model', title: '模型名称', dataIndex: 'model' },
    {
      key: 'status',
      title: '状态',
      render: (_, row) =>
        tx({ ok: '已完成', partial: '部分完成', failed: '失败', running: '执行中', interrupted: '已中断' }[row.status] || row.status),
    },
    {
      key: 'rounds',
      title: '完成轮数',
      render: (_, row) => `${row.summary.completed_rounds}/${row.rounds}`,
    },
    {
      key: 'ratio',
      title: '缓存命中率',
      render: (_, row) => ratio(row.summary.hit_ratio),
    },
    {
      key: 'pool',
      title: '账号一致性',
      render: (_, row) =>
        tx(
          row.summary.account_consistent == null
            ? '未知'
            : row.summary.account_consistent
              ? '一致'
              : '已切换',
        ),
    },
    {
      key: 'actions',
      title: '操作',
      render: (_, row) => (
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" disabled={inspecting === row.id} onClick={() => show(row)}>
            {tx('详情')}
          </Button>
          {hasPermission('gateway_cache_tests_delete') && (
            <ConfirmAction
              title="删除缓存验证记录？"
              description="仅删除验证记录，不删除网关用量日志。"
              onConfirm={() => remove(row)}
            >
              <Button size="sm" variant="ghost">
                {tx('删除')}
              </Button>
            </ConfirmAction>
          )}
        </div>
      ),
    },
  ]
  const roundColumns = [
    { key: 'round', title: '轮次', dataIndex: 'round' },
    { key: 'status', title: '状态', dataIndex: 'status' },
    { key: 'upstream_name', title: '上游账号', dataIndex: 'upstream_name' },
    { key: 'upstream_model', title: '实际模型', dataIndex: 'upstream_model' },
    ...[
      ['cache_read_tokens', '缓存读取'],
      ['cache_write_tokens', '缓存写入'],
      ['cache_miss_tokens', '缓存未命中'],
    ].map(([key, title]) => ({
      key,
      title,
      render: (_, row) => number(row[key]),
    })),
    {
      key: 'ratio',
      title: '缓存命中率',
      render: (_, row) => ratio(row.hit_ratio),
    },
    {
      key: 'source',
      title: '数值来源',
      render: (_, row) =>
        tx(
          row.cache_status === 'unreported'
            ? '未上报'
            : row.cache_status === 'partial'
              ? '部分上报'
              : row.cache_miss_source === 'derived'
                ? '含推导未命中量'
                : '上游上报',
        ),
    },
    { key: 'latency_ms', title: '耗时 (ms)', dataIndex: 'latency_ms' },
    { key: 'request_id', title: '请求 ID', dataIndex: 'request_id' },
  ]
  return (
    <>
      <PageHeader
        title="缓存验证"
        description="重复发送相同请求，按网关实际用量记录比较缓存结果。— 表示未知，不代表零。"
        actions={
          <>
            <Button variant="outline" onClick={load} disabled={loading}>
              {tx('刷新')}
            </Button>
            {hasPermission('gateway_cache_tests_run') && (
              <Button variant="brand" onClick={start} disabled={running}>
                {tx('新建缓存验证')}
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4">
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
          placeholder="搜索验证名称或模型"
        />
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <DataTable
          columns={columns}
          data={data.items}
          loading={loading}
          minWidth={880}
          pagination={{
            page,
            perPage: 20,
            total: data.total,
            onChange: setPage,
          }}
        />
      )}
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        form={form}
        onSubmit={run}
        title="新建缓存验证"
        submitText="开始验证"
        description="使用当前用户或所选令牌调用上游，消耗实际额度。每轮发送相同提示词，最多 5 轮；提示词会随验证记录保存。"
      >
        <fieldset disabled={running} className="space-y-4">
          <FormInput
            control={form.control}
            name="name"
            label="验证名称"
            rules={{ required: '请输入验证名称' }}
          />
          <FormSelect
            control={form.control}
            name="key_id"
            label="执行身份"
            options={[{ label: tx('当前登录用户'), value: 'current-user' }, ...keys.map((key) => ({
              label: `${key.name} (${key.prefix}…)`,
              value: key.id,
            }))]}
            rules={{ required: '请选择访问令牌' }}
            description="默认沿用当前用户的额度和并发限制；也可选择令牌验证其模型权限和配额。"
          />
          <FormInput
            control={form.control}
            name="model"
            label="模型名称"
            rules={{ required: '请输入模型名称' }}
          />
          {models.length > 0 && (
            <details>
              <summary>{tx('从可用模型中选择')}</summary>
              <div className="max-h-28 overflow-auto flex flex-wrap gap-1">
                {models.map((model) => (
                  <Button
                    key={model}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => form.setValue('model', model)}
                  >
                    {model}
                  </Button>
                ))}
              </div>
            </details>
          )}
          <FormTextarea
            control={form.control}
            name="prompt"
            label="重复提示词"
            rows={6}
            rules={{ required: '请输入提示词', maxLength: 200000 }}
          />
          <FormNumber
            control={form.control}
            name="rounds"
            label="轮数"
            min={1}
            max={5}
            rules={{ required: true, min: 1, max: 5, validate: value => Number.isInteger(value) || tx('请输入整数') }}
          />
          <FormNumber
            control={form.control}
            name="max_tokens"
            label="每轮最大输出 Token"
            min={1}
            max={512}
            rules={{ required: true, min: 1, max: 512, validate: value => Number.isInteger(value) || tx('请输入整数') }}
          />
        </fieldset>
        {running && (
          <p role="status" className="text-sm">
            {tx('正在顺序调用网关，请勿重复提交。完成后显示逐轮结果。')}
          </p>
        )}
      </FormDialog>
      <Dialog
        open={Boolean(detail)}
        onOpenChange={(value) => { if (!value) { detailVersion.current++; setInspecting(null); setDetail(null) } }}
      >
        <DialogContent className="sm:max-w-[1100px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detail?.name}</DialogTitle>
            <DialogDescription>
              {tx('逐轮缓存结果；统计来源为网关已结算的请求日志。')}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="min-w-0 space-y-4">
              <p>
                {detail.model} · {tx('缓存命中率')}{' '}
                {ratio(detail.summary.hit_ratio)} · {tx('完成轮数')}{' '}
                {detail.summary.completed_rounds}/{detail.rounds}
              </p>
              {detail.summary.warning && (
                <p role="status" className="text-warning">
                  {tx(detail.summary.warning)}
                </p>
              )}
              {detail.error_summary && (
                <p role="alert" className="text-destructive">
                  {detail.error_summary}
                </p>
              )}
              <DataTable
                columns={roundColumns}
                data={detail.results}
                rowKey="round"
                minWidth={1200}
              />
              <details>
                <summary>{tx('查看保存的提示词')}</summary>
                <pre className="mt-2 whitespace-pre-wrap break-words text-sm">
                  {detail.prompt}
                </pre>
              </details>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
