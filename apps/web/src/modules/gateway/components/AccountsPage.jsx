import AccountModels from '@/modules/gateway/components/AccountModels'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Plus, RefreshCw } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import PageHeader from '@/shared/components/PageHeader'
import DataTable from '@/shared/components/DataTable'
import { FormDialog } from '@/shared/components/FormDialog'
import {
  FormInput,
  FormNumber,
  FormSelect,
  FormSwitch,
  FormTextarea,
} from '@/shared/components/FormFields'
import ConfirmAction from '@/shared/components/ConfirmAction'
import StatusBadge from '@/shared/components/StatusBadge'
import { SearchInput, FilterSelect } from '@/shared/components/Filters'
import AccountHealth from '@/modules/gateway/components/AccountHealth'
import { accountBody, accountDefaults, accountValues } from '@/modules/gateway/components/account-form'
import {
  listGateway,
  saveGateway,
  checkAccount,
  discoverAccountModels,
  deleteAccount,
  copyAccount,
} from '@/modules/gateway/api/gateway'
import { toast, errorMessage } from '@/lib/toast'
const protocols = [
  { label: 'OpenAI Chat Completions', value: 'openai' },
  { label: 'OpenAI Responses', value: 'responses' },
  { label: 'Anthropic Messages', value: 'anthropic' },
]
const legacyProtocols = {
  openai: 'openai-chat',
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
}
export default function AccountsPage({ personal = false }) {
  const { t } = useTranslation(),
    { hasPermission } = useAuth()
  const resource = personal ? 'my-channels' : 'upstreams'
  const permission = personal ? 'gateway_my_channels' : 'gateway_upstreams'
  const can = (action) => hasPermission(`${permission}_${action}`)
  const canProbe = can('test')
  const [items, setItems] = useState([]),
    [summary, setSummary] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('')
  const [protocolFilter, setProtocolFilter] = useState('')
  const [healthFilter, setHealthFilter] = useState('')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState(''),
    [open, setOpen] = useState(false),
    [editing, setEditing] = useState(null),
    [busy, setBusy] = useState(null)
  const [discovering, setDiscovering] = useState(false),
    [discovered, setDiscovered] = useState(null),
    [formError, setFormError] = useState('')
  const loadVersion = useRef(0),
    dialogVersion = useRef(0),
    mutation = useRef(false)
  const form = useForm({ defaultValues: accountDefaults })
  const proxyMode = useWatch({ control: form.control, name: 'proxy_mode' })
  const load = useCallback(async () => {
    const version = ++loadVersion.current
    setLoading(true)
    try {
      const result = await listGateway(resource, { per_page: 100 })
      if (version !== loadVersion.current) return
      setItems(result.items)
      setSummary(result.summary)
      setError('')
    } catch (err) {
      if (version === loadVersion.current) setError(err.message || '加载失败')
    } finally {
      if (version === loadVersion.current) setLoading(false)
    }
  }, [resource])
  useEffect(() => {
    const requests = loadVersion,
      dialogs = dialogVersion
    const timer = setTimeout(() => {
      void load()
    }, 0)
    return () => {
      clearTimeout(timer)
      requests.current++
      dialogs.current++
    }
  }, [load])
  const changeOpen = (value) => {
    dialogVersion.current++
    setOpen(value)
    setDiscovering(false)
    if (!value) form.reset(accountDefaults)
  }
  const edit = (row) => {
    dialogVersion.current++
    setEditing(row || null)
    form.reset(accountValues(row))
    setFormError('')
    setDiscovered(null)
    setDiscovering(false)
    setOpen(true)
  }
  const save = async (values) => {
    try {
      setFormError('')
      const result = await saveGateway(
        resource,
        accountBody(values, personal),
        editing?.id,
      )
      changeOpen(false)
      toast.success(
        result.health_probe?.ok === false
          ? '已保存；自动探测未验证成功，可稍后重试'
          : '已保存',
      )
      await load()
    } catch (err) {
      setFormError(err.message || '保存失败')
      throw err
    }
  }
  const action = async (row, kind) => {
    if (mutation.current) return
    mutation.current = true
    setBusy(row.id)
    try {
      if (kind === 'check') {
        const result = await checkAccount(personal, row.id)
        toast.success(
          result.verified
            ? '模型列表可用，已完成检查'
            : result.message || '未验证对话可用性',
        )
      } else if (kind === 'copy') {
        await copyAccount(row.id)
        toast.success('已复制，健康状态从未验证开始')
      } else {
        await deleteAccount(personal, row.id)
        toast.success('已删除')
      }
      await load()
    } catch (err) {
      toast.apiError(err, '操作失败')
      throw err
    } finally {
      mutation.current = false
      setBusy(null)
    }
  }
  const discover = async () => {
    const version = dialogVersion.current,
      snapshot = JSON.stringify(form.getValues())
    setDiscovering(true)
    setFormError('')
    try {
      const body = accountBody(form.getValues(), personal)
      const request = {
        base_url: body.base_url,
        upstream_protocol: legacyProtocols[body.protocol],
        extra_headers: body.extra_headers,
        request_timeout_seconds: body.request_timeout_seconds,
        ...(body.api_key ? { api_key: body.api_key } : {}),
        ...(editing ? { credential_id: editing.id } : {}),
        ...(Object.hasOwn(body, 'proxy_url')
          ? { proxy_url: body.proxy_url }
          : {}),
      }
      const result = await discoverAccountModels(personal, request)
      if (version !== dialogVersion.current) return
      if (snapshot !== JSON.stringify(form.getValues())) {
        setFormError('配置已变化，请重新发现模型')
        return
      }
      setDiscovered(result.models)
    } catch (err) {
      if (version === dialogVersion.current)
        setFormError(errorMessage(err, '模型发现失败'))
    } finally {
      if (version === dialogVersion.current) setDiscovering(false)
    }
  }
  const filtered = items.filter((row) =>
    (!protocolFilter || row.protocol === protocolFilter) &&
    (!healthFilter || (row.health_status || 'unknown') === healthFilter) &&
    [row.name, row.base_url, row.model_prefix, ...(row.supported_models || [])]
      .join(' ')
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 20)))
  const columns = [
    {
      key: 'name',
      title: personal ? '渠道名称' : '服务名称',
      render: (_, row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-muted-foreground">
            {protocols.find((p) => p.value === row.protocol)?.label}
          </p>
        </div>
      ),
    },
    {
      key: 'models',
      title: personal ? '调用模型' : '支持模型',
      render: (_, row) => (
        <div className="max-w-72 break-all text-xs">
          <p>
            {(personal ? row.display_models : row.supported_models)?.join(
              ', ',
            ) || t('未配置模型')}
          </p>
          <p className="mt-1 text-muted-foreground">{row.base_url}</p>
        </div>
      ),
    },
    {
      key: 'health',
      title: '账号健康',
      render: (_, row) => <AccountHealth account={row} />,
    },
    {
      key: 'connection',
      title: '连接配置',
      render: (_, row) => (
        <div className="text-xs">
          <p>
            {row.request_timeout_seconds} {t('秒超时')}
          </p>
          <p className="text-muted-foreground">
            {row.has_proxy ? row.proxy_hint : t('直连')}
          </p>
        </div>
      ),
    },
    {
      key: 'enabled',
      title: '状态',
      render: (_, row) => (
        <StatusBadge tone={row.enabled ? 'success' : 'neutral'}>
          {t(row.enabled ? '已启用' : '已停用')}
        </StatusBadge>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      align: 'right',
      render: (_, row) => (
        <div className="flex justify-end gap-1">
          {canProbe && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null || !row.enabled}
              onClick={() => action(row, 'check').catch(() => {})}
            >
              {t(busy === row.id ? '处理中' : '检查')}
            </Button>
          )}
          {can('edit') && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => edit(row)}
            >
              {t('编辑')}
            </Button>
          )}
          {!personal && can('add') && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => action(row, 'copy').catch(() => {})}
            >
              {t('复制')}
            </Button>
          )}
          {can('delete') && (
            <ConfirmAction
              title="删除账号配置？"
              description="仅可删除已停用且未被路由或在途请求使用的账号，历史用量记录保留。"
              onConfirm={() => action(row, 'delete')}
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={row.enabled || busy !== null}
                title={row.enabled ? t('请先编辑并停用账号') : undefined}
              >
                {t('删除')}
              </Button>
            </ConfirmAction>
          )}
        </div>
      ),
    },
  ]
  return (
    <>
      <PageHeader
        title={personal ? '个人渠道' : '模型服务'}
        description={
          personal
            ? '仅本人可用，最多 5 条；通过模型前缀区分平台模型。'
            : undefined
        }
        actions={
          <>
            <Button variant="outline" disabled={loading} onClick={load}>
              <RefreshCw className="size-4" />
              {t('刷新')}
            </Button>
            {can('add') && (
              <Button
                variant="brand"
                disabled={personal && (loading || !!error || items.length >= 5)}
                onClick={() => edit()}
              >
                <Plus className="size-4" />
                {t(personal ? '添加个人渠道' : '添加模型服务')}
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={search} onChange={value => { setSearch(value); setPage(1) }} placeholder="搜索名称、模型或地址" />
          <FilterSelect ariaLabel="协议" value={protocolFilter} onChange={value => { setProtocolFilter(value); setPage(1) }} options={protocols} placeholder="协议" className="w-56" />
          <FilterSelect ariaLabel="健康状态" value={healthFilter} onChange={value => { setHealthFilter(value); setPage(1) }} options={[
              {value:'healthy',label:'健康'},{value:'unhealthy',label:'异常'},
              {value:'cooldown',label:'冷却中'},{value:'unknown',label:'未检测'},
            ]} placeholder="健康状态" />
        </div>
        <p className="text-sm text-muted-foreground tabular-nums">
          {filtered.length} / {items.length} {t('条配置')}
          {summary &&
            ` · ${t('健康')} ${summary.healthy} · ${t('异常')} ${summary.unhealthy}`}
        </p>
      </div>
      {error ? (
        <div role="alert" className="py-8 text-danger">
          {error}
          <Button variant="link" onClick={load}>
            {t('重试')}
          </Button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={filtered.slice((currentPage - 1) * 20, currentPage * 20)}
          pagination={{page:currentPage,perPage:20,total:filtered.length,onChange:setPage}}
          loading={loading}
          minWidth={940}
          emptyDescription={
            items.length ? '暂无匹配结果，请调整筛选条件。' : personal
              ? '添加自己的上游账号，通过模型前缀调用。'
              : '添加一个模型服务，开始接入上游。'
          }
        />
      )}
      <FormDialog
        open={open}
        onOpenChange={changeOpen}
        title={
          editing ? '编辑账号' : personal ? '添加个人渠道' : '添加模型服务'
        }
        description="密钥加密保存，编辑时留空可保留原值。"
        form={form}
        onSubmit={save}
      >
        {formError && (
          <p role="alert" className="text-sm text-danger break-all">
            {formError}
          </p>
        )}
        <FormInput
          control={form.control}
          name="name"
          label="名称"
          rules={{ required: '请输入名称', maxLength: 100 }}
        />
        <FormSelect
          control={form.control}
          name="protocol"
          label="协议"
          options={protocols}
        />
        <FormInput
          control={form.control}
          name="base_url"
          label="API 基础地址"
          placeholder="https://api.example.com/v1"
          rules={{ required: '请输入地址' }}
        />
        <FormInput
          control={form.control}
          name="api_key"
          label="上游 API Key"
          type="password"
          autoComplete="new-password"
          rules={{ required: editing ? false : '请输入密钥' }}
        />
        {personal && (
          <FormInput
            control={form.control}
            name="model_prefix"
            label="模型前缀"
            description="例如 my：模型将以 my/模型名 提供，调用时自动去掉前缀。"
            rules={{
              required: '请输入模型前缀',
              maxLength: 64,
              validate: (value) =>
                !/[\s\\]/u.test(value) || '前缀不能包含空白或反斜杠',
            }}
          />
        )}
        <AccountModels form={form} discovered={discovered} discovering={discovering}
          discover={discover} canDiscover={canProbe} />
        <details className="space-y-4 border-t pt-4">
          <summary className="cursor-pointer text-sm font-medium">
            {t('连接与调度设置')}
          </summary>
          {!personal && (
            <FormInput
              control={form.control}
              name="provider"
              label="供应商分类"
              description="仅用于画像与用量分类，请求格式由协议决定。"
            />
          )}
          <FormNumber
            control={form.control}
            name="request_timeout_seconds"
            label="请求超时（秒）"
            min={5}
            max={300}
            rules={{ required: true, min: 5, max: 300 }}
          />
          <FormSelect
            control={form.control}
            name="proxy_mode"
            label="出站代理"
            options={[
              {
                value: 'keep',
                label: editing?.has_proxy ? '保留现有代理' : '保持直连',
              },
              { value: 'replace', label: '设置新代理' },
              { value: 'clear', label: '清除代理，改为直连' },
            ]}
          />
          {editing?.has_proxy && (
            <p className="text-xs text-muted-foreground break-all">
              {t('当前代理')}：{editing.proxy_hint}
            </p>
          )}
          {proxyMode === 'replace' && (
            <FormInput
              control={form.control}
              name="proxy_url"
              label="代理地址"
              type="password"
              autoComplete="new-password"
              placeholder="http://user:password@proxy:8080"
              rules={{ required: '请输入新的代理地址' }}
            />
          )}
          <FormTextarea
            control={form.control}
            name="extra_headers"
            label="自定义请求头（JSON）"
            description={'例如 {"X-Tenant": "team"}。不能覆盖鉴权头。'}
            rows={4}
          />
          <FormNumber
            control={form.control}
            name="priority"
            label="账号优先级"
            description="数值越大越优先。"
            min={1}
            max={1000}
            rules={{ required: true, min: 1, max: 1000 }}
          />
          <FormNumber
            control={form.control}
            name="weight"
            label="调度权重"
            min={1}
            max={10000}
            rules={{ required: true, min: 1, max: 10000 }}
          />
          <FormNumber
            control={form.control}
            name="concurrency_limit"
            label="账号并发上限"
            min={1}
            max={1000}
            rules={{ required: true, min: 1, max: 1000 }}
          />
        </details>
        <FormTextarea
          control={form.control}
          name="note"
          label="备注"
          rules={{ maxLength: 255 }}
        />
        <FormSwitch control={form.control} name="enabled" label="启用服务" />
      </FormDialog>
    </>
  )
}
