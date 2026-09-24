import { useEffect, useState } from 'react'
import { Banner, Button, Card, Descriptions, Form, Toast, Typography } from '@douyinfe/semi-ui'
import {
  IconArrowRight,
  IconCheckboxTick,
  IconLock,
  IconShield,
} from '@douyinfe/semi-icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { confirmDevice } from '@/modules/agent/api/device'
import './device-confirm.css'

const CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/
const { Title, Text } = Typography

export default function AgentDeviceConfirmPage() {
  const { hasPermission, user } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [formKey, setFormKey] = useState(0)
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const code = (params.get('user_code') || '').toUpperCase()

  useEffect(() => {
    setFormKey((key) => key + 1)
    setConfirmed(false)
  }, [code])

  const submit = async ({ user_code }) => {
    setSubmitting(true)
    try {
      await confirmDevice(user_code.trim().toUpperCase())
      setConfirmed(true)
      Toast.success('登录请求已确认')
    } catch (error) {
      Toast.error(error?.error || '确认失败，请核对用户码后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="device-confirm-page">
      <Card bordered shadows="always" className="device-confirm-card" bodyStyle={{ padding: 0 }}>
        <div className="device-confirm-card__body">
        {confirmed ? (
          <div className="device-confirm-success">
            <div className="device-confirm-success__icon"><IconCheckboxTick /></div>
            <Title heading={3}>登录已授权</Title>
            <Text type="tertiary">请返回发起登录的应用，登录将自动完成。</Text>
            {code && <code>{code}</code>}
            <Button theme="solid" size="large" block onClick={() => navigate('/dashboard')}>
              返回工作台
            </Button>
          </div>
        ) : (
          <>
            <header className="device-confirm-heading">
              <div className="device-confirm-heading__icon"><IconShield /></div>
              <Title heading={3}>确认登录请求</Title>
              <Text type="tertiary">核对发起登录时显示的用户码和当前账号。</Text>
            </header>

            <Form key={formKey} className="device-confirm-form" onSubmit={submit} initValues={{ user_code: code }}>
              <Form.Input
                field="user_code"
                label="登录用户码"
                placeholder="ABCD-EFGH"
                size="large"
                maxLength={9}
                className="device-confirm-code-input"
                rules={[
                  { required: true, message: '请输入发起登录时显示的用户码' },
                  { validator: (_, value) => CODE_PATTERN.test(String(value || '').trim().toUpperCase()), message: '请输入格式为 ABCD-EFGH 的用户码' },
                ]}
              />

              <Descriptions
                className="device-confirm-account"
                size="small"
                row
                data={[{ key: '授权账号', value: <strong>{user?.username || '当前登录账号'}</strong> }]}
              />

              <Banner
                className="device-confirm-warning"
                type="warning"
                fullMode={false}
                icon={<IconLock />}
                description="如果这不是你发起的登录请求，请不要确认。"
              />

              <Button
                htmlType="submit"
                theme="solid"
                size="large"
                block
                loading={submitting}
                disabled={!hasPermission('agent_device_confirm_action')}
                icon={<IconArrowRight />}
                iconPosition="right"
              >
                确认登录
              </Button>
              {!hasPermission('agent_device_confirm_action') && (
                <Text type="danger" className="device-confirm-permission">当前账号没有登录授权权限，请联系管理员。</Text>
              )}
            </Form>

            <footer className="device-confirm-footer">
              确认后会创建一个 30 天令牌，可在“访问令牌”中撤销。
            </footer>
          </>
        )}
        </div>
      </Card>
    </main>
  )
}
