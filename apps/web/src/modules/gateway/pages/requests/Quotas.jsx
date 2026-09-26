import { useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/context/AuthContext'
import PageHeader from '@/shared/components/PageHeader'
import DataTable from '@/shared/components/DataTable'
import { FormDialog } from '@/shared/components/FormDialog'
import { FormNumber, FormSelect } from '@/shared/components/FormFields'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listQuotas, updateQuota } from '@/modules/gateway/api/gateway'
import { toast } from '@/lib/toast'

export default function Quotas() {
  const { t } = useTranslation()
  const { hasPermission } = useAuth()
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState({ page: 1, search: '' })
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState({ items: [], total: 0, default_daily_quota: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)
  const busy = useRef(false)
  const form = useForm({ defaultValues: { mode: 'default', limit: 1000 }, shouldUnregister: true })
  const mode = useWatch({ control: form.control, name: 'mode' })
  const beginLoad = () => { setLoading(true); setError('') }
  const reload = () => { beginLoad(); setRefresh(v => v + 1) }
  const changeQuery = next => { beginLoad(); setQuery(next) }
  useEffect(() => {
    let current = true
    listQuotas({ ...query, per_page: 20 })
      .then(result => { if (current) setData(result) })
      .catch(e => { if (current) { setData({ items: [], total: 0 }); setError(e.message || t('加载失败')) } })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [query, refresh, t])
  const edit = row => {
    form.reset({ mode: row.daily_token_quota === null ? 'default' : row.daily_token_quota === 0 ? 'unlimited' : 'limit', limit: row.daily_token_quota || 1000 })
    setEditing(row)
  }
  const save = async values => {
    if (busy.current) return
    busy.current = true
    try {
      await updateQuota(editing.user_id, { daily_token_quota: values.mode === 'default' ? null : values.mode === 'unlimited' ? 0 : values.limit })
      setEditing(null)
      toast.success('用户额度已保存')
      reload()
    } catch (e) { toast.apiError(e, '保存用户额度失败'); throw e }
    finally { busy.current = false }
  }
  const amount = value => value == null ? t('不限额') : value.toLocaleString()
  const columns = [
    { key: 'username', title: '用户名', dataIndex: 'username' },
    { key: 'source', title: '额度来源', render: (_, row) => t(row.quota_source === 'default' ? '继承默认额度' : '用户设置') },
    { key: 'quota', title: '生效日额度', dataIndex: 'effective_quota', align: 'right', render: amount },
    { key: 'used', title: '今日已用', dataIndex: 'used_today', align: 'right', render: value => value.toLocaleString() },
    { key: 'remaining', title: '剩余额度', dataIndex: 'remaining', align: 'right', render: amount },
    { key: 'state', title: '状态', render: (_, row) => t(row.exhausted ? '额度已耗尽' : '可用') },
    ...(hasPermission('gateway_requests_quota_edit') ? [{ key: 'edit', title: '操作', render: (_, row) => <Button size="sm" variant="ghost" onClick={() => edit(row)}>{t('编辑配额')}</Button> }] : []),
  ]
  return <>
    <PageHeader title="用户配额" actions={<Button variant="outline" onClick={reload}>{t('刷新')}</Button>} />
    <p className="mb-4 text-sm text-muted-foreground">{t('所有访问密钥共享用户日额度；剩余额度不包含进行中的预扣。')}</p>
    {!loading && !error && <p className="mb-4 text-sm">{t('默认日额度')}：<span className="tabular-nums">{amount(data.default_daily_quota)}</span></p>}
    <form className="mb-4 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); changeQuery({ page: 1, search: search.trim() }) }}>
      <label className="flex flex-col gap-2 text-sm">{t('搜索用户')}<Input value={search} onChange={e => setSearch(e.target.value)} maxLength={200} /></label>
      <Button type="submit">{t('查询')}</Button>
      <Button type="button" variant="outline" onClick={() => { setSearch(''); changeQuery({ page: 1, search: '' }) }}>{t('重置')}</Button>
    </form>
    {error ? <p role="alert" className="text-danger">{error}</p> : <DataTable columns={columns} data={data.items} rowKey="user_id" loading={loading} pagination={{ page: query.page, perPage: 20, total: data.total, onChange: page => changeQuery({ ...query, page }) }} />}
    <FormDialog open={Boolean(editing)} onOpenChange={open => { if (!open && !busy.current) setEditing(null) }} title="编辑配额" description={editing?.username} form={form} onSubmit={save} size="sm">
      <FormSelect control={form.control} name="mode" label="额度模式" options={[
        { value: 'default', label: t('继承默认额度') },
        { value: 'unlimited', label: t('不限额') },
        { value: 'limit', label: t('设置日额度') },
      ]} />
      {mode === 'limit' && <FormNumber control={form.control} name="limit" label="每日 Token 上限" min={1} max={1000000000} rules={{ required: true, min: 1, max: 1000000000, validate: value => Number.isInteger(value) || t('请输入整数') }} />}
      <p className="text-sm text-muted-foreground">{t('仅修改用户日额度，密钥自身限制和用户并发、请求频率限制仍然生效。')}</p>
    </FormDialog>
  </>
}
