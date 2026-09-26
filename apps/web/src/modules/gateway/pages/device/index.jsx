import { useTranslation } from 'react-i18next'
import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { useAuth } from '@/context/AuthContext'
import { Form } from '@/components/ui/form'
import { Button } from '@/components/ui/button'
import { FormInput } from '@/shared/components/FormFields'
import PageHeader from '@/shared/components/PageHeader'
import { confirmDevice, denyDevice } from '@/modules/gateway/api/gateway'

export default function Device() {
  const [params] = useSearchParams()
  const code = (params.get('user_code') || '').trim().toUpperCase()
  return <DeviceForm key={code} initialCode={code} />
}

function DeviceForm({ initialCode }) {
  const { t } = useTranslation()
  const { user, hasPermission } = useAuth()
  const form = useForm({ defaultValues: { code: initialCode } })
  const [done, setDone] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const pending = useRef(false)
  const allowed = hasPermission('gateway_device_confirm_action')
  const submit = async (values, action) => {
    if (pending.current || !allowed) return
    pending.current = true
    setBusy(action)
    setError('')
    try {
      await (action === 'confirm' ? confirmDevice : denyDevice)(
        values.code.trim().toUpperCase(),
      )
      setDone(action)
    } catch (failure) {
      const code =
        failure?.code ||
        failure?.error?.code ||
        failure?.error ||
        failure?.message
      setError(
        {
          invalid_user_code: '授权码无效，请核对发起登录的应用中显示的授权码。',
          expired_token: '授权码已过期，请在发起登录的应用中重新开始。',
          already_decided: '此授权请求已处理，请返回发起登录的应用查看结果。',
        }[code] || '处理授权失败，请稍后重试。',
      )
    } finally {
      pending.current = false
      setBusy('')
    }
  }
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="设备授权" />
      <div className="bg-card rounded-xl border p-6">
        {!allowed ? (
          <p role="alert">{t('当前账号没有设备授权权限，请联系管理员。')}</p>
        ) : done ? (
          <p role="status">
            {t(
              done === 'confirm'
                ? '已授权。请返回发起登录的应用继续。'
                : '已拒绝授权。该应用不会获得访问令牌。',
            )}
          </p>
        ) : (
          <>
            <p className="mb-3 break-words text-sm font-medium">
              {t('当前账号：{{username}}', { username: user?.username || '' })}
            </p>
            <p className="text-muted-foreground mb-6 text-sm">
              {t(
                '仅输入你正在使用的应用显示的授权码。确认后，该应用可调用模型并读取你的个人资料，凭证有效期 30 天，用量受你的共享配额与限流规则约束。',
              )}
            </p>
            <Form {...form}>
              <form
                onSubmit={(event) =>
                  form.handleSubmit((values) => submit(values, 'confirm'))(
                    event,
                  )
                }
                className="space-y-5"
                aria-busy={Boolean(busy)}
              >
                <FormInput
                  control={form.control}
                  name="code"
                  label="授权码"
                  disabled={Boolean(busy)}
                  autoComplete="off"
                  inputClassName="font-mono uppercase"
                  rules={{
                    validate: (value) =>
                      value.trim().length > 0 || t('请输入授权码'),
                    maxLength: {
                      value: 32,
                      message: t('授权码不能超过 32 个字符'),
                    },
                  }}
                />
                {error && (
                  <p role="alert" className="text-destructive text-sm">
                    {t(error)}
                  </p>
                )}
                <div className="flex flex-wrap gap-3">
                  <Button type="submit" disabled={Boolean(busy)}>
                    {t(busy === 'confirm' ? '正在授权…' : '确认授权')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={(event) =>
                      form.handleSubmit((values) => submit(values, 'deny'))(
                        event,
                      )
                    }
                  >
                    {t(busy === 'deny' ? '正在拒绝…' : '拒绝授权')}
                  </Button>
                </div>
              </form>
            </Form>
          </>
        )}
      </div>
    </div>
  )
}
