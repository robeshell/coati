import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import PageHeader from '@/shared/components/PageHeader'
import StatusBadge from '@/shared/components/StatusBadge'
import ConfirmAction from '@/shared/components/ConfirmAction'
import {
  routeMigrationPreflight,
  routeMigrationHistory,
  applyRouteMigration,
  rollbackRouteMigration,
} from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'

const statuses = {
  ready_for_review: ['可迁移', 'success'],
  manual_review: ['需选择迁移策略', 'warning'],
  blocked: ['需先修正配置', 'danger'],
}
export default function RouteMigration() {
  const { t } = useTranslation()
  const { hasPermission } = useAuth()
  const [report, setReport] = useState(null)
  const [history, setHistory] = useState([])
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const active = useRef(false)
  const canWrite = hasPermission('gateway_routes_edit')
  const reload = () => {
    setLoading(true)
    setRefresh((value) => value + 1)
  }
  useEffect(() => {
    let current = true
    Promise.allSettled([
      routeMigrationPreflight(),
      routeMigrationHistory(),
    ]).then(([preflight, records]) => {
      if (!current) return
      setReport(preflight.status === 'fulfilled' ? preflight.value : null)
      setHistory(records.status === 'fulfilled' ? records.value.items : [])
      setErrors({
        preflight: preflight.status === 'rejected',
        history: records.status === 'rejected',
      })
      setLoading(false)
    })
    return () => {
      current = false
    }
  }, [refresh])
  const perform = async (operation) => {
    if (active.current) throw new Error('Operation in progress')
    active.current = true
    setBusy(true)
    try {
      await operation()
      toast.success('操作成功')
      reload()
    } catch (error) {
      toast.apiError(error, '操作失败，请重新预检后重试')
      throw error
    } finally {
      active.current = false
      setBusy(false)
    }
  }
  const matches = (row) =>
    row.model.toLowerCase().includes(search.trim().toLowerCase())
  const candidates = report?.items.filter(matches) || []
  return (
    <div className="space-y-6">
      <PageHeader
        title="路由迁移"
        description="先检查候选差异，再迁移为公开路由。原配置会归档，可在记录中回滚。"
        actions={
          <Button variant="outline" disabled={loading || busy} onClick={reload}>
            {t('重新预检')}
          </Button>
        }
      />
      <Input
        aria-label={t('搜索迁移模型')}
        placeholder={t('搜索迁移模型')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="max-w-sm"
      />
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('正在检查配置…')}
        </p>
      )}
      {errors.preflight && !loading && (
        <p role="alert" className="text-sm text-destructive">
          {t('预检加载失败，请重新预检。')}
        </p>
      )}
      {!loading && report && (
        <section aria-label={t('待迁移配置')}>
          <p className="mb-3 text-sm text-muted-foreground tabular-nums">
            {t('共 {{total}} 个模型 · 可迁移 {{ready}} · 需处理 {{other}}', {
              total: report.summary.total,
              ready: report.summary.ready_for_review,
              other: report.summary.manual_review + report.summary.blocked,
            })}
          </p>
          {candidates.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t(search ? '没有匹配的模型' : '没有待迁移的候选配置')}
            </p>
          ) : (
            <div className="divide-y rounded-lg border">
              {candidates.map((row) => (
                <article key={row.model} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 space-y-2">
                      <h2 className="break-all text-sm font-semibold">
                        {row.model}
                      </h2>
                      <StatusBadge tone={statuses[row.status]?.[1]}>
                        {t(statuses[row.status]?.[0] || '未知')}
                      </StatusBadge>
                    </div>
                    {canWrite && row.status === 'ready_for_review' && (
                      <ConfirmAction
                        destructive={false}
                        title={t('迁移 {{model}}？', { model: row.model })}
                        confirmText="确认迁移"
                        description={t(
                          '将保留绑定账号和模型配置，关闭自动回退。旧候选配置归档后不再参与调度。',
                        )}
                        onConfirm={() =>
                          perform(() =>
                            applyRouteMigration({
                              model: row.model,
                              version: row.version,
                            }),
                          )
                        }
                      >
                        <Button size="sm" disabled={busy}>
                          {t('迁移此模型')}
                        </Button>
                      </ConfirmAction>
                    )}
                  </div>
                  <ul className="space-y-1 text-sm text-muted-foreground">
                    {row.candidates.map((item) => (
                      <li key={item.source_id} className="break-words">
                        {item.account_name ||
                          `${t('账号编号')} ${item.account_id}`}{' '}
                        · {item.upstream_model}{' '}
                        {item.vision_model && ` / ${item.vision_model}`} ·{' '}
                        {t(item.enabled ? '启用' : '停用')}
                        {item.has_base_override && ` · ${t('独立覆盖地址')}`}
                      </li>
                    ))}
                  </ul>
                  {row.reasons.length > 0 && (
                    <ul className="list-inside list-disc space-y-1 text-sm">
                      {row.reasons.map((reason) => (
                        <li key={reason.code}>{t(reason.message)}</li>
                      ))}
                    </ul>
                  )}
                  {row.proposal && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-primary">
                        {t('查看迁移结果')}
                      </summary>
                      <dl className="mt-3 grid gap-2 break-all text-muted-foreground sm:grid-cols-2">
                        <div>
                          <dt>{t('上游模型')}</dt>
                          <dd className="text-foreground">
                            {row.proposal.upstream_model || row.model}
                          </dd>
                        </div>
                        <div>
                          <dt>{t('含图模型')}</dt>
                          <dd className="text-foreground">
                            {row.proposal.vision_model || '—'}
                          </dd>
                        </div>
                        <div>
                          <dt>{t('路由上游地址覆盖')}</dt>
                          <dd className="text-foreground">
                            {row.proposal.upstream_base || '—'}
                          </dd>
                        </div>
                        <div>
                          <dt>{t('自动回退')}</dt>
                          <dd className="text-foreground">{t('关闭')}</dd>
                        </div>
                      </dl>
                    </details>
                  )}
                  {row.additional_accounts.length > 0 && (
                    <p className="break-words text-sm text-muted-foreground">
                      {t('自动池中的其他账号')}：
                      {row.additional_accounts
                        .map((item) => item.name)
                        .join('、')}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      <section aria-label={t('迁移记录')} className="space-y-3">
        <h2 className="text-base font-semibold">{t('迁移记录')}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            '回滚恢复原候选配置与编号；公开路由已修改或删除时，系统会拒绝覆盖。',
          )}
        </p>
        {!loading && errors.history && (
          <p role="alert" className="text-sm text-destructive">
            {t('迁移记录加载失败，请重新预检。')}
          </p>
        )}
        {!loading &&
          !errors.history &&
          (history.filter(matches).length ? (
            <div className="divide-y rounded-lg border">
              {history.filter(matches).map((row) => (
                <article
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-4"
                >
                  <div className="min-w-0 space-y-1 text-sm">
                    <h3 className="break-all font-medium">{row.model}</h3>
                    <p className="break-all text-muted-foreground">
                      {t('原路由编号')}{' '}
                      {row.source_routes.map((item) => item.id).join(', ')} →{' '}
                      {t('公开路由编号')} {row.public_route.id}
                    </p>
                    <p className="text-muted-foreground">
                      {new Date(row.created_at).toLocaleString()}
                    </p>
                    <StatusBadge tone={row.rolled_back_at ? 'neutral' : 'info'}>
                      {t(row.rolled_back_at ? '已回滚' : '已迁移')}
                    </StatusBadge>
                  </div>
                  {canWrite && !row.rolled_back_at && (
                    <ConfirmAction
                      title={t('回滚 {{model}}？', { model: row.model })}
                      confirmText="确认回滚"
                      description={t(
                        '将恢复归档的候选配置，移除本次创建的公开路由。使用记录和账号配置保持不变。',
                      )}
                      onConfirm={() =>
                        perform(() => rollbackRouteMigration(row.id))
                      }
                    >
                      <Button size="sm" variant="outline" disabled={busy}>
                        {t('回滚')}
                      </Button>
                    </ConfirmAction>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('暂无迁移记录')}
            </p>
          ))}
      </section>
    </div>
  )
}
