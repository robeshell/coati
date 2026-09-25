import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Form } from '@/components/ui/form'
import { Button } from '@/components/ui/button'
import { FormInput } from '@/shared/components/FormFields'
import PageHeader from '@/shared/components/PageHeader'
import { confirmDevice } from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'
export default function Device() {
  const { t } = useTranslation()
  const form = useForm({ defaultValues: { code: '' } }),
    [done, setDone] = useState(false),
    [busy, setBusy] = useState(false)
  const submit = async (v) => {
    setBusy(true)
    try {
      await confirmDevice(v.code)
      setDone(true)
    } catch (e) {
      toast.apiError(e, '授权失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="设备授权" />
      <div className="bg-card rounded-xl border p-6">
        {done ? (
          <p role="status">{t('已授权。请返回发起登录的应用继续。')}</p>
        ) : (
          <>
            <p className="text-muted-foreground mb-6 text-sm">
              {t(
                '仅输入你正在使用的应用显示的授权码。确认后，该应用可使用你的身份调用网关，凭证有效期 30 天，每日配额 100,000 Token。',
              )}
            </p>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(submit)} className="space-y-5">
                <FormInput
                  control={form.control}
                  name="code"
                  label="授权码"
                  rules={{ required: '请输入授权码' }}
                />
                <Button type="submit" disabled={busy}>
                  {t(busy ? '正在授权…' : '确认授权')}
                </Button>
              </form>
            </Form>
          </>
        )}
      </div>
    </div>
  )
}
