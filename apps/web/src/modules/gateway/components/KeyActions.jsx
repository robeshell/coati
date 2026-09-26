import { useEffect, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { FormDialog } from '@/shared/components/FormDialog'
import {
  FormInput,
  FormNumber,
  FormSelect,
} from '@/shared/components/FormFields'
import ConfirmAction from '@/shared/components/ConfirmAction'
import { saveGateway, rotateKey } from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'

export default function KeyActions({
  record,
  canEdit,
  canRotate,
  onToken,
  onComplete,
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [])
  const form = useForm({
    defaultValues: { name: record.name, expiry_mode: '', expires_days: 30 },
  })
  const mode = useWatch({ control: form.control, name: 'expiry_mode' })
  const active =
    !record.revoked &&
    (!record.expires_at || Date.parse(record.expires_at) > now)
  const edit = () => {
    form.reset({ name: record.name, expiry_mode: '', expires_days: 30 })
    setOpen(true)
  }
  const save = async (values) => {
    try {
      await saveGateway(
        'keys',
        {
          name: values.name,
          expires_days:
            values.expiry_mode === 'unlimited' ? null : values.expires_days,
        },
        record.id,
      )
      setOpen(false)
      toast.success('已保存')
      await onComplete?.()
    } catch (error) {
      toast.apiError(error, '保存失败')
      throw error
    }
  }
  const rotate = async () => {
    try {
      const replacement = await rotateKey(record.id)
      onToken(replacement.token)
      await onComplete?.()
    } catch (error) {
      toast.apiError(error, '密钥轮换失败')
      throw error
    }
  }
  if (!active) return null
  return (
    <>
      {canEdit && record.kind === 'personal' && (
        <Button size="sm" variant="ghost" onClick={edit}>
          {t('编辑')}
        </Button>
      )}
      {canRotate && (
        <ConfirmAction
          title="轮换此访问密钥？"
          description="旧密钥将立即失效。请保存新密钥并更新调用方；已有用量和在途请求继续计入限额。"
          onConfirm={rotate}
        >
          <Button size="sm" variant="ghost">
            {t('轮换密钥')}
          </Button>
        </ConfirmAction>
      )}
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="编辑访问密钥"
        description="保存时重新设置有效期，请明确选择期限；模型权限与限额保持不变。"
        form={form}
        onSubmit={save}
        size="sm"
      >
        <FormInput
          control={form.control}
          name="name"
          label="名称"
          rules={{ required: t('请输入名称'), maxLength: 100 }}
        />
        <FormSelect
          clearable
          control={form.control}
          name="expiry_mode"
          label="新的有效期"
          rules={{ required: t('请选择有效期') }}
          options={[
            { value: 'unlimited', label: '长期有效' },
            { value: 'days', label: '从现在起按天计算' },
          ]}
        />
        {mode === 'days' && (
          <FormNumber
            control={form.control}
            name="expires_days"
            label="有效天数"
            min={1}
            max={3650}
            rules={{
              required: true,
              min: 1,
              max: 3650,
              validate: Number.isInteger,
            }}
          />
        )}
      </FormDialog>
    </>
  )
}
