import { useCallback, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import PageHeader from '@/shared/components/PageHeader'
import DataTable from '@/shared/components/DataTable'
import { FormDialog } from '@/shared/components/FormDialog'
import {
  FormInput,
  FormNumber,
  FormSwitch,
  FormTextarea,
} from '@/shared/components/FormFields'
import { SearchInput, FilterSelect } from '@/shared/components/Filters'
import ConfirmAction from '@/shared/components/ConfirmAction'
import StatusBadge from '@/shared/components/StatusBadge'
import request from '@/shared/api/request'
import { toast } from '@/lib/toast'
import { useTx } from '@/i18n'
const base = '/admin/gateway/model-profiles'
const defaults = {
  model_name: '',
  context_window_override: null,
  max_output_tokens_override: null,
  note: '',
  enabled: true,
}
export default function ModelProfiles() {
  const tx = useTx()
  const { hasPermission } = useAuth(),
    can = (action) => hasPermission(`gateway_model_profiles_${action}`)
  const [data, setData] = useState({ items: [], total: 0 }),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(''),
    [enabled, setEnabled] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('')
  const [editing, setEditing] = useState(null),
    [open, setOpen] = useState(false),
    [importing, setImporting] = useState(false),
    [candidates, setCandidates] = useState([])
  const candidateGeneration = useRef(0)
  const generation = useRef(0),
    form = useForm({ defaultValues: defaults }),
    importForm = useForm({ defaultValues: { source: '', items: '[]' } })
  const load = useCallback(async () => {
    const version = ++generation.current
    setLoading(true)
    try {
      const result = await request.get(base, {
        params: { page, per_page: 20, search, enabled },
      })
      if (version === generation.current) {
        const lastPage = Math.max(1, Math.ceil(result.total / 20))
        if (page > lastPage) setPage(lastPage)
        setData(result)
        setError('')
      }
    } catch (err) {
      if (version === generation.current) setError(err.message || '加载失败')
    } finally {
      if (version === generation.current) setLoading(false)
    }
  }, [page, search, enabled])
  useEffect(() => {
    const ref = generation
    const timer = setTimeout(() => void load(), 150)
    return () => {
      clearTimeout(timer)
      ref.current++
    }
  }, [load])
  const edit = async (row) => {
    const version = ++candidateGeneration.current
    setEditing(row)
    form.reset(
      row
        ? Object.fromEntries(
            Object.keys(defaults).map((key) => [key, row[key]]),
          )
        : defaults,
    )
    setCandidates([])
    setOpen(true)
    try {
      const result = await request.get(base + '/candidates')
      if (version === candidateGeneration.current) setCandidates(result.items)
    } catch {
      /* Manual model names remain available. */
    }
  }
  const save = async (values) => {
    try {
      if (editing) await request.put(`${base}/${editing.id}`, values)
      else await request.post(base, values)
      setOpen(false)
      toast.success('已保存')
      await load()
    } catch (err) {
      toast.apiError(err, '保存失败')
      throw err
    }
  }
  const sync = async (values) => {
    try {
      const items = JSON.parse(values.items)
      if (!Array.isArray(items)) throw new Error('目录内容必须是 JSON 数组')
      await request.post(base + '/sync', { source: values.source, items })
      setImporting(false)
      toast.success('能力目录已导入，手动覆盖值保持不变')
      await load()
    } catch (err) {
      toast.apiError(err, '导入失败')
      throw err
    }
  }
  const remove = async (row) => {
    try {
      await request.delete(`${base}/${row.id}`)
      toast.success('已删除')
      await load()
    } catch (err) {
      toast.apiError(err, '删除失败')
      throw err
    }
  }
  const columns = [
    { key: 'model_name', title: '模型名称', dataIndex: 'model_name' },
    {
      key: 'context_window',
      title: '上下文窗口',
      render: (_, row) => row.context_window.toLocaleString(),
      align: 'right',
    },
    {
      key: 'max_output_tokens',
      title: '最大输出 Token',
      render: (_, row) => row.max_output_tokens.toLocaleString(),
      align: 'right',
    },
    {
      key: 'source',
      title: '数值来源',
      render: (_, row) => (
        <div>
          <p>
            {tx(
              {
                admin: '手动配置',
                mixed: '手动与目录/默认值',
                catalog: '导入目录',
                fallback: '默认值',
              }[row.source],
            )}
          </p>
          {row.catalog_source && (
            <p className="text-xs text-muted-foreground break-all">
              {row.catalog_source}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'enabled',
      title: '状态',
      render: (_, row) => (
        <StatusBadge tone={row.enabled ? 'success' : 'neutral'}>
          {row.enabled ? '已启用' : '已停用'}
        </StatusBadge>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      render: (_, row) => (
        <div className="flex gap-1">
          {can('edit') && (
            <Button variant="ghost" size="sm" onClick={() => edit(row)}>
              {tx('编辑')}
            </Button>
          )}
          {can('delete') && (
            <ConfirmAction
              title="删除模型能力档案？"
              description="删除后使用目标模型档案或默认能力值。"
              onConfirm={() => remove(row)}
            >
              <Button size="sm" variant="ghost" disabled={row.enabled}>
                {tx('删除')}
              </Button>
            </ConfirmAction>
          )}
        </div>
      ),
    },
  ]
  return (
    <>
      <PageHeader
        title="模型能力"
        description="统一管理上下文窗口和输出上限。默认值不代表已验证的模型能力。"
        actions={
          <>
            <Button variant="outline" disabled={loading} onClick={load}>
              {tx('刷新')}
            </Button>
            {can('edit') && (
              <Button variant="outline" onClick={() => setImporting(true)}>
                {tx('导入能力目录')}
              </Button>
            )}
            {can('add') && (
              <Button variant="brand" onClick={() => edit(null)}>
                {tx('添加模型能力')}
              </Button>
            )}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
          placeholder="搜索模型名称或备注"
        />
        <FilterSelect ariaLabel="状态" placeholder="状态" value={enabled}
          onChange={value => {setEnabled(value);setPage(1)}}
          options={[{label:'已启用',value:'true'},{label:'已停用',value:'false'}]} />
      </div>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : (
        <DataTable
          columns={columns}
          data={data.items}
          loading={loading}
          minWidth={800}
          emptyDescription={search || enabled ? "暂无匹配结果，请调整筛选条件。" : "手动添加模型能力，或导入已核验的能力目录。"}
          pagination={{
            page,
            perPage: 20,
            total: data.total,
            onChange: setPage,
          }}
        />
      )}
      <FormDialog
        open={open}
        onOpenChange={(value) => {
          candidateGeneration.current++
          setOpen(value)
        }}
        title={editing ? '编辑模型能力' : '添加模型能力'}
        description="覆盖值留空时使用导入目录；无目录时采用 128000 / 8192 默认值。"
        form={form}
        onSubmit={save}
      >
        <FormInput
          control={form.control}
          name="model_name"
          label="模型名称"
          rules={{ required: '请输入模型名称', maxLength: 128 }}
        />
        {candidates.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm">
              {tx('从已配置模型中选择')}
            </summary>
            <div className="max-h-36 overflow-auto flex flex-wrap gap-1 pt-2">
              {candidates.map((name) => (
                <Button
                  key={name}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    form.setValue('model_name', name, { shouldDirty: true })
                  }
                >
                  {name}
                </Button>
              ))}
            </div>
          </details>
        )}
        <FormNumber
          control={form.control}
          name="context_window_override"
          label="上下文窗口覆盖值"
          min={1}
          max={1000000}
          description="留空恢复目录值或默认值。"
        />
        <FormNumber
          control={form.control}
          name="max_output_tokens_override"
          label="最大输出 Token 覆盖值"
          min={1}
          max={1000000}
        />
        <FormTextarea
          control={form.control}
          name="note"
          label="备注"
          rules={{ maxLength: 255 }}
        />
        <FormSwitch control={form.control} name="enabled" label="启用档案" />
      </FormDialog>
      <FormDialog
        open={importing}
        onOpenChange={setImporting}
        title="导入能力目录"
        description="只更新目录值，不覆盖人工配置和启停状态。不会访问外部网站。"
        form={importForm}
        onSubmit={sync}
      >
        <FormInput
          control={importForm.control}
          name="source"
          label="数据来源说明"
          rules={{ required: '请输入来源', maxLength: 255 }}
        />
        <FormTextarea
          control={importForm.control}
          name="items"
          label="能力数据（JSON 数组）"
          rows={10}
          description={
            '示例：[{"model_name":"example-model","context_window":128000,"max_output_tokens":8192}]'
          }
          rules={{ required: true }}
        />
      </FormDialog>
    </>
  )
}
