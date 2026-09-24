import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner, Button, Form, Modal, Popconfirm, SideSheet, Space, Table, Tabs, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import { IconCopy, IconEdit, IconPlus, IconRefresh } from '@douyinfe/semi-icons'
import { useAuth } from '@/context/AuthContext'
import { createPat, listPatUsage, listPats, revokePat, rotatePat, updatePat } from '@/modules/agent/api/tokens'
import { AgentPage } from '@/modules/agent/components/AgentPage'
import { formatNumber, formatTime, formatTokenCount } from '@/modules/agent/utils'
import './tokens-page.css'

const statusTag = (row) => {
  if (row.status === 'revoked') return <Tag color="red">已撤销</Tag>
  if (row.status === 'expired') return <Tag color="orange">已过期</Tag>
  if (row.expires_in_days != null && row.expires_in_days <= 7) return <Tag color="amber">即将过期</Tag>
  return <Tag color="green">有效</Tag>
}

const EXPIRY_PRESETS = [
  { value: 30, label: '30 天' },
  { value: 60, label: '60 天' },
  { value: 90, label: '90 天' },
  { value: 180, label: '180 天' },
  { value: 365, label: '365 天' },
  { value: 0, label: '永久有效' },
]

function expiryOptions(currentDays) {
  const days = Number(currentDays)
  if (Number.isFinite(days) && days > 0 && !EXPIRY_PRESETS.some((item) => item.value === days)) {
    return [{ value: days, label: `当前剩余 ${days} 天` }, ...EXPIRY_PRESETS]
  }
  return EXPIRY_PRESETS
}

function normalizeExpiryDays(value) {
  const days = Number(value)
  return Number.isFinite(days) && days > 0 ? days : null
}

function gatewayOrigins() {
  const origin = window.location.origin
  return {
    anthropic: `${origin}/api/agent`,
    openai: `${origin}/api/agent/v1`,
  }
}

function ConnectTable({ token }) {
  const { anthropic, openai } = gatewayOrigins()
  const rows = [
    { tool: 'Claude Code', url: anthropic },
    { tool: 'Cursor', url: openai },
    { tool: 'Codex', url: openai },
    { tool: 'OpenCode', url: openai },
    { tool: 'OpenClaw', url: openai },
  ]
  const copy = (value) => navigator.clipboard.writeText(value)
    .then(() => Toast.success('已复制'))
    .catch(() => Toast.error('复制失败'))
  return (
    <Table
      size="small"
      pagination={false}
      rowKey="tool"
      dataSource={rows}
      columns={[
        { title: '客户端', dataIndex: 'tool', width: 120 },
        {
          title: '地址',
          render: (_, row) => (
            <Space>
              <Typography.Text code size="small">{row.url}</Typography.Text>
              <Button theme="borderless" icon={<IconCopy />} onClick={() => copy(row.url)} />
            </Space>
          ),
        },
        {
          title: 'Key',
          width: 90,
          render: () => token
            ? <Button theme="borderless" icon={<IconCopy />} onClick={() => copy(token)}>复制</Button>
            : '—',
        },
      ]}
    />
  )
}

export default function AgentTokensPage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState('personal')
  const [data, setData] = useState({ items: [], total: 0 })
  const [query, setQuery] = useState({ page: 1, per_page: 20 })
  const [loading, setLoading] = useState(true)
  const [createVisible, setCreateVisible] = useState(false)
  const [editVisible, setEditVisible] = useState(false)
  const [editingPat, setEditingPat] = useState(null)
  const [secret, setSecret] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [editSubmitting, setEditSubmitting] = useState(false)
  const [rotatingId, setRotatingId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailUsage, setDetailUsage] = useState({ items: [], total: 0 })
  const [detailLoading, setDetailLoading] = useState(false)
  const formApiRef = useRef()
  const editFormApiRef = useRef()

  const tokenType = tab === 'device' ? 'device' : 'personal'

  const load = useCallback(() => {
    setLoading(true)
    listPats({ ...query, token_type: tokenType })
      .then(setData)
      .catch((error) => Toast.error(error?.error || '加载失败'))
      .finally(() => setLoading(false))
  }, [query, tokenType])

  useEffect(() => { load() }, [load])

  const openDetail = (row) => {
    setDetail(row)
    setDetailLoading(true)
    listPatUsage(row.id, { page: 1, per_page: 20, days: 7 })
      .then(setDetailUsage)
      .catch((error) => Toast.error(error?.error || '加载失败'))
      .finally(() => setDetailLoading(false))
  }

  const create = async () => {
    let values
    try {
      values = await formApiRef.current.validate()
    } catch {
      return
    }
    setSubmitting(true)
    createPat({ ...values, expires_days: normalizeExpiryDays(values.expires_days), token_type: 'personal', scopes: ['chat', 'profile'] })
      .then((result) => { setCreateVisible(false); setSecret(result); load() })
      .catch((error) => Toast.error(error?.error || '创建失败'))
      .finally(() => setSubmitting(false))
  }

  const rotate = (row) => {
    setRotatingId(row.id)
    rotatePat(row.id)
      .then((result) => { setSecret(result); load() })
      .catch((error) => Toast.error(error?.error || '轮换失败'))
      .finally(() => setRotatingId(null))
  }

  const openEdit = (row) => {
    setEditingPat(row)
    setEditVisible(true)
  }

  const saveEdit = async () => {
    let values
    try {
      values = await editFormApiRef.current.validate()
    } catch {
      return
    }
    setEditSubmitting(true)
    updatePat(editingPat.id, {
      name: values.name,
      expires_days: normalizeExpiryDays(values.expires_days),
    })
      .then(() => {
        setEditVisible(false)
        setEditingPat(null)
        load()
      })
      .catch((error) => Toast.error(error?.error || '保存失败'))
      .finally(() => setEditSubmitting(false))
  }

  const copySecret = () => navigator.clipboard.writeText(secret?.token || '')
    .then(() => Toast.success('已复制'))
    .catch(() => Toast.error('复制失败'))

  const columns = [
    {
      title: '名称', width: 220,
      render: (_, row) => (
        <button type="button" className="tokens-name" onClick={() => openDetail(row)}>
          <span>{row.name}</span>
          <Typography.Text code size="small">{row.token_prefix}…</Typography.Text>
        </button>
      ),
    },
    { title: '状态', width: 100, render: (_, row) => statusTag(row) },
    { title: '近 7 日（计费）', width: 170, render: (_, row) => `${formatTokenCount(row.tokens_7d)} Token / ${formatNumber(row.requests_7d)} 次` },
    { title: '最后使用', dataIndex: 'last_used_at', width: 170, render: (value) => value ? formatTime(value) : '—' },
    { title: '到期', dataIndex: 'expires_at', width: 170, render: (value) => value ? formatTime(value) : '—' },
    {
      title: '', width: 220, fixed: 'right', render: (_, row) => row.status === 'active' ? (
        <Space>
          {tab === 'personal' && hasPermission('agent_pat_edit') && (
            <Button theme="borderless" icon={<IconEdit />} onClick={() => openEdit(row)}>编辑</Button>
          )}
          {tab === 'personal' && hasPermission('agent_pat_rotate') && (
            <Popconfirm title="轮换后旧 Key 立即失效" onConfirm={() => rotate(row)}>
              <Button theme="borderless" loading={rotatingId === row.id}>轮换</Button>
            </Popconfirm>
          )}
          {hasPermission('agent_pat_delete') && (
            <Popconfirm title="确认撤销？" onConfirm={() => revokePat(row.id).then(load).catch((error) => Toast.error(error?.error || '撤销失败'))}>
              <Button type="danger" theme="borderless">撤销</Button>
            </Popconfirm>
          )}
        </Space>
      ) : '—',
    },
  ]

  return (
    <AgentPage
      title="访问令牌"
      contentTitle=""
      actions={(
        <>
          <Button icon={<IconRefresh />} onClick={load}>刷新</Button>
          {tab === 'personal' && hasPermission('agent_pat_add') && (
            <Button theme="solid" icon={<IconPlus />} onClick={() => setCreateVisible(true)}>创建 API Key</Button>
          )}
        </>
      )}
    >
      <Tabs
        type="line"
        activeKey={tab}
        onChange={(key) => { setTab(key); setQuery((current) => ({ ...current, page: 1 })); setLoading(true) }}
      >
        <Tabs.TabPane tab="API Key" itemKey="personal" />
        <Tabs.TabPane tab="本机登录" itemKey="device" />
      </Tabs>
      <Table
        columns={columns}
        dataSource={data.items}
        rowKey="id"
        loading={loading}
        scroll={{ x: 1000 }}
        pagination={{
          currentPage: query.page,
          pageSize: query.per_page,
          total: data.total,
          onPageChange: (page) => { setLoading(true); setQuery((current) => ({ ...current, page })) },
        }}
      />

      <Modal
        title="创建 API Key"
        visible={createVisible}
        onOk={create}
        okText="创建"
        onCancel={() => setCreateVisible(false)}
        okButtonProps={{ loading: submitting }}
        cancelButtonProps={{ disabled: submitting }}
        maskClosable={!submitting}
        width="min(520px, calc(100vw - 24px))"
        afterClose={() => formApiRef.current?.reset()}
      >
        <Form getFormApi={(api) => { formApiRef.current = api }} initValues={{ expires_days: 0 }} labelPosition="top">
          <Form.Input field="name" label="名称" placeholder="例如 Cursor" rules={[{ required: true, message: '请输入名称' }]} />
          <Form.Select field="expires_days" label="有效期" optionList={EXPIRY_PRESETS} extraText="选择预设有效期，永久有效不会自动过期" style={{ width: '100%' }} />
          <Form.TextArea field="note" label="备注" rows={2} maxCount={255} />
        </Form>
      </Modal>

      <Modal
        title="编辑 API Key"
        visible={editVisible}
        onOk={saveEdit}
        okText="保存"
        onCancel={() => setEditVisible(false)}
        okButtonProps={{ loading: editSubmitting }}
        cancelButtonProps={{ disabled: editSubmitting }}
        maskClosable={!editSubmitting}
        width="min(520px, calc(100vw - 24px))"
        afterClose={() => { editFormApiRef.current?.reset(); setEditingPat(null) }}
      >
        <Form
          key={editingPat?.id || 'edit-pat'}
          getFormApi={(api) => { editFormApiRef.current = api }}
          initValues={{ name: editingPat?.name || '', expires_days: editingPat?.expires_in_days ?? 0 }}
          labelPosition="top"
        >
          <Form.Input field="name" label="名称" rules={[{ required: true, message: '请输入名称' }]} />
          <Form.Select
            field="expires_days"
            label="有效期"
            optionList={expiryOptions(editingPat?.expires_in_days)}
            extraText="修改后从现在起重新计算；永久有效不会自动过期"
            style={{ width: '100%' }}
          />
        </Form>
      </Modal>

      <Modal
        title="API Key"
        visible={!!secret?.token}
        onCancel={() => setSecret(null)}
        maskClosable={false}
        width="min(720px, calc(100vw - 24px))"
        footer={<Space><Button icon={<IconCopy />} onClick={copySecret}>复制 Key</Button><Button theme="solid" onClick={() => setSecret(null)}>已保存</Button></Space>}
      >
        <Banner type="warning" icon={null} description="关闭后无法再看完整 Key。" />
        <pre className="tokens-secret">{secret?.token}</pre>
        <ConnectTable token={secret?.token} />
      </Modal>

      <SideSheet
        title={detail?.name || '用量'}
        visible={!!detail}
        onCancel={() => setDetail(null)}
        width={Math.min(720, window.innerWidth - 24)}
      >
        {detail && (
          <>
            <div className="tokens-detail-meta">
              <span>{statusTag(detail)}</span>
              <Typography.Text type="tertiary">{formatTokenCount(detail.tokens_7d)} Token · {formatNumber(detail.requests_7d)} 次</Typography.Text>
            </div>
            {tab === 'personal' && <ConnectTable />}
            <Table
              size="small"
              loading={detailLoading}
              pagination={false}
              rowKey="id"
              dataSource={detailUsage.items}
              columns={[
                { title: '时间', dataIndex: 'created_at', width: 170, render: formatTime },
                { title: '模型', dataIndex: 'model', width: 140, render: (value) => value || '—' },
                { title: 'Token', dataIndex: 'total_tokens', width: 90, render: formatTokenCount },
                { title: '状态', dataIndex: 'status', width: 90 },
              ]}
            />
          </>
        )}
      </SideSheet>
    </AgentPage>
  )
}
