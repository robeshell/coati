import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { probeAccount } from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'

export default function ProbeAccount({ account, onComplete }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const pending = useRef(false)
  const run = async () => {
    if (pending.current || !account.enabled) return
    pending.current = true
    setBusy(true)
    setResult(null)
    try {
      setResult(await probeAccount(account.id))
    } catch (error) {
      toast.apiError(error, '账号探测失败')
    } finally {
      try { await onComplete?.() }
      finally {
        pending.current = false
        setBusy(false)
      }
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || !account.enabled}
        onClick={run}
      >
        {t(busy ? '探测中' : '恢复探测')}
      </Button>
      <Dialog
        open={Boolean(result)}
        onOpenChange={(open) => !open && setResult(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('账号探测结果')}</DialogTitle>
            <DialogDescription>{account.name}</DialogDescription>
          </DialogHeader>
          {result && (
            <div className="space-y-3 text-sm">
              <p>
                {t(
                  result.health_updated
                    ? '已验证并恢复账号健康'
                    : result.verified
                      ? '模型列表可用；账号状态已变化，本次未更新健康状态'
                      : '模型发现不代表对话可用，账号健康状态未改变',
                )}
              </p>
              <p className="text-muted-foreground">
                {t('探测耗时')}：{result.latency_ms} ms
              </p>
              <div className="max-h-64 overflow-auto rounded-md border p-3">
                {result.models.length ? (
                  <ul className="space-y-1 break-all">
                    {result.models.map((model) => (
                      <li key={model}>{model}</li>
                    ))}
                  </ul>
                ) : (
                  <p>{t('未发现模型，请手动配置')}</p>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
