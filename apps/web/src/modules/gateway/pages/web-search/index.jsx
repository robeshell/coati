import { useCallback, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTx } from '@/i18n'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Form } from '@/components/ui/form'
import {
  FormInput,
  FormNumber,
  FormSelect,
  FormSwitch,
} from '@/shared/components/FormFields'
import PageHeader from '@/shared/components/PageHeader'
import ConfirmAction from '@/shared/components/ConfirmAction'
import request from '@/shared/api/request'
import { toast, errorMessage } from '@/lib/toast'
const base = '/admin/gateway/web-search'
const values = (data) => ({
  provider: data.provider || 'disabled',
  api_key: '',
  proxy_url: '',
  timeout_seconds: data.timeout_seconds,
  clear_api_key: false,
  clear_proxy: false,
})
export default function WebSearch() {
  const tx = useTx(),
    { hasPermission } = useAuth(),
    canEdit = hasPermission('gateway_websearch_edit')
  const [data, setData] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState(null)
  const form = useForm({ defaultValues: values({ timeout_seconds: 15 }) }),
    generation = useRef(0),
    pending = useRef(false),
    checkAbort = useRef(null)
  const { reset } = form
  const load = useCallback(async () => {
    const id = ++generation.current
    try {
      const current = await request.get(base)
      if (id === generation.current) {
        setData(current)
        reset(values(current))
        setError('')
      }
    } catch (err) {
      if (id === generation.current) setError(errorMessage(err))
    }
  }, [reset])
  useEffect(() => {
    const ref = generation
    const timer = setTimeout(() => void load(), 0)
    return () => {
      clearTimeout(timer)
      ref.current++
      checkAbort.current?.abort()
    }
  }, [load])
  const save = async (input) => {
    if (!canEdit || pending.current) return
    pending.current = true
    generation.current++
    setBusy(true)
    setResult(null)
    try {
      const current = await request.put(base, {
        ...input,
        provider: input.provider === 'disabled' ? '' : input.provider,
      })
      setData(current)
      reset(values(current))
      toast.success('已保存')
    } catch (err) {
      toast.apiError(err)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const restore = async () => {
    if (!canEdit || pending.current) return
    pending.current = true
    generation.current++
    setBusy(true)
    setResult(null)
    try {
      const current = await request.delete(base)
      setData(current)
      reset(values(current))
      toast.success('已恢复环境配置')
    } catch (err) {
      toast.apiError(err)
      throw err
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const check = async () => {
    if (!canEdit || !data?.configured || pending.current) return
    pending.current = true
    setBusy(true)
    setResult(null)
    const abort = new AbortController()
    checkAbort.current = abort
    try {
      setResult(
        await request.post(
          base + '/test',
          {},
          { timeout: 70000, signal: abort.signal },
        ),
      )
    } catch (err) {
      if (!abort.signal.aborted) toast.apiError(err)
    } finally {
      checkAbort.current = null
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <PageHeader
        title="网页搜索"
        description="配置网关使用的独立搜索与网页抓取服务。保存配置不会发起搜索。"
      />
      {error && (
        <p role="alert" className="mb-4 text-destructive">
          {error}
          <Button variant="ghost" onClick={load}>
            {tx('重试')}
          </Button>
        </p>
      )}
      {!data && !error && <p role="status">{tx('加载中')}</p>}
      {data && (
        <div className="max-w-2xl space-y-5">
          <div className="rounded-xl border p-4 text-sm space-y-2">
            <p className="font-medium">
              {tx(
                data.configured
                  ? '搜索服务已配置'
                  : data.provider
                    ? '尚未配置 API Key'
                    : '独立搜索服务未启用',
              )}
            </p>
            <p className="text-muted-foreground">
              {tx('配置来源')}：
              {tx(data.source.provider === 'database' ? '控制台' : '环境变量')}
            </p>
            <p className="text-muted-foreground">
              {tx('API Key')}：{tx(data.has_api_key ? '已配置' : '未配置')} ·{' '}
              {tx(data.source.api_key === 'database' ? '控制台' : '环境变量')}
            </p>
            <p className="text-muted-foreground break-all">
              {tx('出站代理')}：
              {data.proxy_hint || tx('未配置账号级代理，遵循平台出站策略')}
            </p>
          </div>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(save)}
              className="rounded-xl border p-5 space-y-5"
            >
              <fieldset disabled={!canEdit || busy} className="space-y-5">
                <FormSelect
                  control={form.control}
                  name="provider"
                  label="搜索服务商"
                  options={[
                    { value: 'disabled', label: '不启用' },
                    { value: 'tavily', label: 'Tavily' },
                  ]}
                />
                <FormInput
                  control={form.control}
                  name="api_key"
                  label="API Key"
                  type="password"
                  autoComplete="new-password"
                  description="留空保留当前密钥；填写新值则替换，不回显已保存的密钥。"
                />
                <FormSwitch
                  control={form.control}
                  name="clear_api_key"
                  label="清除当前 API Key"
                  description="清除后不会回退使用环境变量中的密钥。"
                />
                <FormInput
                  control={form.control}
                  name="proxy_url"
                  label="出站代理"
                  type="password"
                  autoComplete="new-password"
                  description="可选 HTTP(S) 代理地址，留空保留当前值；凭证加密保存。"
                />
                <FormSwitch
                  control={form.control}
                  name="clear_proxy"
                  label="清除账号级代理"
                  description="清除后仍遵循部署者配置的平台出站策略。"
                />
                <FormNumber
                  control={form.control}
                  name="timeout_seconds"
                  label="超时（秒）"
                  min={3}
                  max={60}
                  rules={{ required: true, min: 3, max: 60 }}
                />
              </fieldset>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy}>
                    {tx(busy ? '处理中' : '保存配置')}
                  </Button>
                  <ConfirmAction
                    title="恢复环境配置？"
                    description="删除控制台覆盖值，重新使用服务端环境变量；当前未保存内容也会清除。"
                    onConfirm={restore}
                  >
                    <Button type="button" variant="outline" disabled={busy}>
                      {tx('恢复环境配置')}
                    </Button>
                  </ConfirmAction>
                </div>
              )}
            </form>
          </Form>
          {canEdit && (
            <div className="rounded-xl border p-5 space-y-3">
              <p className="font-medium">{tx('检查已保存配置')}</p>
              <p className="text-sm text-muted-foreground">
                {tx(
                  '将发起一次真实搜索，可能消耗搜索服务额度。未保存的表单内容不参与检查。',
                )}
              </p>
              <Button
                variant="outline"
                disabled={busy || !data.configured}
                onClick={check}
              >
                {tx('检查连接')}
              </Button>
              {result && (
                <div role="status" className="text-sm space-y-2">
                  <p>
                    {tx('连接成功')} · {result.result_count} {tx('条结果')}
                  </p>
                  {result.sample.map((url) => (
                    <p key={url} className="break-all text-muted-foreground">
                      {url}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}
