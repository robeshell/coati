import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useState } from 'react'
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
import { SearchInput } from '@/shared/components/Filters'
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
      base_url: 'https://api.openai.com/v1',
      api_key: '',
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
      daily_limit: 100000,
      concurrency_limit: 10,
      rpm_limit: 60,
      expires_days: 30,
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
    [open, setOpen] = useState(false),
    [editing, setEditing] = useState(null),
    [token, setToken] = useState('')
  const can = (action) => hasPermission(`gateway_${resource}_${action}`)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await listGateway(resource)
      setItems(r.items)
      setError('')
    } catch (err) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [resource])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (resource === 'routes')
      listGateway('upstreams')
        .then((r) => setUpstreams(r.items))
        .catch((err) => toast.apiError(err, '模型服务加载失败'))
  }, [resource])
  const edit = (row) => {
    setEditing(row || null)
    form.reset(row ? { ...row, api_key: '' } : spec.defaults)
    setOpen(true)
  }
  const save = async (values) => {
    try {
      const body = { ...values }
      if (resource === 'keys')
        body.models = values.models
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      if (resource === 'upstreams' && !body.api_key) delete body.api_key
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
    width: 150,
    render: (_, row) => (
      <div className="flex justify-end gap-1">
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
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="搜索名称、模型或地址"
        />
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
          data={items.filter((x) =>
            JSON.stringify(x).toLowerCase().includes(search.toLowerCase()),
          )}
          loading={loading}
          emptyDescription={
            resource === 'upstreams'
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
              : '密钥仅展示一次。每日配额按 UTC 日期统计，0 表示不限。'
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
              label="每日 Token 配额"
              min={0}
              step={1}
            />
            <FormNumber
              control={form.control}
              name="concurrency_limit"
              label="最大并发请求"
              min={1}
              step={1}
            />
            <FormNumber
              control={form.control}
              name="rpm_limit"
              label="每分钟请求上限"
              min={1}
              step={1}
            />
            <FormNumber
              control={form.control}
              name="expires_days"
              label="有效天数"
              min={1}
              max={365}
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
