import KeyActions from '@/modules/gateway/components/KeyActions'
import ProbeAccount from '@/modules/gateway/components/ProbeAccount'
import AccountHealth from '@/modules/gateway/components/AccountHealth'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Plus, RefreshCw, Copy } from 'lucide-react'
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
  FormSwitch,
} from '@/shared/components/FormFields'
import ConfirmAction from '@/shared/components/ConfirmAction'
import StatusBadge from '@/shared/components/StatusBadge'
import { SearchInput, FilterSelect } from '@/shared/components/Filters'
import { toast } from '@/lib/toast'
import {
  listGateway,
  saveGateway,
  disableGateway,
} from '@/modules/gateway/api/gateway'
const protocols = [
  { label: 'OpenAI Chat Completions', value: 'openai' },
  { label: 'Anthropic Messages', value: 'anthropic' },
  { label: 'OpenAI Responses', value: 'responses' },
]
const specs = {
  upstreams: {
    title: '模型服务',
    create: '添加模型服务',
    defaults: {
      name: '',
      protocol: 'openai',
      provider: 'openai-compatible',
      supported_models: '',
      default_model: '',
      base_url: 'https://api.openai.com/v1',
      api_key: '',
      concurrency_limit: 10,
      weight: 1,
      priority: 100,
      enabled: true,
    },
  },
  routes: {
    title: '模型与路由',
    create: '添加模型路由',
    defaults: {
      model: '',
      upstream_id: null,
      upstream_model: '',
      description: '',
      upstream_base: '',
      vision_model: '',
      priority: 100,
      enabled: true,
    },
  },
  keys: {
    title: '访问与授权',
    create: '创建访问密钥',
    defaults: {
      name: '',
      kind: 'personal',
      models: '*',
      daily_limit: 0,
      concurrency_limit: 0,
      rpm_limit: 0,
      expires_days: 0,
    },
  },
}
export default function ResourcePage({ resource }) {
  const { t } = useTranslation()

  const spec = specs[resource],
    form = useForm({ defaultValues: spec.defaults }),
    { hasPermission } = useAuth()
  const [items, setItems] = useState([]),
    [upstreams, setUpstreams] = useState([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [search, setSearch] = useState(''),
    [kindFilter, setKindFilter] = useState(''),
    [page, setPage] = useState(1),
    [open, setOpen] = useState(false),
    [editing, setEditing] = useState(null),
    [token, setToken] = useState('')
  const loadVersion = useRef(0)
  const can = (action) => hasPermission(`gateway_${resource}_${action}`)
  const load = useCallback(async () => {
    const current = ++loadVersion.current
    setLoading(true)
    try {
      const r = await listGateway(resource)
      if (current !== loadVersion.current) return
      setItems(r.items)
      setError('')
    } catch (err) {
      if (current === loadVersion.current) setError(err.message || '加载失败')
    } finally {
      if (current === loadVersion.current) setLoading(false)
    }
  }, [resource])
  useEffect(() => {
    const version = loadVersion
    void load()
    return () => { version.current++ }
  }, [load])
  useEffect(() => {
    if (resource === 'routes')
      listGateway('upstreams')
        .then((r) => setUpstreams(r.items))
        .catch((err) => toast.apiError(err, '模型服务加载失败'))
  }, [resource])
  const edit = (row) => {
    setEditing(row || null)
    form.reset(
      row
        ? {
            ...row,
            api_key: '',
            ...(resource === 'upstreams'
              ? { supported_models: (row.supported_models || []).join(', ') }
              : {}),
          }
        : spec.defaults,
    )
    setOpen(true)
  }
  const save = async (values) => {
    try {
      const body = { ...values }
      if (resource === 'keys') {
        body.expires_days = values.expires_days ? Number(values.expires_days) : null
        body.models = values.models
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      }
      if (resource === 'upstreams') {
        body.supported_models = values.supported_models
          .split(/[,，\n]/)
          .map((x) => x.trim())
          .filter(Boolean)
        if (!body.api_key) delete body.api_key
      }
      const r = await saveGateway(resource, body, editing?.id)
      setOpen(false)
      if (r.token) setToken(r.token)
      toast.success('已保存')
      await load()
    } catch (err) {
      toast.apiError(err, '保存失败')
      throw err
    }
  }
  const disable = async (row) => {
    try {
      await disableGateway(resource, row.id)
      await load()
      toast.success(resource === 'keys' ? '密钥已吊销' : '已停用')
    } catch (err) {
      toast.apiError(err, '操作失败')
      throw err
    }
  }
  const state = (v) => (
    <StatusBadge tone={v ? 'success' : 'neutral'} dot>
      {v ? '已启用' : '已停用'}
    </StatusBadge>
  )
  const cols =
    resource === 'upstreams'
      ? [
          { key: 'name', title: '服务名称', dataIndex: 'name' },
          { key: 'provider', title: '供应商分类', dataIndex: 'provider' },
          { key: 'health', title: '账号健康', render: (_, row) => <AccountHealth account={row} /> },
          { key: 'concurrency_limit', title: '账号并发上限', dataIndex: 'concurrency_limit', align: 'right' },
          { key: 'account_priority', title: '账号优先级', dataIndex: 'priority', align: 'right' },
          { key: 'weight', title: '调度权重', dataIndex: 'weight', align: 'right' },
          {
            key: 'protocol',
            title: '协议',
            dataIndex: 'protocol',
            render: (v) => protocols.find((p) => p.value === v)?.label,
          },
          {
            key: 'base_url',
            title: '服务地址',
            dataIndex: 'base_url',
            ellipsis: true,
          },
          {
            key: 'enabled',
            title: '状态',
            dataIndex: 'enabled',
            render: state,
          },
        ]
      : resource === 'routes'
        ? [
            { key: 'model', title: '对外模型', dataIndex: 'model' },
            {
              key: 'upstream',
              title: '模型服务',
              dataIndex: 'upstream_id',
              render: (v) => upstreams.find((x) => x.id === v)?.name || v,
            },
            {
              key: 'upstream_model',
              title: '上游模型',
              dataIndex: 'upstream_model',
            },
            {
              key: 'priority',
              title: '优先级',
              dataIndex: 'priority',
              align: 'right',
            },
            {
              key: 'enabled',
              title: '状态',
              dataIndex: 'enabled',
              render: state,
            },
          ]
        : [
            { key: 'name', title: '密钥名称', dataIndex: 'name' },
            {
              key: 'prefix',
              title: '密钥前缀',
              dataIndex: 'prefix',
              render: (v) => <code>{v}…</code>,
            },
            {
              key: 'kind',
              title: '用途',
              dataIndex: 'kind',
              render: (v) =>
                ({ personal: '个人', application: '应用', device: '设备授权' })[
                  v
                ],
            },
            {
              key: 'models',
              title: '模型权限',
              dataIndex: 'models',
              render: (v) => v.join(', '),
            },
            {
              key: 'daily_limit',
              title: '每日 Token 配额',
              dataIndex: 'daily_limit',
              align: 'right',
              render: (v) => (v ? v.toLocaleString() : '不限'),
            },
            {
              key: 'revoked',
              title: '状态',
              render: (_, r) => (
                <StatusBadge
                  tone={
                    r.revoked
                      ? 'neutral'
                      : Date.parse(r.expires_at) <= Date.now()
                        ? 'warning'
                        : 'success'
                  }
                  dot
                >
                  {r.revoked
                    ? '已吊销'
                    : Date.parse(r.expires_at) <= Date.now()
                      ? '已过期'
                      : '有效'}
                </StatusBadge>
              ),
            },
          ]
  cols.push({
    key: 'actions',
    title: '操作',
    width: resource === 'routes' ? 150 : 260,
    render: (_, row) => (
      <div className="flex justify-end gap-1">
        {resource === 'keys' && <KeyActions record={row} canEdit={can('edit')} canRotate={can('rotate')} onToken={setToken} onComplete={load} />}
        {resource === 'upstreams' && can('test') && <ProbeAccount account={row} onComplete={load} />}
        {resource !== 'keys' && can('edit') && (
          <Button size="sm" variant="ghost" onClick={() => edit(row)}>
            {t('编辑')}
          </Button>
        )}
        {can('delete') && !(resource === 'keys' && row.revoked) && (
          <ConfirmAction
            title={resource === 'keys' ? '吊销这把访问密钥？' : '停用此配置？'}
            description={
              resource === 'keys'
                ? '使用这把密钥的新请求将立即被拒绝。'
                : '已有记录保留，新的请求不再使用此配置。'
            }
            onConfirm={() => disable(row)}
          >
            <Button variant="ghost" size="sm">
              {t(resource === 'keys' ? '吊销' : '停用')}
            </Button>
          </ConfirmAction>
        )}
      </div>
    ),
  })
  const filtered = items.filter(row => (resource !== 'keys' || !kindFilter || row.kind === kindFilter) &&
    JSON.stringify(row).toLowerCase().includes(search.toLowerCase()))
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 20)))
  return (
    <>
      <PageHeader
        title={spec.title}
        actions={
          <>
            <Button variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className="size-4" />
              {t('刷新')}
            </Button>
            {can('add') && (
              <Button variant="brand" onClick={() => edit()}>
                <Plus className="size-4" />
                {t(spec.create)}
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={search} onChange={value => {setSearch(value);setPage(1)}} placeholder="搜索名称、模型或地址" />
          {resource === 'keys' && <FilterSelect ariaLabel="类型" placeholder="类型" value={kindFilter}
            onChange={value => {setKindFilter(value);setPage(1)}}
            options={[{label:'个人',value:'personal'},{label:'应用',value:'application'},{label:'设备授权',value:'device'}]} />}
        </div>
        <span className="text-muted-foreground text-sm">
          {items.length}
          {t('条配置')}
        </span>
      </div>
      {error ? (
        <div role="alert" className="text-danger py-8">
          {error}
          <Button variant="link" onClick={load}>
            {t('重试')}
          </Button>
        </div>
      ) : (
        <DataTable
          columns={cols}
          data={filtered.slice((currentPage - 1) * 20, currentPage * 20)}
          pagination={{page:currentPage,perPage:20,total:filtered.length,onChange:setPage}}
          loading={loading}
          emptyDescription={
            items.length ? '暂无匹配结果，请调整筛选条件。' : resource === 'upstreams'
              ? '添加一个模型服务，开始接入上游。'
              : resource === 'routes'
                ? '先添加模型服务，再配置对外模型。'
                : '创建密钥，供应用或 AI 工具调用网关。'
          }
        />
      )}
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={editing ? '编辑配置' : spec.create}
        description={
          resource === 'upstreams'
            ? '密钥加密保存，编辑时留空可保留原值。'
            : resource === 'routes'
              ? '优先级数字越小越优先；相同对外模型可配置多个上游。'
              : '密钥仅展示一次。每日配额按网关业务时区统计，默认 Asia/Shanghai，0 表示不限。'
        }
        form={form}
        onSubmit={save}
      >
        {resource !== 'routes' && (
          <FormInput
            control={form.control}
            name="name"
            label="名称"
            rules={{ required: '请输入名称' }}
          />
        )}
        {resource === 'upstreams' && (
          <>
            <FormNumber control={form.control} name="weight" label="调度权重" min={1} max={10000} rules={{required:true,min:1,max:10000}} />
            <FormNumber control={form.control} name="concurrency_limit" label="账号并发上限" min={1} max={1000} rules={{ required: true, min: 1, max: 1000 }} />
            <FormInput
              control={form.control}
              name="provider"
              label="供应商分类"
              description="仅用于画像与用量分类，请求格式由协议决定。"
              rules={{ required: true, maxLength: 64 }}
            />
            <FormSelect
              control={form.control}
              name="protocol"
              label="协议"
              options={protocols}
            />
            <FormNumber control={form.control} name="priority" label="账号优先级" description="用于自动账号池，数值越大越优先。" min={1} max={1000} rules={{required:true,min:1,max:1000,validate:value=>Number.isInteger(value)||t('请输入整数')}} />
            <FormInput
              control={form.control}
              name="supported_models"
              label="账号支持模型"
              description="填写实际上游模型，以逗号分隔；模型探测不会自动修改此配置。"
            />
            <FormInput
              control={form.control}
              name="default_model"
              label="账号默认模型"
              description="可留空；填写后自动计入账号支持模型。"
            />
            <FormInput
              control={form.control}
              name="base_url"
              label="API 基础地址"
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
            <FormSwitch
              control={form.control}
              name="enabled"
              label="启用服务"
            />
          </>
        )}
        {resource === 'routes' && (
          <>
            <FormInput
              control={form.control}
              name="model"
              label="对外模型名称"
              rules={{ required: '请输入对外模型名称' }}
            />
            <FormSelect
              control={form.control}
              name="upstream_id"
              label="模型服务"
              options={upstreams.map((x) => ({ label: x.name, value: x.id }))}
              rules={{ required: '请选择服务' }}
            />
            <FormInput
              control={form.control}
              name="upstream_model"
              label="上游实际模型名称"
              rules={{ required: '请输入上游模型名称' }}
            />
            <FormInput
              control={form.control}
              name="description"
              label="路由说明"
              rules={{ maxLength: 255 }}
            />
            <FormInput
              control={form.control}
              name="upstream_base"
              label="路由上游地址覆盖"
              description="留空使用账号地址；只能修改同源路径，不能更换域名、协议或端口。"
            />
            <FormInput
              control={form.control}
              name="vision_model"
              label="含图模型（仅 coati-auto 使用）"
            />
            <FormNumber
              control={form.control}
              name="priority"
              label="优先级"
              min={0}
              step={1}
            />
            <FormSwitch
              control={form.control}
              name="enabled"
              label="启用路由"
            />
          </>
        )}
        {resource === 'keys' && (
          <>
            <FormSelect
              control={form.control}
              name="kind"
              label="用途"
              options={[
                { label: '个人使用', value: 'personal' },
                { label: '应用接入', value: 'application' },
              ]}
            />
            <FormInput
              control={form.control}
              name="models"
              label="允许的模型（逗号分隔，* 为全部）"
              rules={{ required: '请指定模型' }}
            />
            <FormNumber
              control={form.control}
              name="daily_limit"
              label="每日 Token 配额（0 不额外限制）"
              min={0}
              step={1}
            />
            <FormNumber
              control={form.control}
              name="concurrency_limit"
              label="最大并发请求（0 不额外限制）"
              min={0}
              step={1}
            />
            <FormNumber
              control={form.control}
              name="rpm_limit"
              label="每分钟请求上限（0 不额外限制）"
              min={0}
              step={1}
            />
            <FormNumber
              control={form.control}
              name="expires_days"
              label="有效天数（0 为不过期）"
              min={0}
              max={3650}
              step={1}
            />
          </>
        )}
      </FormDialog>
      <Dialog
        open={Boolean(token)}
        onOpenChange={(v) => {
          if (!v) setToken('')
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('保存访问密钥')}</DialogTitle>
            <DialogDescription>
              {t('关闭后无法再次查看。请保存在应用的环境变量中。')}
            </DialogDescription>
          </DialogHeader>
          <code className="bg-muted rounded-md p-4 text-sm break-all">
            {token}
          </code>
          <Button
            onClick={() =>
              navigator.clipboard
                .writeText(token)
                .then(() => toast.success('已复制'))
                .catch(() => toast.error('复制失败，请手动复制'))
            }
          >
            <Copy className="size-4" />
            {t('复制密钥')}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
