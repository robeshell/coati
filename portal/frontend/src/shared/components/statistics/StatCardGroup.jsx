import { Card, CardGroup, Skeleton, Typography } from '@douyinfe/semi-ui'
import AnimatedNumber from '@/shared/components/AnimatedNumber'
import './stat-card-group.css'

const { Text, Title } = Typography

export default function StatCardGroup({ items = [], loading = false, columns, className = '', style }) {
  return <CardGroup
    spacing={12}
    className={`app-stat-group ${className}`.trim()}
    style={{ ...style, '--app-stat-columns': Math.max(1, Math.min(6, Number(columns) || items.length || 1)) }}
  >
    {items.map((item) => <Card
      key={item.key || item.label}
      bordered
      className={`app-stat-card app-stat-card--${item.tone || 'blue'}`}
      bodyStyle={{ padding: 0 }}
    >
      <Skeleton
        active
        loading={Boolean(loading || item.loading)}
        placeholder={<Skeleton.Paragraph rows={2} style={{ padding: 18 }} />}
      >
        <div className="app-stat-card__body">
          <div className="app-stat-card__head">
            <Text type="tertiary" size="small">{item.label}</Text>
            {item.icon ? <span className="app-stat-card__icon">{item.icon}</span> : <i className="app-stat-card__dot" />}
          </div>
          <div className="app-stat-card__number">
            <Title heading={3}><AnimatedNumber value={item.value ?? 0} /></Title>
            {item.suffix && <Text type="tertiary" size="small">{item.suffix}</Text>}
          </div>
          {item.hint && <Text type="tertiary" size="small" className="app-stat-card__hint">{item.hint}</Text>}
        </div>
      </Skeleton>
    </Card>)}
  </CardGroup>
}
