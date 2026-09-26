import { useTranslation } from 'react-i18next'
import StatusBadge from '@/shared/components/StatusBadge'
export default function AccountHealth({ account }) {
  const { t } = useTranslation()
  const deadline = account.cooldown_until ? Date.parse(account.cooldown_until) : 0
  const cooling = deadline > Date.now()
  const expired = account.health_status === 'cooldown' && !cooling
  const label = cooling ? '冷却中' : expired ? '待恢复验证' : account.health_status === 'healthy' ? '健康' : account.health_status === 'unhealthy' ? '异常' : '未验证'
  return (
    <div className="space-y-1 text-sm">
      <StatusBadge tone={cooling || account.health_status === 'unhealthy' ? 'warning' : account.health_status === 'healthy' ? 'success' : 'neutral'}>{t(label)}</StatusBadge>
      {cooling && <p className="text-xs text-muted-foreground">{t('冷却截止')} {new Date(deadline).toLocaleString()}</p>}
      {account.last_error && <details className="max-w-72"><summary className="cursor-pointer text-xs text-muted-foreground">{t('最近错误')}</summary><p className="mt-1 whitespace-pre-wrap break-all text-xs">{account.last_error}</p></details>}
    </div>
  )
}
