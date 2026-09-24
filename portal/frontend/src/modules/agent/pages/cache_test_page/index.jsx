import { useCallback, useEffect, useState } from 'react'
import {
  Banner, Button, Card, Input, InputNumber, Popconfirm, Select, Table, Tag, TextArea, Toast, Typography,
} from '@douyinfe/semi-ui'
import { IconDelete, IconPulse, IconSearch } from '@douyinfe/semi-icons'
import { useAuth } from '@/context/AuthContext'
import { AgentPage, AgentStatCards } from '@/modules/agent/components/AgentPage'
import {
  deleteCacheTest, getCacheTest, getCacheTestModels, listCacheTests, runCacheTest,
} from '@/modules/agent/api/cache_test'
import { formatNumber, formatReportedToken, formatTime } from '@/modules/agent/utils'
import './cache-test-page.css'

const STATUS_META = {
  ok: { label: '全部成功', color: 'green' },
  partial: { label: '部分成功', color: 'orange' },
  failed: { label: '失败', color: 'red' },
}

const CACHE_STATUS_META = {
  complete: { label: '字段完整', color: 'green' },
  partial: { label: '字段不全', color: 'orange' },
  unreported: { label: '未上报', color: 'grey' },
  unavailable: { label: '不可用', color: 'red' },
  legacy: { label: '历史口径', color: 'grey' },
}

const CACHE_RATIO_SOURCE_LABEL = {
  reported: '上游上报',
  derived: '按协议归一化',
  mixed: '上报 + 归一化',
}

const ratioToPercent = (value) => (
  value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`
)

const hitRatioTag = (value) => {
  if (value == null) return <Typography.Text type="tertiary">—</Typography.Text>
  const ratio = Number(value)
  if (ratio >= 0.9) return <Tag color="green">{ratioToPercent(ratio)}</Tag>
  if (ratio >= 0.5) return <Tag color="orange">{ratioToPercent(ratio)}</Tag>
  return <Tag color="grey">{ratioToPercent(ratio)}</Tag>
}

const cacheStatusTag = (status) => {
  const meta = CACHE_STATUS_META[status] || CACHE_STATUS_META.legacy
  return <Tag color={meta.color}>{meta.label}</Tag>
}

const DEFAULT_FORM = { name: '', model: '', prompt: '', rounds: 3, maxTokens: 32 }

export default function CacheTestPage() {
  const { hasPermission } = useAuth()
  const canRun = hasPermission('agent_cache_test_run')
  const canDelete = hasPermission('agent_cache_test_delete')

  const [modelOptions, setModelOptions] = useState([])
  const [form, setForm] = useState(DEFAULT_FORM)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [history, setHistory] = useState({ items: [], total: 0 })
  const [listLoading, setListLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [deleting, setDeleting] = useState(null)

  const loadModels = useCallback(() => {
    getCacheTestModels()
      .then((data) => {
        const options = (data.models || []).map((name) => ({ value: name, label: name }))
        setModelOptions(options)
        setForm((current) => ({
          ...current,
          model: current.model || data.default_model || options[0]?.value || '',
        }))
      })
      .catch((error) => Toast.error(error?.error || '加载模型列表失败'))
  }, [])

  const loadHistory = useCallback(() => {
    setListLoading(true)
    return listCacheTests({ page, per_page: 10, search: search || undefined })
      .then(setHistory)
      .catch((error) => Toast.error(error?.error || '加载历史记录失败'))
      .finally(() => setListLoading(false))
  }, [page, search])

  useEffect(() => { loadModels() }, [loadModels])
  useEffect(() => {
    // 延后一帧再切换 loading，避免在 effect 中同步触发级联渲染。
    const timer = window.setTimeout(() => loadHistory(), 0)
    return () => window.clearTimeout(timer)
  }, [loadHistory])

  const setField = (name, value) => setForm((current) => ({ ...current, [name]: value }))

  const handleRun = () => {
    if (!canRun) { Toast.warning('没有运行测试的权限'); return }
    if (!form.name.trim()) { Toast.warning('请输入测试名称'); return }
    if (!form.model) { Toast.warning('请选择模型'); return }
    if (!form.prompt.trim()) { Toast.warning('请输入 Prompt 内容'); return }
    setRunning(true)
    runCacheTest({
      name: form.name.trim(),
      model: form.model,
      prompt: form.prompt,
      rounds: form.rounds,
      max_tokens: form.maxTokens,
    })
      .then((data) => {
        setResult(data)
        Toast.success('测试完成，结果已展示')
        setPage(1)
        loadHistory()
      })
      .catch((error) => Toast.error(error?.error || '运行测试失败'))
      .finally(() => setRunning(false))
  }

  const handleView = (id) => {
    setDetailLoading(true)
    getCacheTest(id)
      .then(setResult)
      .catch((error) => Toast.error(error?.error || '加载测试详情失败'))
      .finally(() => setDetailLoading(false))
  }

  const handleDelete = (row) => {
    if (!canDelete) { Toast.warning('没有删除测试记录的权限'); return }
    setDeleting(row.id)
    deleteCacheTest(row.id)
      .then(() => {
        Toast.success('已删除测试记录')
        if (result && result.id === row.id) setResult(null)
        loadHistory()
      })
      .catch((error) => Toast.error(error?.error || '删除失败'))
      .finally(() => setDeleting(null))
  }

  const summary = result?.summary || {}

  const firstRound = (result?.round_details || [])[0]
  const firstRoundCacheHit = summary.first_round_cache_hit
    ?? (Number(firstRound?.cache_read_tokens || 0) > 0)
  const firstRoundCacheStatus = summary.first_round_cache_status || firstRound?.cache_status
  const warmHitRatio = summary.warm_hit_ratio ?? summary.avg_hit_ratio
  const warmCoverageRatio = summary.warm_cache_coverage
  const warmDisplayRatio = warmHitRatio ?? warmCoverageRatio
  const warmRatioEstimated = warmHitRatio == null && warmCoverageRatio != null
  const cacheDataStatus = summary.cache_data_status || 'legacy'
  const cacheRatioSource = summary.cache_ratio_source
  const warmObservedTokens = summary.warm_cache_observed_tokens
  const warmRatioHint = warmRatioEstimated
    ? '第 2~N 轮 · 未上报未命中，按已上报缓存 Token 统计'
    : warmObservedTokens == null
      ? '第 2~N 轮暖请求加权统计'
      : `第 2~N 轮 · 可观测 ${formatNumber(warmObservedTokens)} Token`
  const firstRoundHint = firstRoundCacheStatus === 'unreported'
    ? '第 1 轮 · 上游未上报缓存字段'
    : firstRoundCacheHit
      ? '第 1 轮 · 已命中预置缓存'
      : '第 1 轮 · 未观察到缓存命中'

  const statItems = result ? [
    {
      key: 'cold', label: '首轮基线耗时', value: summary.cold_latency_ms == null ? '—' : summary.cold_latency_ms,
      suffix: summary.cold_latency_ms == null ? '' : 'ms',
      hint: firstRoundHint, tone: 'red',
    },
    {
      key: 'warm', label: '暖请求平均耗时', value: summary.warm_avg_latency_ms == null ? '—' : summary.warm_avg_latency_ms,
      suffix: summary.warm_avg_latency_ms == null ? '' : 'ms',
      hint: '第 2~N 轮均值', tone: 'green',
    },
    {
      key: 'speedup', label: '加速比', value: summary.speedup_x == null ? '—' : summary.speedup_x, suffix: summary.speedup_x == null ? '' : '×',
      hint: summary.latency_saved_pct == null ? null : `延迟降低 ${summary.latency_saved_pct}%`, tone: 'blue',
    },
    {
      key: 'hit', label: warmRatioEstimated ? '暖请求缓存覆盖率' : '暖请求命中率', value: warmDisplayRatio == null ? '—' : Number((warmDisplayRatio * 100).toFixed(1)), suffix: warmDisplayRatio == null ? '' : '%',
      hint: warmRatioHint, tone: 'violet',
    },
  ] : []

  const consistencyBanner = result ? (
    summary.account_consistent === false ? (
      <Banner type="warning" fullMode={false} title="测试期间切换了上游账号"
        description="各轮请求可能打在不同账号上，不同 Key 的缓存相互独立，本次命中率结果可能失真。" />
    ) : summary.account_consistent === true ? (
      <Banner type="success" fullMode={false}
        title={`${summary.rounds_ok} 轮均使用同一账号${summary.account_name ? `（${summary.account_name}）` : ''}`}
        description="账号一致，缓存命中率结果有效。" />
    ) : (
      <Banner type="info" fullMode={false} title="未能确认账号一致性"
        description="部分轮次未取到账号信息，命中率结果仅供参考。" />
    )
  ) : null

  const cacheDataBanner = result ? (
    cacheDataStatus === 'complete' ? (
      <Banner type="success" fullMode={false}
        title={cacheRatioSource === 'derived' ? '缓存字段已按协议归一化' : '缓存字段已完整上报'}
        description={cacheRatioSource === 'derived'
          ? '上游未直接返回未命中 Token，页面依据协议的输入总量与缓存读写字段安全补齐；首轮与暖请求分开统计。'
          : '命中率按缓存读取 ÷（缓存读取 + 缓存写入 + 未命中）计算；首轮与暖请求分开统计。'} />
    ) : cacheDataStatus === 'partial' ? (
      <Banner type="warning" fullMode={false} title="上游只上报了部分缓存字段"
        description="上游未上报未命中 Token；页面会展示已上报缓存 Token 的覆盖率，但不把它冒充为严格命中率。" />
    ) : cacheDataStatus === 'unreported' ? (
      <Banner type="info" fullMode={false} title="上游未返回缓存字段"
        description="页面无法判断是否命中；显示为“—”不代表一定未命中，短 Prompt 也可能低于上游缓存生效阈值。" />
    ) : (
      <Banner type="info" fullMode={false} title="历史记录使用旧统计口径"
        description="新测试会区分首轮基线、暖请求和缓存字段完整性，重新运行可获得可比结果。" />
    )
  ) : null

  const roundColumns = [
    { title: '轮次', dataIndex: 'round', width: 64 },
    {
      title: '状态', width: 84,
      render: (_, row) => (
        row.status === 'ok' ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>
      ),
    },
    {
      title: '耗时', width: 96,
      render: (_, row) => (row.latency_ms == null ? '—' : `${formatNumber(row.latency_ms)} ms`),
    },
    { title: '输入 Token', width: 100, render: (_, row) => formatNumber(row.prompt_tokens) },
    { title: '输出 Token', width: 100, render: (_, row) => formatNumber(row.completion_tokens) },
    { title: '缓存读取', width: 100, render: (_, row) => formatReportedToken(row.cache_read_tokens, row.cache_read_tokens != null) },
    { title: '缓存写入', width: 100, render: (_, row) => formatReportedToken(row.cache_write_tokens, row.cache_write_tokens != null) },
    { title: '未命中', width: 90, render: (_, row) => formatReportedToken(row.cache_miss_tokens, row.cache_miss_tokens != null) },
    {
      title: '命中/覆盖', width: 112,
      render: (_, row) => {
        if (row.status !== 'ok') return '—'
        if (row.hit_ratio != null) return hitRatioTag(row.hit_ratio)
        if (row.cache_ratio_source === 'estimated' && row.cache_coverage != null) {
          return <Tag color="blue">≈{ratioToPercent(row.cache_coverage)}</Tag>
        }
        return hitRatioTag(null)
      },
    },
    {
      title: '缓存数据', width: 104,
      render: (_, row) => (
        row.status === 'ok' ? (
          <div>
            {cacheStatusTag(row.cache_status)}
            {row.cache_ratio_source && row.cache_status === 'complete' && (
              <Typography.Text type="tertiary" size="small" style={{ display: 'block' }}>
                {CACHE_RATIO_SOURCE_LABEL[row.cache_ratio_source] || row.cache_ratio_source}
              </Typography.Text>
            )}
          </div>
        ) : '—'
      ),
    },
    {
      title: '账号', width: 150,
      render: (_, row) => row.credential_name || (row.credential_id ? `#${row.credential_id}` : '—'),
    },
    { title: '实际上游模型', width: 150, render: (_, row) => row.upstream_model || '—' },
    {
      title: '错误',
      render: (_, row) => (row.error ? <Typography.Text type="danger" size="small">{row.error}</Typography.Text> : '—'),
    },
  ]

  const historyColumns = [
    { title: '名称', dataIndex: 'name', width: 170, ellipsis: true },
    { title: '模型', dataIndex: 'model', width: 190, ellipsis: true },
    { title: '轮数', dataIndex: 'rounds', width: 70 },
    {
      title: '状态', width: 100,
      render: (_, row) => (
        <Tag color={STATUS_META[row.status]?.color}>{STATUS_META[row.status]?.label || row.status}</Tag>
      ),
    },
    {
      title: '冷启动耗时', width: 112,
      render: (_, row) => (row.summary?.cold_latency_ms == null ? '—' : `${formatNumber(row.summary.cold_latency_ms)} ms`),
    },
    {
      title: '命中后平均', width: 112,
      render: (_, row) => (row.summary?.warm_avg_latency_ms == null ? '—' : `${formatNumber(row.summary.warm_avg_latency_ms)} ms`),
    },
    {
      title: '加速比', width: 90,
      render: (_, row) => (row.summary?.speedup_x == null ? '—' : `${row.summary.speedup_x}×`),
    },
    {
      title: '暖请求命中/覆盖', width: 132,
      render: (_, row) => {
        const exact = row.summary?.warm_hit_ratio ?? row.summary?.avg_hit_ratio
        if (exact != null) return ratioToPercent(exact)
        const coverage = row.summary?.warm_cache_coverage
        return coverage == null ? '—' : `≈${ratioToPercent(coverage)}`
      },
    },
    {
      title: '缓存数据', width: 104,
      render: (_, row) => cacheStatusTag(row.summary?.cache_data_status || 'legacy'),
    },
    {
      title: '账号', width: 150, ellipsis: true,
      render: (_, row) => (
        row.summary?.account_name
          ? row.summary.account_name
          : (row.summary?.account_consistent === false ? <Tag color="orange">中途换号</Tag> : '—')
      ),
    },
    { title: '时间', dataIndex: 'created_at', width: 175, render: formatTime },
    {
      title: '操作', width: 130,
      render: (_, row) => (
        <div className="cache-test-actions">
          <Button size="small" theme="borderless" loading={detailLoading} onClick={() => handleView(row.id)}>查看</Button>
          {canDelete && (
            <Popconfirm
              title="确认删除这条测试记录？"
              content="删除后不可恢复"
              onConfirm={() => handleDelete(row)}
            >
              <Button size="small" theme="borderless" type="danger" icon={<IconDelete />}
                loading={deleting === row.id} />
            </Popconfirm>
          )}
        </div>
      ),
    },
  ]

  return (
    <AgentPage
      title="缓存命中率测试"
      description="连续发送 N 轮完全相同的请求，分开观察首轮基线、暖请求命中率和上游缓存字段完整性。"
      contentTitle="测试工具"
    >
      <div className="cache-test-layout">
        <Card className="cache-test-form" title="新建测试">
          <div className="cache-test-form__intro">
            <span className="cache-test-form__intro-dot" />
            <div>
              <Typography.Text strong>建议用长前缀测试</Typography.Text>
              <Typography.Paragraph type="tertiary">
                短 Prompt 可能低于 Provider 的缓存阈值；建议粘贴一段稳定长文本，并至少运行 3 轮。
              </Typography.Paragraph>
            </div>
          </div>
          <div className="cache-test-form__field">
            <label>测试名称</label>
            <Input placeholder="如：长文档前缀缓存验证" value={form.name} maxLength={100}
              onChange={(value) => setField('name', value)} />
          </div>
          <div className="cache-test-form__field">
            <label>模型</label>
            <Select placeholder="选择模型" value={form.model} showClear
              optionList={modelOptions} onChange={(value) => setField('model', value)} />
          </div>
          <div className="cache-test-form__row">
            <div className="cache-test-form__field">
              <label>轮数（1-5）</label>
              <InputNumber min={1} max={5} value={form.rounds} style={{ width: '100%' }}
                onChange={(value) => setField('rounds', Number(value) || 3)} />
            </div>
            <div className="cache-test-form__field">
              <label>最大输出 Token</label>
              <InputNumber min={1} max={512} value={form.maxTokens} style={{ width: '100%' }}
                onChange={(value) => setField('maxTokens', Number(value) || 32)} />
            </div>
          </div>
          <div className="cache-test-form__field">
            <label>Prompt 内容</label>
            <TextArea rows={9} value={form.prompt}
              placeholder="输入测试 Prompt…（Prompt 越长越能体现上下文缓存优势，建议粘贴一段有真实内容的文本）"
              onChange={(value) => setField('prompt', value)} />
            <div className="cache-test-form__counter">{formatNumber(form.prompt.length)} / 200,000 字符</div>
          </div>
          <Button theme="solid" block loading={running} disabled={!canRun}
            onClick={handleRun} icon={<IconPulse />}>
            {running ? '正在运行测试（每轮调用上游，请稍候）…' : '运行测试'}
          </Button>
          <Banner type="info" fullMode={false} className="cache-test-form__tip"
            description="测试会真实调用上游模型并计入配额。首轮只作为基线，不保证一定未命中；所有轮次使用同一会话，个人渠道也会按会话稳定选择账号。" />
        </Card>

        <div className="cache-test-main">
          {result ? (
            <Card
              className="cache-test-result"
              title={<span className="cache-test-result__title">测试结果{result.name ? ` · ${result.name}` : ''}</span>}
              extra={<span className="cache-test-result__time">{formatTime(result.created_at)}</span>}
            >
              {consistencyBanner}
              {cacheDataBanner}
              <AgentStatCards columns={4} items={statItems} style={{ marginTop: 4 }} />
              <div className="cache-test-token-summary">
                <Typography.Text type="tertiary">成功轮 Token 汇总：</Typography.Text>
                <Typography.Text>输入 {formatNumber(summary.prompt_tokens)}</Typography.Text>
                <Typography.Text>输出 {formatNumber(summary.completion_tokens)}</Typography.Text>
                <Typography.Text>缓存读取 {formatNumber(summary.cache_read_tokens)}</Typography.Text>
                <Typography.Text>缓存写入 {formatNumber(summary.cache_write_tokens)}</Typography.Text>
                <Typography.Text>未命中 {formatNumber(summary.cache_miss_tokens)}</Typography.Text>
                {summary.warm_cache_coverage != null && (
                  <Typography.Text type="tertiary">暖请求覆盖率 ≈{ratioToPercent(summary.warm_cache_coverage)}</Typography.Text>
                )}
                <Typography.Text type="tertiary">全轮（含首轮）{ratioToPercent(summary.overall_hit_ratio)}</Typography.Text>
              </div>
              <Table className="cache-test-round-table" rowKey="round" size="small"
                columns={roundColumns} dataSource={result.round_details || []} pagination={false}
                scroll={{ x: 1320 }} />
            </Card>
          ) : (
            <Card className="cache-test-empty">
              <div className="cache-test-empty__inner">
                <IconPulse size="large" />
                <Typography.Text type="tertiary">尚无测试结果——填写左侧表单并点击「运行测试」</Typography.Text>
              </div>
            </Card>
          )}
        </div>
      </div>

      <Card className="cache-test-history" title="历史记录">
        <Input prefix={<IconSearch />} className="cache-test-history__search"
          placeholder="搜索名称 / 模型" value={search}
          onChange={(value) => { setPage(1); setSearch(value) }} />
        <Table rowKey="id" loading={listLoading} columns={historyColumns}
          dataSource={history.items || []}
          scroll={{ x: 1420 }}
          pagination={{
            currentPage: page,
            pageSize: 10,
            total: history.total,
            showSizeChanger: false,
            onPageChange: (nextPage) => setPage(nextPage),
          }} />
      </Card>
    </AgentPage>
  )
}
