import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, Form, Spin, Tabs, TabPane, Toast, Typography } from '@douyinfe/semi-ui'
import { IconInfoCircle, IconSave } from '@douyinfe/semi-icons'
import { useAuth } from '@/context/AuthContext'
import {
  getDesktopUpdateSettings,
  updateDesktopUpdateSettings,
  getSiteDownloadSettings,
  updateSiteDownloadSettings,
} from '@/modules/admin/api/settings'
import './settings.css'

const { Title, Text } = Typography

const PAIR_MESSAGE = '平台模式需同时填写版本平台地址与应用标识，或两者同时留空'
const PAIR_FIELDS = ['release_api_base', 'release_identifier']
const SAVE_KEYS = [...PAIR_FIELDS, 'release_template', 'update_url']

// 桌面端更新配置（字段名与后端 DESKTOP_UPDATE_FIELD_MAP 一致）
const DESKTOP_FIELDS = [
  {
    field: 'release_api_base',
    label: '版本平台地址',
    placeholder: 'https://portal.example.com',
    hint: '平台模式必填，需为 HTTPS',
  },
  {
    field: 'release_identifier',
    label: '应用标识',
    placeholder: 'cn.net.coatiode',
    hint: '与客户端打包 appId 一致',
  },
  {
    field: 'release_template',
    label: '输出模板',
    placeholder: 'electron.json',
    hint: '版本平台输出模板，默认 electron.json',
  },
  {
    field: 'update_url',
    label: '静态更新目录',
    placeholder: 'https://example.com/coati/updates',
    hint: '备用模式，可选；留空则不启用',
  },
]

// 产品站下载配置（字段名与 site/ 的 window.COATI_SITE_CONFIG.downloads 一致）
const SITE_DOWNLOAD_FIELDS = [
  {
    field: 'macDmg',
    label: 'macOS 安装包',
    placeholder: 'https://.../COATI-Code-0.1.0.dmg',
    hint: '桌面端 .dmg；留空则下载按钮置灰',
  },
  {
    field: 'macZip',
    label: 'macOS 压缩包',
    placeholder: 'https://.../COATI-Code-0.1.0-mac.zip',
    hint: '桌面端 .zip，可选',
  },
  {
    field: 'windowsExe',
    label: 'Windows 安装包',
    placeholder: 'https://.../COATI-Code-Setup-0.1.0.exe',
    hint: '桌面端 .exe；留空则下载按钮置灰',
  },
  {
    field: 'cliNpm',
    label: 'CLI npm 页面',
    placeholder: 'https://www.npmjs.com/package/@coati/code',
    hint: '命令行 coati 的 npm 链接',
  },
]

function DesktopUpdateCard({ canEdit }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState(null)
  const [formKey, setFormKey] = useState(0)
  const formApiRef = useRef()

  const loadSettings = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getDesktopUpdateSettings()
      setData(res || {})
      setFormKey((key) => key + 1)
    } catch (e) {
      Toast.error(e?.error || '加载系统设置失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadSettings() }, [loadSettings])

  const clearPairErrors = () => {
    const api = formApiRef.current
    if (!api) return
    PAIR_FIELDS.forEach((field) => api.setError(field, undefined))
  }

  // 平台模式配对检查：地址与标识同填或同空（静态目录模式）；违反时在缺失字段旁行内报错
  const validatePair = (values) => {
    const base = String(values.release_api_base ?? '').trim()
    const identifier = String(values.release_identifier ?? '').trim()
    const failedField = base && !identifier ? 'release_identifier' : (!base && identifier ? 'release_api_base' : null)
    clearPairErrors()
    if (failedField) {
      formApiRef.current?.setError(failedField, PAIR_MESSAGE)
      return false
    }
    return true
  }

  const handleSubmit = async (values) => {
    if (!validatePair(values)) return
    const payload = {}
    SAVE_KEYS.forEach((key) => {
      payload[key] = String(values[key] ?? '').trim()
    })
    setSaving(true)
    try {
      const res = await updateDesktopUpdateSettings(payload)
      setData(res || {})
      setFormKey((key) => key + 1)
      Toast.success('已保存，客户端下次检查更新时立即生效')
    } catch (e) {
      Toast.error(e?.error || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card bordered className="settings-card">
      <Spin spinning={loading}>
        {data && (
          <Form
            key={formKey}
            initValues={data}
            onSubmit={handleSubmit}
            getFormApi={(api) => { formApiRef.current = api }}
            onValueChange={(values, changedValue) => {
              if (changedValue && PAIR_FIELDS.some((field) => changedValue[field] !== undefined)) clearPairErrors()
            }}
            disabled={!canEdit}
            labelPosition="top"
          >
            <div className="settings-fields">
              {DESKTOP_FIELDS.map(({ field, label, placeholder, hint }) => (
                <Form.Input
                  key={field}
                  field={field}
                  label={label}
                  placeholder={placeholder}
                  extraText={hint}
                  showClear
                />
              ))}
            </div>
            <div className="settings-footer">
              {canEdit ? (
                <Button theme="solid" type="primary" htmlType="submit" icon={<IconSave />} loading={saving}>
                  保存
                </Button>
              ) : (
                <Text type="tertiary">仅查看模式：你没有编辑权限（system_settings_edit），如需修改请联系管理员。</Text>
              )}
            </div>
          </Form>
        )}
      </Spin>
    </Card>
  )
}

function SiteDownloadCard({ canEdit }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState(null)
  const [formKey, setFormKey] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getSiteDownloadSettings()
      setData(res || {})
      setFormKey((k) => k + 1)
    } catch (e) {
      Toast.error(e?.error || '加载产品站下载配置失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleSubmit = async (values) => {
    const payload = {}
    SITE_DOWNLOAD_FIELDS.forEach(({ field }) => {
      payload[field] = String(values[field] ?? '').trim()
    })
    setSaving(true)
    try {
      const res = await updateSiteDownloadSettings(payload)
      setData(res || {})
      setFormKey((k) => k + 1)
      Toast.success('已保存，产品站 /site/ 下载地址立即生效')
    } catch (e) {
      Toast.error(e?.error || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card bordered className="settings-card">
      <Spin spinning={loading}>
        {data && (
          <Form
            key={formKey}
            initValues={data}
            onSubmit={handleSubmit}
            disabled={!canEdit}
            labelPosition="top"
          >
            <div className="settings-fields">
              {SITE_DOWNLOAD_FIELDS.map(({ field, label, placeholder, hint }) => (
                <Form.Input
                  key={field}
                  field={field}
                  label={label}
                  placeholder={placeholder}
                  extraText={hint}
                  showClear
                />
              ))}
            </div>
            <div className="settings-footer">
              {canEdit ? (
                <Button theme="solid" type="primary" htmlType="submit" icon={<IconSave />} loading={saving}>
                  保存
                </Button>
              ) : (
                <Text type="tertiary">仅查看模式：你没有编辑权限（system_settings_edit），如需修改请联系管理员。</Text>
              )}
            </div>
          </Form>
        )}
      </Spin>
    </Card>
  )
}

export default function Settings() {
  const { hasPermission } = useAuth()
  const canEdit = hasPermission('system_settings_edit')

  return (
    <div className="settings-page">
      <div className="settings-page__header">
        <Title heading={5} className="settings-page__title">系统设置</Title>
      </div>

      <div className="settings-page__hint">
        <IconInfoCircle size="small" className="settings-page__hint-icon" />
        <Text type="tertiary" size="small">
          后台保存的配置优先于环境变量（留空视为未配置），保存后立即生效。
        </Text>
      </div>

      <Tabs type="line" defaultActiveKey="desktop" className="settings-tabs">
        <TabPane tab="桌面端更新" itemKey="desktop">
          <DesktopUpdateCard canEdit={canEdit} />
        </TabPane>
        <TabPane tab="产品站下载" itemKey="site">
          <SiteDownloadCard canEdit={canEdit} />
        </TabPane>
      </Tabs>
    </div>
  )
}
