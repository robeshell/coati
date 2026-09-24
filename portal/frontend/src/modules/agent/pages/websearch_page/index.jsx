import { useCallback, useEffect, useState } from 'react'
import { Banner, Button, Card, Form, Spin, Toast, Typography } from '@douyinfe/semi-ui'
import { IconPulse, IconSave } from '@douyinfe/semi-icons'
import { useAuth } from '@/context/AuthContext'
import {
  getWebSearchSettings,
  updateWebSearchSettings,
  testWebSearchSettings,
} from '@/modules/agent/api/websearch'

const { Title, Text } = Typography

// 搜索后端选项。新增一家需同时在后端 WEB_SEARCH_PROVIDERS 中登记。
const PROVIDERS = [
  { value: '', label: '不启用（委托模型账号搜索）' },
  { value: 'tavily', label: 'Tavily' },
]

export default function AgentWebSearchPage() {
  const { hasPermission } = useAuth()
  const canEdit = hasPermission('agent_websearch_edit')

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [data, setData] = useState(null)
  const [formKey, setFormKey] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getWebSearchSettings()
      setData(res || {})
      setFormKey((k) => k + 1)
    } catch (e) {
      Toast.error(e?.error || '加载网页搜索配置失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleSubmit = async (values) => {
    setSaving(true)
    try {
      const res = await updateWebSearchSettings({
        provider: String(values.provider ?? '').trim(),
        // 掩码原样回传表示保持不变，后端据此不覆盖已存的密钥。
        api_key: values.api_key,
        proxy_url: String(values.proxy_url ?? '').trim(),
        timeout_seconds: String(values.timeout_seconds ?? '').trim(),
      })
      setData(res || {})
      setFormKey((k) => k + 1)
      Toast.success('已保存，立即生效')
    } catch (e) {
      Toast.error(e?.error || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const res = await testWebSearchSettings()
      Toast.success(`连通正常：${res.provider} 返回 ${res.result_count} 条结果`)
    } catch (e) {
      Toast.error(e?.error || '测试失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <Title heading={5} style={{ marginBottom: 12 }}>网页搜索</Title>

      <Banner
        type="info"
        closeIcon={null}
        style={{ marginBottom: 16 }}
        description={
          <span>
            客户端请求 <Text code>web_search</Text> / <Text code>web_fetch</Text> 时，
            网关按此顺序选择执行方：<b>① 上游账号原生执行</b>（结果最好）→
            <b> ② 这里配置的搜索后端</b>（快且稳定）→
            <b> ③ 委托号池里能搜的模型账号</b>（兜底）。
            留空即只保留 ①③，行为与配置前一致。
          </span>
        }
      />

      <Card bordered>
        <Spin spinning={loading}>
          {data && (
            <Form
              key={formKey}
              initValues={data}
              onSubmit={handleSubmit}
              disabled={!canEdit}
              labelPosition="top"
            >
              <Form.Select
                field="provider"
                label="搜索后端"
                optionList={PROVIDERS}
                extraText="留空则回退到「委托号池里能搜的模型账号」"
                style={{ width: '100%', maxWidth: 460 }}
              />
              <Form.Input
                field="api_key"
                label="API Key"
                mode="password"
                placeholder={data.has_api_key ? '已配置，留空则保持不变' : 'tvly-...'}
                extraText="密文存储，保存后不再回显"
                autoComplete="new-password"
                style={{ maxWidth: 460 }}
              />
              <Form.Input
                field="proxy_url"
                label="出站代理"
                placeholder="http://127.0.0.1:7897"
                extraText="可选。Tavily 国内可直连；需要代理的后端再填"
                showClear
                style={{ maxWidth: 460 }}
              />
              <Form.Input
                field="timeout_seconds"
                label="超时（秒）"
                placeholder="15"
                extraText="3–60 秒，留空用默认值 15"
                showClear
                style={{ maxWidth: 460 }}
              />
              <div style={{ marginTop: 20 }}>
                {canEdit ? (
                  <>
                    <Button theme="solid" type="primary" htmlType="submit" icon={<IconSave />} loading={saving}>
                      保存
                    </Button>
                    <Button
                      icon={<IconPulse />}
                      loading={testing}
                      disabled={!data.has_api_key}
                      onClick={handleTest}
                      style={{ marginLeft: 8 }}
                    >
                      测试连通
                    </Button>
                  </>
                ) : (
                  <Text type="tertiary">仅查看模式：你没有编辑权限（agent_websearch_edit）。</Text>
                )}
              </div>
            </Form>
          )}
        </Spin>
      </Card>
    </div>
  )
}
