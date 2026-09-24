export function formatNumber(value) {
  const number = Number(value ?? 0)
  return (Number.isFinite(number) ? number : 0).toLocaleString('zh-CN')
}

/** Token 在页面正文中统一展示完整数值，避免不同页面出现 16,885 / 16.9K 两种口径。 */
export function formatTokenCount(value) {
  return formatNumber(value)
}

// 模型能力统一使用常见档位，避免手填任意数字造成路由和本地压缩配置不一致。
export const MODEL_CONTEXT_WINDOW_PRESETS = [
  { label: '32K', value: 32768 },
  { label: '64K', value: 65536 },
  { label: '128K', value: 131072 },
  { label: '200K', value: 200000 },
  { label: '256K', value: 262144 },
  { label: '512K', value: 524288 },
  { label: '1M', value: 1000000 },
]

export const MODEL_MAX_OUTPUT_PRESETS = [
  { label: '4K', value: 4096 },
  { label: '8K', value: 8192 },
  { label: '16K', value: 16384 },
  { label: '32K', value: 32768 },
  { label: '64K', value: 65536 },
  { label: '128K', value: 131072 },
]

/**
 * 缓存字段统一口径：只有 read/miss 都已知时才计算命中率，且把 cache write
 * 计入分母；避免把“未上报”误显示成 0%。
 */
export function getUsageCacheInfo(row = {}) {
  const normalize = (value) => {
    if (value === null || value === undefined || value === '') return null
    const number = Number(value)
    return Number.isFinite(number) ? Math.max(0, number) : null
  }
  const read = normalize(row.cache_read_tokens)
  const write = normalize(row.cache_write_tokens)
  const miss = normalize(row.cache_miss_tokens)
  const prompt = Number(row.prompt_tokens || 0)
  const observed = (read ?? 0) + (write ?? 0) + (miss ?? 0)
  const hasAny = read !== null || write !== null || miss !== null
  const complete = prompt > 0 && read !== null && miss !== null && observed === prompt
  const hitRate = complete && observed > 0 ? Math.round(read / observed * 1000) / 10 : null
  return {
    read: read ?? 0,
    write: write ?? 0,
    miss: miss ?? 0,
    readReported: read !== null,
    writeReported: write !== null,
    missReported: miss !== null,
    prompt, observed, hasAny, hitRate,
    complete,
  }
}

export function formatReportedToken(value, reported = true) {
  return reported ? formatTokenCount(value) : '—'
}

/** 仅用于图表坐标轴等空间有限的位置。 */
export function formatCompactNumber(value) {
  const number = Number(value ?? 0)
  const safeNumber = Number.isFinite(number) ? number : 0
  if (safeNumber >= 1000000) return `${(safeNumber / 1000000).toFixed(1)}M`
  if (safeNumber >= 1000) return `${(safeNumber / 1000).toFixed(1)}K`
  return String(safeNumber)
}

export function formatTime(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })
}

export const USER_AGENT_PRESETS = [
  { label: 'claude-cli/2.1.161 (external, cli)', value: 'claude-cli/2.1.161 (external, cli)' },
  { label: 'claude-cli/2.1.161', value: 'claude-cli/2.1.161' },
  { label: 'claude-code/1.0.0', value: 'claude-code/1.0.0' },
  { label: 'claude-code/0.1.0', value: 'claude-code/0.1.0' },
  { label: 'Kilo-Code/1.0', value: 'Kilo-Code/1.0' },
]

export function userAgentFromHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return ''
  const entry = Object.entries(headers).find(([key]) => String(key).toLowerCase() === 'user-agent')
  return entry && entry[1] != null ? String(entry[1]) : ''
}

export function userAgentPresetFromHeaders(headers) {
  const value = userAgentFromHeaders(headers)
  return USER_AGENT_PRESETS.some((item) => item.value === value) ? value : ''
}

export const USAGE_PERIOD_LABELS = {
  1: '近 24 小时',
  7: '近 7 天',
  30: '近 30 天',
  90: '近 90 天',
}

export const USAGE_PERIOD_OPTIONS = Object.entries(USAGE_PERIOD_LABELS).map(([value, label]) => ({
  value: Number(value),
  label,
}))

/** 列表与 analytics 共用查询参数，避免统计卡片与表格筛选口径不一致。 */
export function buildUsageQuery({ filters, page, per_page } = {}) {
  const params = { days: filters.days }
  if (page) params.page = page
  if (per_page) params.per_page = per_page
  if (filters.status) params.status = filters.status
  if (filters.pat_id) params.pat_id = filters.pat_id
  if (filters.user_id) params.user_id = filters.user_id
  if (filters.model) params.model = filters.model
  return params
}

/** 后端模型分布 -> 排行行。占比分母由后端给出（全部模型合计，非 Top N 相加）。 */
export function buildModelRankRows(items, limit = 5) {
  return (items || []).slice(0, limit).map((item) => ({
    label: item.model || '未上报模型',
    tokens: Number(item.tokens || 0),
    share: Number(item.share_percent || 0),
    filterValue: item.model || '',
    hint: `${formatNumber(item.requests)} 次请求 · 入 ${formatTokenCount(item.prompt_tokens)} / 出 ${formatTokenCount(item.completion_tokens)}`,
  }))
}

/**
 * 用户排行 -> 排行行。占比按当前筛选范围的合计计算，
 * 因此按模型下钻后即「该模型内的人员分布」。
 */
export function buildUserRankRows(items, totalTokens, limit = 5) {
  const total = Number(totalTokens || 0)
  return (items || []).slice(0, limit).map((item) => {
    const tokens = Number(item.tokens || 0)
    return {
      label: item.username || `用户 #${item.user_id}`,
      tokens,
      share: total ? tokens / total * 100 : 0,
      filterValue: item.user_id,
      hint: `${formatNumber(item.requests)} 次请求 · 异常 ${formatNumber(item.errors)} 次`,
    }
  })
}
