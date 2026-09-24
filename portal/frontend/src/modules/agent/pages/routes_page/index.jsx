import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Banner, Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import { IconArrowRight, IconPlus, IconRefresh, IconSearch } from '@douyinfe/semi-icons'
import { useAuth } from '@/context/AuthContext'
import { listCredentials } from '@/modules/agent/api/credentials'
import { createRoute, deleteRoute, listRoutes, updateRoute } from '@/modules/agent/api/routes'
import { AgentPage } from '@/modules/agent/components/AgentPage'
import { formatNumber, formatTime, formatTokenCount } from '@/modules/agent/utils'
import './routes-page.css'

const PROTOCOL_LABELS = {
  'openai-chat': 'OpenAI Chat Completions',
  'anthropic-messages': 'Anthropic Messages',
  'openai-responses': 'OpenAI Responses',
}

const healthMeta = (credential) => {
  if (!credential) return { label: '自动选择', color: 'blue' }
  if (!credential.enabled) return { label: 'Key 已停用', color: 'grey' }
  if (credential.health_status === 'healthy') return { label: '健康', color: 'green' }
  if (credential.health_status === 'cooldown') return { label: '冷却中', color: 'orange' }
  if (credential.health_status === 'unhealthy') return { label: '异常', color: 'red' }
  return { label: '未检测', color: 'light-blue' }
}

export default function AgentRoutesPage() {
  const { hasPermission } = useAuth()
  const [data, setData] = useState({ items: [], total: 0 })
  const [credentials, setCredentials] = useState([])
  const [query, setQuery] = useState({ page: 1, per_page: 20, search: '', enabled: '' })
  const [loading, setLoading] = useState(true)
  const [visible, setVisible] = useState(false)
  const [editing, setEditing] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const formApiRef = useRef()

  const load = useCallback(() => {
    setLoading(true)
    listRoutes(query).then(setData).catch((error) => Toast.error(error?.error || '加载模型路由失败')).finally(() => setLoading(false))
  }, [query])
  const loadCredentials = useCallback(() => {
    listCredentials({ page: 1, per_page: 100 }).then((result) => setCredentials(result.items || [])).catch(() => setCredentials([]))
  }, [])
  useEffect(() => {
    let cancelled = false
    listRoutes(query)
      .then((result) => { if (!cancelled) setData(result) })
      .catch((error) => { if (!cancelled) Toast.error(error?.error || '加载模型路由失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [query])
  useEffect(() => { loadCredentials() }, [loadCredentials])

  const updateQuery = (patch) => {
    setLoading(true)
    setQuery((current) => ({ ...current, ...patch }))
  }

  const credentialOptions = useMemo(() => [
    { label: '自动选择（按模型、优先级与权重）', value: 0 },
    ...credentials.map((item) => ({
      label: `${item.name} · ${PROTOCOL_LABELS[item.upstream_protocol] || item.upstream_protocol} · ${item.default_model}${item.enabled ? '' : ' · 已停用'}`,
      value: item.id,
      disabled: !item.enabled,
    })),
  ], [credentials])
  const normalizedValues = (values) => ({
    model_name: values.model_name,
    upstream_model: values.upstream_model || null,
    vision_model: values.vision_model || null,
    credential_id: values.credential_id || null,
    description: values.description || null,
    fallback_enabled: values.fallback_enabled === true,
    enabled: values.enabled !== false,
  })

  const save = async () => {
    let values
    try {
      values = await formApiRef.current.validate()
    } catch {
      return
    }
    const task = editing ? updateRoute(editing.id, normalizedValues(values)) : createRoute(normalizedValues(values))
    setSubmitting(true)
    task
      .then(() => { Toast.success('模型路由已保存'); setVisible(false); load() })
      .catch((error) => Toast.error(error?.error || '保存失败'))
      .finally(() => setSubmitting(false))
  }

  const openCreate = () => { setEditing(null); setVisible(true) }
  const openEdit = (row) => { setEditing(row); setVisible(true) }

  const columns = [
    {
      title: '模型路由', width: 320,
      render: (_, row) => <div><div className="route-model-flow"><Typography.Text strong>{row.model_name}</Typography.Text><IconArrowRight /><Typography.Text>{row.effective_model}</Typography.Text></div>{row.description && <Typography.Text type="tertiary" size="small" ellipsis={{ showTooltip: true }} style={{ display: 'block', maxWidth: 300 }}>{row.description}</Typography.Text>}</div>,
    },
    {
      title: '使用账号', width: 220,
      render: (_, row) => row.credential ? <div><div>{row.credential.name}</div><Typography.Text type="tertiary" size="small">{PROTOCOL_LABELS[row.credential.upstream_protocol] || row.credential.upstream_protocol}</Typography.Text></div> : <div><div>自动选择</div><Typography.Text type="tertiary" size="small">按模型、接口兼容性和健康状态匹配</Typography.Text></div>,
    },
    {
      title: '就绪状态', width: 190,
      render: (_, row) => { const meta = healthMeta(row.credential); return <div><Space spacing={4}><Tag color={row.enabled ? 'green' : 'grey'}>{row.enabled ? '生效' : '停用'}</Tag><Tag color={meta.color}>{meta.label}</Tag></Space>{row.warnings?.[0] && <Typography.Text type="warning" size="small" ellipsis={{ showTooltip: true }} style={{ display: 'block', maxWidth: 180, marginTop: 4 }}>{row.warnings[0]}</Typography.Text>}</div> },
    },
    { title: '失败处理', width: 150, render: (_, row) => row.credential_id ? <Tag color={row.fallback_enabled ? 'blue' : 'grey'}>{row.fallback_enabled ? '切换备用账号' : '不切换'}</Tag> : <Tag color="blue">自动切换</Tag> },
    {
      title: '近 7 天', width: 150,
      render: (_, row) => <div><div>{formatNumber(row.usage_7d?.requests)} 次</div><Typography.Text type="tertiary" size="small">{formatTokenCount(row.usage_7d?.tokens)} 计费 Token</Typography.Text></div>,
    },
    { title: '最近命中', width: 170, render: (_, row) => row.usage_7d?.last_used_at ? formatTime(row.usage_7d.last_used_at) : '—' },
    {
      title: '操作', width: 210, fixed: 'right', render: (_, row) => <Space>
        {hasPermission('agent_routes_edit') && <><Button theme="borderless" onClick={() => openEdit(row)}>编辑</Button><Switch size="small" checked={row.enabled} onChange={(enabled) => updateRoute(row.id, { enabled }).then(load).catch((error) => Toast.error(error?.error || '状态更新失败'))} /></>}
        {hasPermission('agent_routes_delete') && <Popconfirm title="确认删除该模型路由？" onConfirm={() => deleteRoute(row.id).then(load).catch((error) => Toast.error(error?.error || '删除失败'))}><Button theme="borderless" type="danger" disabled={row.enabled !== false} title={row.enabled !== false ? '生效中的模型路由不能删除，请先停用' : undefined}>删除</Button></Popconfirm>}
      </Space>,
    },
  ]

  return <AgentPage
    title="模型路由"
    description="只有需要固定入口名称或替换上游模型时才需要配置；直接使用上游模型名时无需新增。"
    actions={<><Button icon={<IconRefresh />} onClick={() => { load(); loadCredentials() }}>刷新</Button>{hasPermission('agent_routes_add') && <Button theme="solid" icon={<IconPlus />} onClick={openCreate}>新增别名</Button>}</>}
    filters={<>
      <Input prefix={<IconSearch />} placeholder="搜索别名或上游模型" value={query.search} onChange={(search) => updateQuery({ search, page: 1 })} style={{ width: 300 }} showClear />
      <Select value={query.enabled} onChange={(enabled) => updateQuery({ enabled, page: 1 })} style={{ width: 130 }} optionList={[{ label: '全部状态', value: '' }, { label: '仅生效', value: 'true' }, { label: '仅停用', value: 'false' }]} />
    </>}
  >
    <Table columns={columns} dataSource={data.items} rowKey="id" loading={loading} scroll={{ x: 1280 }} pagination={{ currentPage: query.page, pageSize: query.per_page, total: data.total, onPageChange: (page) => updateQuery({ page }) }} />
    <Modal
      title={editing ? '编辑模型路由' : '新增模型路由'}
      visible={visible}
      onOk={save}
      okText={editing ? '保存修改' : '确认新增'}
      onCancel={() => setVisible(false)}
      okButtonProps={{ loading: submitting }}
      cancelButtonProps={{ disabled: submitting }}
      maskClosable={!submitting}
      width="min(720px, calc(100vw - 24px))"
      afterClose={() => { formApiRef.current?.reset(); setEditing(null) }}
    >
      <Banner className="agent-form-tip" type="info" fullMode={false} icon={null} description={<>例如把员工使用的 <code>coati-coding</code> 映射到一个实际上游模型。模型名称填 <code>coati-auto</code> 即为自动路由：纯文本走「实际模型」，带图自动走「含图时模型」。</>} />
      <Form
        key={editing?.id || 'new'}
        className="agent-modal-form"
        getFormApi={(api) => { formApiRef.current = api }}
        initValues={editing ? { ...editing, credential_id: editing.credential_id || 0 } : { enabled: true, fallback_enabled: false, credential_id: 0 }}
        labelPosition="top"
      >
        <div className="agent-form-grid">
          <Form.Input field="model_name" label="对外模型名" placeholder="例如：coati-coding" rules={[{ required: true, message: '请输入模型名称' }]} />
          <Form.Input field="upstream_model" label="实际模型" placeholder="填写上游实际模型名" rules={[{ required: true, message: '请输入实际上游模型' }]} />
          <div className="agent-form-grid__full"><Form.Select field="credential_id" label="使用账号" optionList={credentialOptions} style={{ width: '100%' }} /></div>
          <div className="agent-form-grid__full"><Form.Input field="vision_model" label="含图时模型（仅 coati-auto）" placeholder="填写视觉模型名（可选）" extraText="模型名称为 coati-auto 时生效：带图请求自动路由到该视觉模型，纯文本走「实际模型」。" /></div>
          <div className="agent-form-grid__full"><Form.TextArea field="description" label="说明（可选）" placeholder="例如：团队默认编码模型" rows={2} maxCount={255} /></div>
          <Form.Switch field="fallback_enabled" label="固定账号不可用时切换备用账号" />
          <Form.Switch field="enabled" label="启用" />
        </div>
      </Form>
    </Modal>
  </AgentPage>
}
