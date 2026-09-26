import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { FormDialog } from '@/shared/components/FormDialog'
import { FormNumber } from '@/shared/components/FormFields'
import { listGateway, saveGateway } from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'
export default function UserLimitsDialog({ user }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const form = useForm({
    defaultValues: { daily_limit: null, concurrency_limit: 0, rpm_limit: 0 },
  })
  const inspect = async () => {
    setLoading(true)
    try {
      const values = await listGateway(`user-limits/${user.id}`)
      form.reset({
        daily_limit: values.daily_limit,
        concurrency_limit: values.concurrency_limit,
        rpm_limit: values.rpm_limit,
      })
      setOpen(true)
    } catch (error) {
      toast.apiError(error, '加载用户额度失败')
    } finally {
      setLoading(false)
    }
  }
  const save = async (values) => {
    try {
      await saveGateway('user-limits', values, user.id)
      toast.success('用户额度已保存')
      setOpen(false)
    } catch (error) {
      toast.apiError(error, '保存用户额度失败')
      throw error
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        disabled={loading}
        onClick={inspect}
      >
        {t('网关额度')}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="用户网关额度"
        description={t('配置 {{name}} 的全部访问密钥共享限制', {
          name: user.username,
        })}
        form={form}
        onSubmit={save}
        size="sm"
      >
        <p className="text-sm text-muted-foreground">
          {t('每日额度留空表示继承系统默认值。')}

          {t(
            '每日额度按网关业务时区重置，默认 Asia/Shanghai，包含输入与输出 Token。0 表示不额外限制；每个密钥自身的限制仍然生效。',
          )}
        </p>
        {[
          ['daily_limit', '每日 Token 上限', 1e12],
          ['concurrency_limit', '用户并发上限', 10000],
          ['rpm_limit', '每分钟请求上限', 1000000],
        ].map(([name, label, max]) => (
          <FormNumber
            key={name}
            control={form.control}
            name={name}
            label={label}
            min={0}
            max={max}
            rules={{
              required: name !== 'daily_limit',
              min: 0,
              max,
              validate: (value) =>
                (name === 'daily_limit' && value === null) ||
                Number.isInteger(value) ||
                t('请输入非负整数'),
            }}
          />
        ))}
      </FormDialog>
    </>
  )
}
