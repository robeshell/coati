import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Banner, Button, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Toast, Typography,
} from '@douyinfe/semi-ui'
import { IconPlus, IconRefresh, IconSearch, IconSetting } from '@douyinfe/semi-icons'
import { useAuth } from '@/context/AuthContext'
import {
  createModelProfile,
  deleteModelProfile,
  listModelProfileCandidates,
  listModelProfiles,
  syncModelProfiles,
  updateModelProfile,
} from '@/modules/agent/api/model_profiles'
import { AgentPage } from '@/modules/agent/components/AgentPage'
import {
  formatTime,
  formatTokenCount,
  MODEL_CONTEXT_WINDOW_PRESETS,
  MODEL_MAX_OUTPUT_PRESETS,
} from '@/modules/agent/utils'

const EMPTY_DATA = { items: [], total: 0 }

export default function AgentModelProfilesPage() {
  const { hasPermission } = useAuth()
  const [data, setData] = useState(EMPTY_DATA)
  const [candidates, setCandidates] = useState([])
  const [query, setQuery] = useState({ page: 1, per_page: 20, search: '', enabled: '' })
  const [loading, setLoading] = useState(true)
  const [visible, setVisible] = useState(false)
  const [editing, setEditing] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [contextOverrideEnabled, setContextOverrideEnabled] = useState(false)
  const [outputOverrideEnabled, setOutputOverrideEnabled] = useState(false)
  const formApiRef = useRef()

  const load = useCallback(() => {
    setLoading(true)
    listModelProfiles(query)
      .then(setData)
      .catch((error) => Toast.error(error?.error || '加载模型能力失败'))
      .finally(() => setLoading(false))
  }, [query])

  const loadCandidates = useCallback(() => {
    listModelProfileCandidates()
      .then((result) => setCandidates(result.items || []))
      .catch(() => setCandidates([]))
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadCandidates() }, [loadCandidates])

  const updateQuery = (patch) => setQuery((current) => ({ ...current, ...patch }))

  const openCreate = () => {
    setEditing(null)
    setContextOverrideEnabled(false)
    setOutputOverrideEnabled(false)
    setVisible(true)
  }

  const openEdit = (row) => {
    setEditing(row)
    setContextOverrideEnabled(row.context_window_override != null)
    setOutputOverrideEnabled(row.max_output_tokens_override != null)
    setVisible(true)
  }

  const syncNow = () => {
    setSyncing(true)
    syncModelProfiles(true)
      .then((result) => {
        if (result.status === 'error') {
          Toast.warning(result.message || 'LiteLLM 同步失败，已保留现有配置')
        } else {
          Toast.success(`LiteLLM 同步完成 · 匹配 ${result.matched_count || 0} 个模型`)
        }
        load()
        loadCandidates()
      })
      .catch((error) => Toast.error(error?.error || 'LiteLLM 同步失败'))
      .finally(() => setSyncing(false))
  }

  const save = async () => {
    let values
    try {
      values = await formApiRef.current.validate()
    } catch {
      return
    }
    const payload = {
      ...values,
      context_window_override: contextOverrideEnabled ? Number(values.context_window_override) : null,
      max_output_tokens_override: outputOverrideEnabled ? Number(values.max_output_tokens_override) : null,
      enabled: values.enabled !== false,
      note: values.note || null,
    }
    setSubmitting(true)
    const task = editing
      ? updateModelProfile(editing.id, payload)
      : createModelProfile(payload)
    task
      .then(() => {
        Toast.success('模型能力已保存')
        setVisible(false)
        load()
        loadCandidates()
      })
      .catch((error) => Toast.error(error?.error || '保存失败'))
      .finally(() => setSubmitting(false))
  }

  const columns = [
    {
      title: '模型', width: 300,
      render: (_, row) => <div>
        <Typography.Text strong>{row.model_name}</Typography.Text>
        {row.note && <Typography.Text type="tertiary" size="small" ellipsis={{ showTooltip: true }} style={{ display: 'block', maxWidth: 270 }}>{row.note}</Typography.Text>}
      </div>,
    },
    {
      title: '上下文窗口', width: 180,
      render: (_, row) => <div>
        <Typography.Text>{formatTokenCount(row.context_window)} Token</Typography.Text>
        <Typography.Text type="tertiary" size="small" style={{ display: 'block' }}>
          {row.context_window_override != null ? '管理员覆盖' : row.litellm_context_window ? 'LiteLLM 默认' : '安全兜底'}
        </Typography.Text>
      </div>,
    },
    {
      title: '最大输出', width: 160,
      render: (_, row) => <div>
        <Typography.Text>{formatTokenCount(row.max_output_tokens)} Token</Typography.Text>
        <Typography.Text type="tertiary" size="small" style={{ display: 'block' }}>
          {row.max_output_tokens_override != null ? '管理员覆盖' : row.litellm_max_output_tokens ? 'LiteLLM 默认' : '安全兜底'}
        </Typography.Text>
      </div>,
    },
    {
      title: '能力来源', width: 150,
      render: (_, row) => {
        const meta = {
          admin: { color: 'blue', label: '管理员覆盖' },
          mixed: { color: 'cyan', label: '部分覆盖' },
          litellm: { color: 'green', label: 'LiteLLM 自动' },
          fallback: { color: 'grey', label: '安全兜底' },
        }[row.source] || { color: 'grey', label: '未知' }
        return <div>
          <Tag color={meta.color}>{meta.label}</Tag>
          {row.litellm_synced_at && <Typography.Text type="tertiary" size="small" style={{ display: 'block', marginTop: 4 }}>{formatTime(row.litellm_synced_at)}</Typography.Text>}
        </div>
      },
    },
    {
      title: '状态', width: 120,
      render: (_, row) => <Tag color={row.enabled ? 'green' : 'grey'}>{row.enabled ? '生效' : '停用'}</Tag>,
    },
    {
      title: '更新时间', width: 180,
      render: (_, row) => formatTime(row.updated_at || row.created_at),
    },
    {
      title: '操作', width: 210, fixed: 'right',
      render: (_, row) => <Space>
        {hasPermission('agent_model_profiles_edit') && <>
          <Button theme="borderless" onClick={() => openEdit(row)}>编辑</Button>
          <Switch
            size="small"
            checked={row.enabled}
            onChange={(enabled) => updateModelProfile(row.id, { enabled })
              .then(load)
              .catch((error) => Toast.error(error?.error || '状态更新失败'))}
          />
        </>}
        {hasPermission('agent_model_profiles_delete') && <Popconfirm
          title="确认删除该模型能力配置？"
          content={row.enabled ? '生效中的配置不能删除，请先停用。' : '删除后该模型会回退到网关保守值。'}
          onConfirm={() => deleteModelProfile(row.id).then(load).catch((error) => Toast.error(error?.error || '删除失败'))}
        >
          <Button
            theme="borderless"
            type="danger"
            disabled={row.enabled}
            title={row.enabled ? '生效中的配置不能删除，请先停用' : undefined}
          >删除</Button>
        </Popconfirm>}
      </Space>,
    },
  ]

  return <AgentPage
    title="模型能力"
    description="模型默认能力由 LiteLLM 自动填充，同一个模型只维护一条记录；管理员可分别覆盖上下文窗口和最大输出，清除覆盖后恢复自动同步。"
    contentTitle="统一模型能力表"
    actions={<>
      <Button icon={<IconRefresh />} onClick={() => { load(); loadCandidates() }}>刷新</Button>
      {hasPermission('agent_model_profiles_edit') && <Button loading={syncing} onClick={syncNow}>同步 LiteLLM</Button>}
      {hasPermission('agent_model_profiles_add') && <Button theme="solid" icon={<IconPlus />} onClick={openCreate}>新增模型配置</Button>}
    </>}
    filters={<>
      <Input prefix={<IconSearch />} placeholder="搜索模型名称或备注" value={query.search} onChange={(search) => updateQuery({ search, page: 1 })} style={{ width: 300 }} showClear />
      <Select value={query.enabled} onChange={(enabled) => updateQuery({ enabled, page: 1 })} style={{ width: 130 }} optionList={[{ label: '全部状态', value: '' }, { label: '仅生效', value: 'true' }, { label: '仅停用', value: 'false' }]} />
    </>}
  >
    <Banner
      className="agent-form-tip"
      type="info"
      fullMode={false}
      icon={<IconSetting />}
      description={`LiteLLM 自动匹配 max_input_tokens / max_output_tokens；当前同步：${data.sync?.fetched_at || '尚未同步'}。管理员覆盖只针对当前模型，不会按账号重复配置。`}
    />
    <Table
      columns={columns}
      dataSource={data.items}
      rowKey="id"
      loading={loading}
      scroll={{ x: 1120 }}
      pagination={{ currentPage: query.page, pageSize: query.per_page, total: data.total, onPageChange: (page) => updateQuery({ page }) }}
    />
    <Modal
      title={editing ? '编辑模型能力' : '新增模型能力'}
      visible={visible}
      onOk={save}
      okText={editing ? '保存修改' : '确认新增'}
      onCancel={() => setVisible(false)}
      okButtonProps={{ loading: submitting }}
      cancelButtonProps={{ disabled: submitting }}
      maskClosable={!submitting}
      width="min(620px, calc(100vw - 24px))"
      afterClose={() => {
        formApiRef.current?.reset()
        setEditing(null)
        setContextOverrideEnabled(false)
        setOutputOverrideEnabled(false)
      }}
    >
      <Banner
        className="agent-form-tip"
        type="info"
        fullMode={false}
        description="模型名来自已配置的账号和路由，也可以直接输入新的模型名。默认跟随 LiteLLM；打开覆盖开关后才会使用管理员选择的档位。"
      />
      <Form
        key={editing?.id || 'new'}
        className="agent-modal-form"
        getFormApi={(api) => { formApiRef.current = api }}
        initValues={editing || { context_window_override: 131072, max_output_tokens_override: 8192, enabled: true }}
        labelPosition="top"
      >
        <Form.Select
          field="model_name"
          label="模型名称"
          filter
          allowCreate
          optionList={candidates.map((model) => ({ label: model, value: model }))}
          placeholder="选择已有模型或输入模型名"
          rules={[{ required: true, message: '请选择或输入模型名称' }]}
          style={{ width: '100%' }}
        />
        <div className="agent-form-grid">
          <div>
            <div className="agent-form-field-action">
              <Typography.Text strong>上下文窗口</Typography.Text>
              <Switch checked={contextOverrideEnabled} onChange={setContextOverrideEnabled} />
            </div>
            <Typography.Text type="tertiary" size="small">{contextOverrideEnabled ? '使用管理员覆盖值' : `跟随 LiteLLM${editing?.context_window ? ` · 当前 ${formatTokenCount(editing.context_window)} Token` : ''}`}</Typography.Text>
            {contextOverrideEnabled && <Form.Select field="context_window_override" label="管理员覆盖档位" optionList={MODEL_CONTEXT_WINDOW_PRESETS} rules={[{ required: true, message: '请选择上下文窗口' }]} />}
          </div>
          <div>
            <div className="agent-form-field-action">
              <Typography.Text strong>最大输出</Typography.Text>
              <Switch checked={outputOverrideEnabled} onChange={setOutputOverrideEnabled} />
            </div>
            <Typography.Text type="tertiary" size="small">{outputOverrideEnabled ? '使用管理员覆盖值' : `跟随 LiteLLM${editing?.max_output_tokens ? ` · 当前 ${formatTokenCount(editing.max_output_tokens)} Token` : ''}`}</Typography.Text>
            {outputOverrideEnabled && <Form.Select field="max_output_tokens_override" label="管理员覆盖档位" optionList={MODEL_MAX_OUTPUT_PRESETS} rules={[{ required: true, message: '请选择最大输出 Token' }]} />}
          </div>
        </div>
        <Form.TextArea field="note" label="备注（可选）" placeholder="例如：DeepSeek 长上下文模型" rows={2} maxCount={255} />
        <Form.Switch field="enabled" label="启用配置" extraText="停用后网关不使用该档案，删除前必须先停用。" />
      </Form>
    </Modal>
  </AgentPage>
}
