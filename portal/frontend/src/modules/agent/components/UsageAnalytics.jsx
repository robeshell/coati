import { Card, Empty, Typography } from '@douyinfe/semi-ui'
import AnimatedNumber from '@/shared/components/AnimatedNumber'
import './usage-analytics.css'

/**
 * 用量分析共享件（统计卡壳 + 模型 / 用户维度排行）。
 * 个人看板、使用日志、用量配额共用同一套口径与样式，
 * 避免同一个「模型使用统计」在多个页面写出多种排版。
 */

/** 统计区通用卡片：标题 + 右侧提示 + 空态。 */
export function UsageAnalyticsCard({ title, extra, empty, emptyTitle = '暂无数据', children }) {
  return <Card
    bordered
    className="usage-analytics-card"
    header={<div className="usage-analytics-card__head">
      <Typography.Text strong>{title}</Typography.Text>
      {extra && <Typography.Text type="tertiary" size="small">{extra}</Typography.Text>}
    </div>}
    headerStyle={{ padding: '14px 18px 8px' }}
    bodyStyle={{ padding: '0 18px 16px' }}
  >
    {empty ? <Empty className="usage-empty" title={emptyTitle} /> : children}
  </Card>
}

/** 紧凑排行：序号 + 名称 + 完整 Token 数值 + 占比 + 底部占比条，整行可点击下钻。 */
export function UsageRanking({ rows = [], activeValue, onSelect, className = '', emptyTitle = '暂无用量' }) {
  const maximum = Math.max(...rows.map((row) => Number(row.tokens) || 0), 1)
  if (!rows.length) return <div className="usage-rank__empty">{emptyTitle}</div>
  return <div className={`usage-rank${className ? ` ${className}` : ''}`}>
    {rows.map((row, index) => {
      const selected = Boolean(row.filterValue) && activeValue === row.filterValue
      return <button
        type="button"
        key={`${row.label}-${index}`}
        className={`usage-rank__row${selected ? ' is-active' : ''}`}
        disabled={!row.filterValue || !onSelect}
        title={row.filterValue ? (selected ? '点击取消筛选' : row.hint) : row.hint}
        onClick={() => onSelect && onSelect(selected ? '' : row.filterValue)}
      >
        <b className="usage-rank__index">{index + 1}</b>
        <span className="usage-rank__name">{row.label}</span>
        <span className="usage-rank__value"><AnimatedNumber value={row.tokens} /></span>
        <span className="usage-rank__share">{Number(row.share || 0).toFixed(1)}%</span>
        <i className="usage-rank__bar" style={{ width: `${Math.max(3, (Number(row.tokens) || 0) / maximum * 100)}%` }} />
      </button>
    })}
  </div>
}

export default UsageRanking
