import { Typography } from '@douyinfe/semi-ui'
import StatCardGroup from '@/shared/components/statistics/StatCardGroup'
import './agent-page.css'

export function AgentPage({ title, description, actions, stats, filters, insights, contentTitle = '数据列表', children }) {
  return (
    <div className="agent-page">
      <header className="agent-page__header">
        <div>
          <Typography.Title heading={5} className="agent-page__title">{title}</Typography.Title>
          {description && <Typography.Paragraph type="tertiary" className="agent-page__description">{description}</Typography.Paragraph>}
        </div>
      </header>
      {stats && <section className="agent-page__stats">{stats}</section>}
      {filters && <section className="agent-page__filters">{filters}</section>}
      {insights && <section className="agent-page__insights">{insights}</section>}
      <section className="agent-page__content">
        <div className="agent-page__content-header">
          {contentTitle && <Typography.Text strong>{contentTitle}</Typography.Text>}
          {actions && <div className="agent-page__actions">{actions}</div>}
        </div>
        {children}
      </section>
    </div>
  )
}

export function AgentStatCards(props) {
  return <StatCardGroup {...props} />
}
