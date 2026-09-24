import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrayField, Banner, Button, Collapse, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Toast, Tag, Typography,
} from '@douyinfe/semi-ui'
import { IconAlertTriangle, IconKey, IconPlus, IconRefresh, IconSearch, IconSetting, IconTickCircle } from '@douyinfe/semi-icons'
import { useAuth } from '@/context/AuthContext'
import {
  checkCredential,
  copyCredential,
  createCredential,
  deleteCredential,
  discoverCredentialModels,
  listCredentialUpstreamProtocols,
  listCredentials,
  updateCredential,
} from '@/modules/agent/api/credentials'
import { AgentPage, AgentStatCards } from '@/modules/agent/components/AgentPage'
import {
  formatTime,
  USER_AGENT_PRESETS,
  userAgentFromHeaders,
  userAgentPresetFromHeaders,
} from '@/modules/agent/utils'

const EMPTY_SUMMARY = {
  total: 0, enabled: 0, disabled: 0, used: 0, healthy: 0,
  unhealthy: 0, cooling: 0, recovering: 0, unknown: 0,
}

const FALLBACK_PROTOCOLS = [
  { code: 'openai-chat', label: 'OpenAI Chat Completions', description: 'Claude/Responses 请求由网关转换后调用。', endpoint_suffix: '/chat/completions', model_discovery: true },
  { code: 'anthropic-messages', label: 'Anthropic Messages', description: '适用于 Claude Code 和 DashScope Anthropic 兼容入口。', endpoint_suffix: '/v1/messages', model_discovery: true },
  { code: 'openai-responses', label: 'OpenAI Responses', description: '保留 Responses 原生工具与推理能力。', endpoint_suffix: '/responses', model_discovery: true },
]

const EMPTY_MODELS = []
const MODEL_LIMIT = 50
const AUTO_APPLY_LIMIT = 20
const uniqueModels = (models) => [...new Set((Array.isArray(models) ? models : []).map((model) => String(model || '').trim()).filter(Boolean))]
const CREATE_DEFAULTS = {
  upstream_protocol: 'openai-chat',
  base_url: '',
  default_model: '',
  supported_models: EMPTY_MODELS,
  priority: 100,
  weight: 100,
  request_timeout_seconds: 120,
  enabled: true,
  proxy_enabled: false,
  proxy_url: '',
  user_agent: '',
  user_agent_preset: '',
  extra_headers_rows: [],
}

const extraHeadersRows = (headers) => {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return []
  return Object.entries(headers)
    .filter(([key]) => String(key).toLowerCase() !== 'user-agent')
    .map(([key, value]) => ({ key, value: value == null ? '' : String(value) }))
}

const extraHeadersObject = (rows) => {
  const headers = {}
  const normalizedKeys = new Set()
  for (const row of rows || []) {
    const key = String(row?.key || '').trim()
    const value = row?.value == null ? '' : String(row.value)
    if (!key && !value.trim()) continue
    if (!key) throw new Error('请填写自定义请求头名称')
    const normalizedKey = key.toLowerCase()
    if (normalizedKeys.has(normalizedKey)) throw new Error(`自定义请求头「${key}」重复`)
    normalizedKeys.add(normalizedKey)
    headers[key] = value
  }
  return headers
}

const extraHeadersPayload = (rows, userAgent, userAgentPreset) => {
  const headers = extraHeadersObject(rows)
  Object.keys(headers).forEach((key) => {
    if (key.toLowerCase() === 'user-agent') delete headers[key]
  })
  const value = String(userAgentPreset || userAgent || '').trim()
  if (value) headers['User-Agent'] = value
  return headers
}

const proxyPayload = (values, editing) => {
  const enabled = values.proxy_enabled !== false
  const value = String(values.proxy_url || '').trim()
  if (!enabled) return { proxy_url: '' }
  if (editing?.proxy_enabled && value && value === editing.proxy_hint) return {}
  if (value) return { proxy_url: value }
  if (editing?.proxy_enabled) return {}
  return { proxy_url: '' }
}

const healthMeta = (row) => {
  if (!row.enabled) return { label: '已停用', color: 'grey' }
  if (row.health_status === 'healthy') return { label: '正常', color: 'green' }
  if (row.health_status === 'cooldown') {
    // 冷却到期但还没有新的成功观测时，DB 状态仍是 cooldown；按剩余时间区分展示。
    return row.cooldown_active ? { label: '冷却中', color: 'orange' } : { label: '冷却结束', color: 'cyan' }
  }
  if (row.health_status === 'unhealthy') return { label: '异常', color: 'red' }
  return { label: '未检测', color: 'light-blue' }
}

export default function AgentKeysPage() {
  const { hasPermission } = useAuth()
  const [data, setData] = useState({ items: [], total: 0, summary: EMPTY_SUMMARY })
  const [query, setQuery] = useState({
    page: 1, per_page: 20, search: '', enabled: '', upstream_protocol: '', health_status: '',
  })
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(false)
  const [editing, setEditing] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [checkingId, setCheckingId] = useState(null)
  const [copyingId, setCopyingId] = useState(null)
  const [protocols, setProtocols] = useState(FALLBACK_PROTOCOLS)
  const [selectedProtocol, setSelectedProtocol] = useState('openai-chat')
  const [modelOptions, setModelOptions] = useState(EMPTY_MODELS)
  const [upstreamCatalog, setUpstreamCatalog] = useState([])
  const [catalogPick, setCatalogPick] = useState()
  const formApiRef = useRef()

  const load = useCallback(() => {
    setLoading(true)
    listCredentials(query)
      .then(setData)
      .catch((e) => Toast.error(e?.error || '加载模型账号失败'))
      .finally(() => setLoading(false))
  }, [query])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    listCredentialUpstreamProtocols()
      .then((res) => setProtocols(res.items || FALLBACK_PROTOCOLS))
      .catch(() => setProtocols(FALLBACK_PROTOCOLS))
  }, [])

  const protocolOptions = protocols.map((protocol) => ({
    label: protocol.label,
    value: protocol.code,
  }))
  const protocolMeta = protocols.find((protocol) => protocol.code === selectedProtocol)
  const protocolName = (code) => protocols.find((protocol) => protocol.code === code)?.label || code

  const openCreate = () => {
    setEditing(null)
    setSelectedProtocol('openai-chat')
    setModelOptions([])
    setUpstreamCatalog([])
    setCatalogPick()
    setVisible(true)
  }

  const openEdit = (row) => {
    setEditing(row)
    setSelectedProtocol(row.upstream_protocol || 'openai-chat')
    setModelOptions(row.supported_models || [])
    setUpstreamCatalog([])
    setCatalogPick()
    setVisible(true)
  }

  const save = async () => {
    let values
    try {
      values = await formApiRef.current.validate()
    } catch {
      return
    }
    const payload = { ...values, enabled: values.enabled !== false }
    try {
      payload.extra_headers = extraHeadersPayload(values.extra_headers_rows, values.user_agent, values.user_agent_preset)
    } catch (e) {
      Toast.error(e.message || '自定义请求头填写不正确')
      return
    }
    Object.assign(payload, proxyPayload(values, editing))
    delete payload.tags
    delete payload.provider
    delete payload.extra_headers_rows
    delete payload.proxy_enabled
    delete payload.user_agent
    delete payload.user_agent_preset
    delete payload.model_prefix
    if (!payload.api_key) delete payload.api_key
    const task = editing ? updateCredential(editing.id, payload) : createCredential(payload)
    setSubmitting(true)
    task
      .then((res) => {
        if (editing) {
          Toast.success('模型账号已保存')
        } else if (res?.health_probe?.ok) {
          Toast.success('模型账号已保存，自动探活正常')
        } else {
          Toast.warning(`模型账号已保存，但自动探活未通过：${res?.health_probe?.message || '请稍后手动检测'}`)
        }
        setVisible(false)
        load()
      })
      .catch((e) => Toast.error(e?.error || '保存失败'))
      .finally(() => setSubmitting(false))
  }

  const syncDefaultModelOptions = (models, { resetDefault = false } = {}) => {
    const nextModels = uniqueModels(models)
    setModelOptions(nextModels)
    const current = formApiRef.current?.getValue('default_model')
    if (!nextModels.length) {
      formApiRef.current?.setValue('default_model', '')
      return
    }
    if (resetDefault || !current || !nextModels.includes(current)) formApiRef.current?.setValue('default_model', nextModels[0])
  }

  const applySupportedModels = (models, optionModels = models) => {
    const nextModels = uniqueModels(models)
    formApiRef.current?.setValue('supported_models', nextModels)
    syncDefaultModelOptions(optionModels)
  }

  const addFromCatalog = (model) => {
    if (!model) return
    const current = formApiRef.current?.getValue('supported_models') || []
    if (current.includes(model)) {
      Toast.info('该模型已在列表中')
      setCatalogPick()
      return
    }
    if (current.length >= MODEL_LIMIT) {
      Toast.warning(`支持模型最多 ${MODEL_LIMIT} 个，请先清空再挑选`)
      setCatalogPick()
      return
    }
    applySupportedModels([...current, model], [...upstreamCatalog, ...current, model])
    setCatalogPick()
  }

  const discoverModels = () => {
    const values = formApiRef.current?.getValues?.() || {}
    let extraHeaders = {}
    try {
      extraHeaders = extraHeadersPayload(values.extra_headers_rows, values.user_agent, values.user_agent_preset)
    } catch (e) {
      Toast.error(e.message || '自定义请求头填写不正确')
      return
    }
    setDiscovering(true)
    discoverCredentialModels({
      credential_id: editing?.id,
      upstream_protocol: values.upstream_protocol,
      base_url: values.base_url,
      api_key: values.api_key,
      request_timeout_seconds: values.request_timeout_seconds,
      extra_headers: extraHeaders,
      ...proxyPayload(values, editing),
    })
      .then((res) => {
        const models = uniqueModels(res.models)
        setUpstreamCatalog(models)
        setCatalogPick()
        if (!models.length) {
          Toast.warning(res.message || '上游未提供模型列表，请手动填写')
          return
        }
        // 上游目录不仅填入“支持模型”，还要同步到“默认模型”的选项数据，
        // 避免默认模型一直停留在 Provider 的历史默认值。
        syncDefaultModelOptions(models, { resetDefault: true })
        if (models.length <= AUTO_APPLY_LIMIT) {
          applySupportedModels(models)
          Toast.success(`已填入 ${models.length} 个模型`)
          return
        }
        Toast.success(`上游有 ${models.length} 个模型，请搜索后添加，最多 ${MODEL_LIMIT} 个`)
      })
      .catch((e) => Toast.error(e?.error || '获取模型失败'))
      .finally(() => setDiscovering(false))
  }

  const runCheck = (row) => {
    setCheckingId(row.id)
    checkCredential(row.id)
      .then((res) => {
        const count = res.model_count || 0
        if (count) Toast.success(`连接正常 · 上游有 ${count} 个模型`)
        else Toast.warning(res.message || '连接已到达上游，但未返回模型列表')
        load()
      })
      .catch((e) => { Toast.error(e?.error || '连接检测失败'); load() })
      .finally(() => setCheckingId(null))
  }

  const copyAccount = (row) => {
    setCopyingId(row.id)
    copyCredential(row.id)
      .then(() => {
        Toast.success('模型账号已复制')
        setQuery((current) => ({ ...current, page: 1 }))
      })
      .catch((e) => Toast.error(e?.error || '复制失败'))
      .finally(() => setCopyingId(null))
  }

  const handleProtocolChange = (protocol) => {
    setSelectedProtocol(protocol)
    setUpstreamCatalog([])
    setCatalogPick()
  }

  const columns = [
    {
      title: '账号',
      width: 210,
      render: (_, row) => <div><div>{row.name}</div><Typography.Text type="tertiary" size="small">{protocolName(row.upstream_protocol)} · {row.api_key_masked}</Typography.Text>{row.proxy_enabled && <Typography.Text type="tertiary" size="small" style={{ display: 'block', marginTop: 4 }}>代理：{row.proxy_hint}</Typography.Text>}</div>,
    },
    {
      title: '模型',
      width: 260,
      render: (_, row) => <Space spacing={4} wrap>
        {(row.supported_models || []).slice(0, 2).map((model) => (
          <Tag key={model} color={model === row.default_model ? 'blue' : 'grey'}>
            {model}
          </Tag>
        ))}
        {(row.supported_models || []).length > 2 && <Tag>+{row.supported_models.length - 2}</Tag>}
      </Space>,
    },
    {
      title: '分流顺序 / 权重',
      width: 120,
      render: (_, row) => <span>{row.priority} / {row.weight}</span>,
    },
    {
      title: '状态',
      width: 190,
      render: (_, row) => {
        const meta = healthMeta(row)
        return <div><Tag color={meta.color}>{meta.label}</Tag><Typography.Text type="tertiary" size="small" style={{ display: 'block', marginTop: 4 }}>{row.last_checked_at ? `${formatTime(row.last_checked_at)}${row.last_latency_ms != null ? ` · ${row.last_latency_ms} ms` : ''}` : '尚未检测'}</Typography.Text></div>
      },
    },
    { title: '最近调用', dataIndex: 'last_used_at', width: 180, render: formatTime },
    {
      title: '操作',
      width: 320,
      fixed: 'right',
      render: (_, row) => <Space>
        {hasPermission('agent_llm_keys_test') && <Button theme="borderless" loading={checkingId === row.id} onClick={() => runCheck(row)}>检测</Button>}
        {hasPermission('agent_llm_keys_add') && <Button theme="borderless" loading={copyingId === row.id} onClick={() => copyAccount(row)}>复制</Button>}
        {hasPermission('agent_llm_keys_edit') && <>
          <Button theme="borderless" onClick={() => openEdit(row)}>编辑</Button>
          <Switch size="small" checked={row.enabled} onChange={(enabled) => updateCredential(row.id, { enabled }).then(load)} />
        </>}
        {hasPermission('agent_llm_keys_delete') && <Popconfirm title="确认删除该模型账号？" content="被模型路由引用的账号无法删除。" onConfirm={() => deleteCredential(row.id).then(load).catch((e) => Toast.error(e?.error || '删除失败'))}>
          <Button theme="borderless" type="danger" disabled={row.enabled !== false} title={row.enabled !== false ? '启用中的模型账号不能删除，请先停用' : undefined}>删除</Button>
        </Popconfirm>}
      </Space>,
    },
  ]

  const defaultModelOptions = upstreamCatalog.length ? upstreamCatalog : modelOptions
  const summary = data.summary || EMPTY_SUMMARY
  return <AgentPage
    title="模型账号"
    description="添加模型账号并设置分流顺序。请求会优先使用可用账号，失败时自动切换备用账号。"
    actions={<>
      <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
      {hasPermission('agent_llm_keys_add') && <Button theme="solid" icon={<IconPlus />} onClick={openCreate}>添加账号</Button>}
    </>}
    stats={<AgentStatCards items={[
      { label: '账号总数', value: summary.total, hint: `${summary.enabled} 个账号已启用`, icon: <IconKey /> },
      { label: '当前可用', value: summary.healthy, hint: '健康账号可参与请求分流', tone: 'green', icon: <IconTickCircle /> },
      { label: '需要处理', value: summary.unhealthy + summary.unknown, hint: `异常 ${summary.unhealthy} · 未检测 ${summary.unknown}`, tone: summary.unhealthy ? 'red' : 'orange', icon: <IconAlertTriangle /> },
    ]} />}
    filters={<>
      <Input prefix={<IconSearch />} placeholder="搜索名称、接口或模型" value={query.search} onChange={(search) => setQuery((q) => ({ ...q, search, page: 1 }))} style={{ width: 260 }} showClear />
      <Select value={query.upstream_protocol} onChange={(upstream_protocol) => setQuery((q) => ({ ...q, upstream_protocol, page: 1 }))} style={{ width: 220 }} optionList={[{ label: '全部上游接口', value: '' }, ...protocolOptions]} />
      <Select value={query.health_status} onChange={(health_status) => setQuery((q) => ({ ...q, health_status, page: 1 }))} style={{ width: 140 }} optionList={[
        { label: '全部健康状态', value: '' }, { label: '正常', value: 'healthy' },
        { label: '异常', value: 'unhealthy' }, { label: '冷却中', value: 'cooldown' }, { label: '未检测', value: 'unknown' },
      ]} />
    </>}
  >
    <Table columns={columns} dataSource={data.items} rowKey="id" loading={loading} scroll={{ x: 1240 }} pagination={{ currentPage: query.page, pageSize: query.per_page, total: data.total, onPageChange: (page) => setQuery((q) => ({ ...q, page })) }} />
    <Modal
      title={editing ? '编辑模型账号' : '添加模型账号'}
      visible={visible}
      onOk={save}
      okText={editing ? '保存修改' : '确认添加'}
      onCancel={() => setVisible(false)}
      okButtonProps={{ loading: submitting }}
      cancelButtonProps={{ disabled: submitting }}
      maskClosable={!submitting}
      width="min(720px, calc(100vw - 24px))"
      afterClose={() => {
        formApiRef.current?.reset()
        setEditing(null)
        setUpstreamCatalog([])
        setCatalogPick()
      }}
    >
      <Banner className="agent-form-tip" type="info" fullMode={false} icon={null} description="API Key 会加密保存，完整内容不会再次显示。" />
      <Form
        key={editing?.id || 'new'}
        className="agent-modal-form"
        getFormApi={(api) => { formApiRef.current = api }}
        initValues={editing ? { ...editing, api_key: '', proxy_enabled: Boolean(editing.proxy_enabled), proxy_url: editing.proxy_hint || '', user_agent: userAgentPresetFromHeaders(editing.extra_headers) ? '' : userAgentFromHeaders(editing.extra_headers), user_agent_preset: userAgentPresetFromHeaders(editing.extra_headers), extra_headers_rows: extraHeadersRows(editing.extra_headers) } : CREATE_DEFAULTS}
        labelPosition="top"
      >
        <div className="agent-form-grid">
          <Form.Input field="name" label="账号名称" placeholder="例如：DeepSeek 主账号" rules={[{ required: true, message: '请输入账号名称' }]} />
          <Form.Select
            field="upstream_protocol"
            label="上游接口类型"
            optionList={protocolOptions}
            onChange={handleProtocolChange}
            extraText={protocolMeta ? `${protocolMeta.description} 网关会在 Base URL 后使用 ${protocolMeta.endpoint_suffix}。` : ''}
            style={{ width: '100%' }}
          />
          <div className="agent-form-grid__full">
            <Form.Input field="base_url" label="Base URL" placeholder={selectedProtocol === 'anthropic-messages' ? '例如 https://dashscope.aliyuncs.com/apps/anthropic' : '例如 https://api.example.com/v1'} rules={[{ required: true, message: '请输入上游地址' }]} />
          </div>
          <div className="agent-form-grid__full">
            <Form.Input field="api_key" label={editing ? 'API Key（留空不修改）' : 'API Key'} type="password" autoComplete={editing ? 'current-password' : 'new-password'} rules={editing ? [] : [{ required: true, message: '请输入 API Key' }]} />
          </div>
          <div className="agent-form-grid__full">
            <div className="agent-form-field-action">
              <Typography.Text strong>支持模型</Typography.Text>
              <Space>
                <Button size="small" type="tertiary" onClick={() => applySupportedModels([])}>清空</Button>
                {hasPermission('agent_llm_keys_test') && protocolMeta?.model_discovery && (
                  <Button size="small" loading={discovering} onClick={discoverModels}>从上游获取</Button>
                )}
              </Space>
            </div>
            {upstreamCatalog.length > AUTO_APPLY_LIMIT && (
              <Select
                filter
                placeholder={`从 ${upstreamCatalog.length} 个上游模型中搜索添加`}
                optionList={upstreamCatalog.map((model) => ({ label: model, value: model }))}
                value={catalogPick}
                onChange={addFromCatalog}
                style={{ width: '100%', marginBottom: 8 }}
              />
            )}
            <Form.TagInput
              field="supported_models"
              noLabel
              placeholder="输入模型名称后回车，或从上游搜索添加"
              max={MODEL_LIMIT}
              showClear
              onChange={(models) => {
                const nextModels = models || []
                syncDefaultModelOptions([...upstreamCatalog, ...nextModels])
              }}
            />
          </div>
          <Form.Select field="default_model" label="默认模型" optionList={defaultModelOptions.map((model) => ({ label: model, value: model }))} filter style={{ width: '100%' }} rules={[{ required: true, message: '请选择默认模型' }]} />
          <Form.Switch field="enabled" label="启用状态" />
          <div className="agent-form-grid__full agent-advanced-settings">
            <Collapse clickHeaderToExpand>
              <Collapse.Panel
                header={<div className="agent-advanced-settings__header"><IconSetting size="small" /><Typography.Text strong>高级设置</Typography.Text><Typography.Text type="tertiary" size="small">代理 · 请求头 · 超时 · 路由权重 · 备注</Typography.Text></div>}
                itemKey="advanced"
              >
              <div className="agent-form-grid agent-advanced-settings__content">
                <div className="agent-form-grid__full">
                  <Form.Switch field="proxy_enabled" label="通过出站代理访问上游" extraText="网关服务器必须能访问该地址；支持 HTTP/HTTPS 代理，例如 http://192.168.1.100:7890。" />
                  <Form.Input field="proxy_url" label="代理地址" placeholder="http://192.168.1.100:7890" extraText={editing?.proxy_enabled ? '已回显当前代理地址；保持不变即可保留原配置，关闭上方开关可清除。代理认证信息不会回显。' : '如不需要代理可保持关闭。代理账号密码也会加密保存。'} />
                </div>
                <div className="agent-form-grid__full">
                  <div className="agent-form-field-action">
                    <Typography.Text strong>User-Agent</Typography.Text>
                  </div>
                  <div className="agent-user-agent-fields">
                    <div>
                      <Typography.Text className="agent-user-agent-fields__label" type="tertiary" size="small">自定义值</Typography.Text>
                      <Form.Input field="user_agent" noLabel placeholder="手动输入 User-Agent" style={{ width: '100%' }} onChange={() => formApiRef.current?.setValue('user_agent_preset', '')} />
                    </div>
                    <div>
                      <Typography.Text className="agent-user-agent-fields__label" type="tertiary" size="small">预设值</Typography.Text>
                      <Form.Select field="user_agent_preset" noLabel placeholder="选择预设" optionList={USER_AGENT_PRESETS} style={{ width: '100%' }} onChange={() => formApiRef.current?.setValue('user_agent', '')} />
                    </div>
                  </div>
                  <Typography.Text type="tertiary" size="small">二选一：填写自定义值或选择预设；保存后会作为 User-Agent 请求头发送给上游。</Typography.Text>
                </div>
                <Form.InputNumber field="priority" label="分流顺序" extraText="数字越大越优先" min={1} max={1000} style={{ width: '100%' }} />
                <Form.InputNumber field="weight" label="同级权重" extraText="同一顺序内按权重分配" min={1} max={1000} style={{ width: '100%' }} />
                <Form.InputNumber field="request_timeout_seconds" label="请求超时（秒）" min={5} max={300} style={{ width: '100%' }} />
                <div className="agent-form-grid__full">
                  <ArrayField field="extra_headers_rows">
                    {({ arrayFields, addWithInitValue }) => (
                      <div>
                        <div className="agent-form-field-action">
                          <Typography.Text strong>自定义请求头</Typography.Text>
                          <Button size="small" theme="light" type="primary" icon={<IconPlus />} onClick={() => addWithInitValue({ key: '', value: '' })}>
                            新增请求头
                          </Button>
                        </div>
                        <Typography.Text type="tertiary" size="small">按名称和值填写，保存时会自动发给上游。例如 HTTP-Referer、X-Title。</Typography.Text>
                        {arrayFields.length > 0 && (
                          <div style={{ display: 'grid', gridTemplateColumns: '2fr 3fr 48px', gap: 8, padding: '12px 0 6px' }}>
                            <Typography.Text size="small" type="tertiary">请求头名称</Typography.Text>
                            <Typography.Text size="small" type="tertiary">值</Typography.Text>
                            <span />
                          </div>
                        )}
                        {arrayFields.map(({ field, key, remove }, rowIndex) => (
                          <div key={key} style={{ display: 'grid', gridTemplateColumns: '2fr 3fr 48px', gap: 8, alignItems: 'start', marginBottom: 8 }}>
                            <Form.Input field={`${field}.key`} noLabel placeholder="例如 X-Title" rules={[{ required: true, message: '请填写名称' }]} />
                            <Form.Input field={`${field}.value`} noLabel placeholder="例如 COATI" />
                            <Button size="small" theme="borderless" type="danger" onClick={remove} aria-label={`移除第 ${rowIndex + 1} 个请求头`}>移除</Button>
                          </div>
                        ))}
                        {!arrayFields.length && <Typography.Text type="tertiary" size="small" style={{ display: 'block', paddingTop: 10 }}>暂无自定义请求头</Typography.Text>}
                      </div>
                    )}
                  </ArrayField>
                </div>
                <div className="agent-form-grid__full"><Form.TextArea field="note" label="备注" rows={2} maxCount={255} /></div>
              </div>
              </Collapse.Panel>
            </Collapse>
          </div>
        </div>
      </Form>
    </Modal>
  </AgentPage>
}
