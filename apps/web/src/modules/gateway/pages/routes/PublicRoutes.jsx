import { useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import PageHeader from '@/shared/components/PageHeader'
import { FilterSelect } from '@/shared/components/Filters'
import DataTable from '@/shared/components/DataTable'
import StatusBadge from '@/shared/components/StatusBadge'
import ConfirmAction from '@/shared/components/ConfirmAction'
import { FormDialog } from '@/shared/components/FormDialog'
import {
  FormInput,
  FormSelect,
  FormSwitch,
} from '@/shared/components/FormFields'
import {
  listGateway,
  saveGateway,
  disableGateway,
} from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'

const empty = {
  model: '',
  upstream_id: null,
  upstream_model: '',
  vision_model: '',
  description: '',
  upstream_base: '',
  fallback_enabled: false,
  enabled: true,
}
export default function PublicRoutes() {
  const { t } = useTranslation()
  const { hasPermission } = useAuth()
  const [data, setData] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [accountError, setAccountError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [search, setSearch] = useState('')
  const [enabledFilter, setEnabledFilter] = useState('')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState(null)
  const busy = useRef(false)
  const form = useForm({ defaultValues: empty })
  const accountId = useWatch({ control: form.control, name: 'upstream_id' })
  const bound = accountId != null
  const can = (action) => hasPermission(`gateway_routes_${action}`)
  const reload = () => {
    setLoading(true)
    setError('')
    setRefresh((n) => n + 1)
  }
  useEffect(() => {
    let current = true
    Promise.allSettled([
      listGateway('public-routes'),
      listGateway('upstreams'),
    ]).then(([routes, upstreams]) => {
      if (!current) return
      if (routes.status === 'fulfilled') {
        setData(routes.value.items)
        setError('')
      } else {
        setData([])
        setError(routes.reason?.message || t('加载失败'))
      }
      setAccounts(upstreams.status === 'fulfilled' ? upstreams.value.items : [])
      setAccountError(upstreams.status === 'rejected')
      setLoading(false)
    })
    return () => {
      current = false
    }
  }, [refresh, t])
  const edit = (row) => {
    if (busy.current) return
    form.reset(row ? { ...empty, ...row } : empty)
    setEditing(row || {})
  }
  const save = async (values) => {
    if (busy.current) return
    busy.current = true
    try {
      const body = {
        model: values.model.trim(),
        upstream_id: values.upstream_id,
        upstream_model: values.upstream_model?.trim() || null,
        vision_model: values.vision_model?.trim() || null,
        description: values.description?.trim() || null,
        enabled: values.enabled,
        fallback_enabled:
          values.upstream_id == null ? false : values.fallback_enabled,
        upstream_base:
          values.upstream_id == null
            ? null
            : values.upstream_base?.trim() || null,
      }
      await saveGateway('public-routes', body, editing.id)
      setEditing(null)
      toast.success('已保存')
      reload()
    } catch (e) {
      toast.apiError(e, '保存失败')
      throw e
    } finally {
      busy.current = false
    }
  }
  const remove = async (row) => {
    if (busy.current) return
    busy.current = true
    try {
      await disableGateway('public-routes', row.id)
      toast.success('已删除')
      reload()
    } catch (e) {
      toast.apiError(e, '操作失败')
      throw e
    } finally {
      busy.current = false
    }
  }
  const accountName = (id) =>
    accounts.find((a) => a.id === id)?.name || `${t('账号编号')} ${id}`
  const options = accounts.map((a) => ({
    value: a.id,
    label: `${a.name}${a.enabled ? '' : ` (${t('已停用')})`}`,
    disabled: !a.enabled && a.id !== accountId,
  }))
  if (bound && !accounts.some((a) => a.id === accountId))
    options.push({ value: accountId, label: accountName(accountId) })
  const selected = accounts.find((a) => a.id === accountId)
  const readiness = row => {
    if (!row.enabled) return '已停用'
    if (accountError) return '账号数据不可用'
    const target = row.upstream_model || row.model
    const candidates = accounts.filter(account => account.enabled &&
      (row.upstream_id == null || row.fallback_enabled || account.id === row.upstream_id) &&
      [...(account.supported_models || []), account.default_model].includes(target))
    if (!candidates.length) return '无可用候选账号'
    if (candidates.every(account => account.health_status === 'unhealthy' || account.cooldown_active)) return '候选账号异常或冷却中'
    if (candidates.every(account => account.health_status !== 'healthy')) return '候选账号尚待验证'
    return '存在健康候选账号'
  }
  const columns = [
    { key: 'readiness', title: '路由就绪状态', render: (_, row) => t(readiness(row)) },
    { key: 'model', minWidth: 160, title: '对外模型', dataIndex: 'model' },
    {
      key: 'account',
      minWidth: 200,
      title: '账号选择',
      render: (_, row) =>
        row.upstream_id == null
          ? t('自动账号池')
          : accountName(row.upstream_id),
    },
    {
      key: 'target',
      minWidth: 140,
      title: '上游模型',
      render: (_, row) => row.upstream_model || row.model,
    },
    {
      key: 'fallback',
      title: '账号回退',
      render: (_, row) =>
        t(
          row.upstream_id == null
            ? '自动调度'
            : row.fallback_enabled
              ? '允许回退'
              : '仅绑定账号',
        ),
    },
    {
      key: 'enabled',
      title: '状态',
      render: (_, row) => (
        <StatusBadge tone={row.enabled ? 'success' : 'neutral'} dot>
          {row.enabled ? '已启用' : '已停用'}
        </StatusBadge>
      ),
    },
    ...(can('edit') || can('delete')
      ? [
          {
            key: 'actions',
            title: '操作',
            render: (_, row) => (
              <div className="flex gap-1">
                {can('edit') && (
                  <Button size="sm" variant="ghost" onClick={() => edit(row)}>
                    {t('编辑')}
                  </Button>
                )}
                {can('delete') && !row.enabled && (
                  <ConfirmAction
                    title="删除公开路由？"
                    description="删除不会移除历史请求记录。"
                    onConfirm={() => remove(row)}
                  >
                    <Button size="sm" variant="ghost">
                      {t('删除')}
                    </Button>
                  </ConfirmAction>
                )}
              </div>
            ),
          },
        ]
      : []),
  ]
  const filtered = data.filter((row) =>
    (!enabledFilter || String(row.enabled) === enabledFilter) &&
    `${row.model} ${row.upstream_model || ''} ${row.description || ''}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  )
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / 20)),
  )
  return (
    <>
      <PageHeader
        title="公开路由"
        actions={
          <>
            <Button variant="outline" onClick={reload}>
              {t('刷新')}
            </Button>
            {can('add') && (
              <Button
                disabled={loading || Boolean(error)}
                onClick={() => edit(null)}
              >
                {t('添加公开路由')}
              </Button>
            )}
          </>
        }
      />
      <p className="mb-4 text-sm text-muted-foreground">
        {t(
          '每个对外模型对应一条路由，可自动选择账号，也可绑定账号并设置回退。',
        )}
      </p>
      {accountError && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {t('账号列表未能加载，可刷新重试；仍可查看路由和配置自动账号池。')}
        </p>
      )}
      <div className="mb-4 flex flex-wrap items-end gap-2">
      <label className="flex max-w-sm flex-col gap-2 text-sm">
        {t('搜索公开路由')}
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(1)
          }}
        />
      </label>
      <FilterSelect ariaLabel="状态" placeholder="状态" value={enabledFilter}
        onChange={value => {setEnabledFilter(value);setPage(1)}}
        options={[{label:'已启用',value:'true'},{label:'已停用',value:'false'}]} />
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : (
        <DataTable
          minWidth={820}
          columns={columns}
          data={filtered.slice((currentPage - 1) * 20, currentPage * 20)}
          rowKey="id"
          emptyDescription={search || enabledFilter ? '暂无匹配结果，请调整筛选条件。' : '先添加模型服务，再配置对外模型。'}
          loading={loading}
          pagination={{
            page: currentPage,
            perPage: 20,
            total: filtered.length,
            onChange: setPage,
          }}
        />
      )}
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !busy.current) setEditing(null)
        }}
        title={editing?.id ? '编辑公开路由' : '添加公开路由'}
        description="设置客户端模型名称与上游账号的对应关系。"
        form={form}
        onSubmit={save}
      >
        <FormInput
          control={form.control}
          name="model"
          label="对外模型"
          rules={{
            required: t('请输入模型名称'),
            maxLength: {
              value: 128,
              message: t('模型名称不能超过 128 个字符'),
            },
            validate: (value) => Boolean(value?.trim()) || t('请输入模型名称'),
          }}
        />
        <FormInput
          control={form.control}
          name="upstream_model"
          label="上游模型"
          description="留空时使用对外模型名称；coati-auto 必须填写实际模型。"
          rules={{
            maxLength: {
              value: 128,
              message: t('模型名称不能超过 128 个字符'),
            },
            validate: (value) =>
              form.getValues('model')?.trim() !== 'coati-auto' ||
              Boolean(value?.trim()) ||
              t('自动路由必须配置实际模型'),
          }}
        />
        <FormSelect
          control={form.control}
          name="upstream_id"
          label="绑定账号"
          placeholder="自动账号池"
          clearable
          options={options}
          disabled={accountError}
        />
        {!bound && (
          <p className="text-sm text-muted-foreground">
            {t('从声明支持目标模型的账号中选择，优先级越大越优先。')}
          </p>
        )}
        {selected && (
          <p className="break-words text-sm text-muted-foreground">
            {t('账号支持模型')}：
            {selected.supported_models?.join(', ') || t('未配置')}
          </p>
        )}
        {bound && (
          <>
            <FormSwitch
              control={form.control}
              name="fallback_enabled"
              label="允许回退"
              description="绑定账号不可用或发生可重试错误时，使用支持同一实际模型的其他账号。"
            />
            <FormInput
              control={form.control}
              name="upstream_base"
              label="路由上游地址覆盖"
              description="留空使用账号地址；只能修改同源路径，不能更换域名、协议或端口。"
            />
          </>
        )}
        <FormInput
          control={form.control}
          name="vision_model"
          label="含图模型（仅 coati-auto 使用）"
          rules={{
            maxLength: {
              value: 128,
              message: t('模型名称不能超过 128 个字符'),
            },
          }}
        />
        <FormInput
          control={form.control}
          name="description"
          label="路由说明"
          rules={{
            maxLength: { value: 255, message: t('说明不能超过 255 个字符') },
          }}
        />
        <FormSwitch control={form.control} name="enabled" label="启用路由" />
        <p className="text-sm text-muted-foreground">
          {t('同名旧路由不能直接覆盖；删除公开路由前须先停用。')}
        </p>
      </FormDialog>
    </>
  )
}
