import { useId, useState } from 'react'
import { useWatch } from 'react-hook-form'
import { ChevronsUpDown, Star, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from 'react-i18next'

export default function AccountModels({ form, discovered, discovering, discover, canDiscover }) {
  const { t } = useTranslation()
  const id = useId()
  const [open, setOpen] = useState(false), [query, setQuery] = useState('')
  const [manualOpen, setManualOpen] = useState(false), [manualText, setManualText] = useState('')
  const [manualError, setManualError] = useState(''), [manualOptions, setManualOptions] = useState([])
  const raw = useWatch({ control: form.control, name: 'supported_models' }) || ''
  const defaultModel = useWatch({ control: form.control, name: 'default_model' }) || ''
  const selected = [...new Set([...raw.split(/[,，\n]/).map(x => x.trim()).filter(Boolean), ...(defaultModel ? [defaultModel] : [])])]
  // Preserve saved options for this dialog, even after they are unchecked.
  const [savedOptions] = useState(() => selected)
  const options = [...new Set([...savedOptions, ...manualOptions, ...(discovered || [])])]
  const search = query.trim()
  const filtered = options.filter(model => model.toLowerCase().includes(search.toLowerCase()))
  const disabled = form.formState.isSubmitting
  const update = models => form.setValue('supported_models', models.join('\n'), { shouldDirty: true, shouldValidate: true })
  const setDefault = model => form.setValue('default_model', model, { shouldDirty: true, shouldValidate: true })
  const toggle = model => {
    if (selected.includes(model)) {
      update(selected.filter(item => item !== model))
      if (defaultModel === model) setDefault('')
    } else if (selected.length < 50) update([...selected, model])
  }
  const addManual = () => {
    const models = [...new Set(manualText.split(/[,，\n]/).map(value => value.trim()).filter(Boolean))]
    if (!models.length) return setManualError('请输入模型 ID')
    if (models.some(model => model.length > 128)) return setManualError('模型 ID 不能超过 128 个字符')
    const next = [...new Set([...selected, ...models])]
    if (next.length > 50) return setManualError('最多选择 50 个模型，请减少后再添加')
    setManualOptions(previous => [...new Set([...previous, ...models])])
    update(next)
    setManualText('')
    setManualError('')
    setManualOpen(false)
  }
  return <section className="space-y-3 border-t pt-4">
    <div className="flex items-center justify-between gap-3">
      <label id={id} className="text-sm font-medium">{t('模型配置')}</label>
      <div className="flex items-center gap-2">
      <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-expanded={manualOpen} aria-controls={`${id}-manual`} onClick={() => setManualOpen(value => !value)}>{t('手动添加模型')}</Button>
      {canDiscover && <Button type="button" variant="outline" size="sm" disabled={discovering || disabled} onClick={discover}>
        {t(discovering ? '获取中…' : '获取模型')}
      </Button>}
      </div>
    </div>
    {manualOpen && <div id={`${id}-manual`} className="space-y-2 rounded-md border p-3">
      <label htmlFor={`${id}-model-ids`} className="text-sm font-medium">{t('模型 ID')}</label>
      <Textarea id={`${id}-model-ids`} value={manualText} disabled={disabled} rows={3} placeholder={t('输入上游提供的模型 ID，每行一个或用逗号分隔')} aria-invalid={!!manualError} aria-describedby={`${id}-manual-help${manualError ? ` ${id}-manual-error` : ''}`} onChange={event => { setManualText(event.target.value); setManualError('') }} />
      <p id={`${id}-manual-help`} className="text-xs text-muted-foreground">{t('无需先获取模型。添加后自动选中，重复 ID 会合并；可在下拉列表中设置默认模型。')}</p>
      {manualError && <p id={`${id}-manual-error`} role="alert" className="text-sm text-destructive">{t(manualError)}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => { setManualOpen(false); setManualError('') }}>{t('取消')}</Button>
        <Button type="button" size="sm" disabled={disabled || !manualText.trim()} onClick={addManual}>{t('添加并选中')}</Button>
      </div>
    </div>}
    <Popover modal open={open} onOpenChange={value => { setOpen(value); if (!value) setQuery('') }}>
      <PopoverAnchor asChild>
        <div className="rounded-md border bg-background">
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" disabled={disabled} aria-labelledby={id} className="h-10 w-full justify-between gap-2 text-left font-normal">
              <span>{t('选择模型（可多选）')} · {t('已选')} {selected.length}/50</span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <div role="group" aria-label={t('已选模型')} className="h-20 overflow-y-auto overscroll-contain border-t p-2">
            <div className="flex flex-wrap gap-1.5">
              {selected.map(model => <span key={model} className="inline-flex max-w-full items-center gap-1 rounded-md bg-secondary py-1 pl-2 pr-1 text-xs">
                {defaultModel === model && <Star className="size-3 shrink-0 fill-primary text-primary" aria-label={t('默认模型')} />}
                <span className="min-w-0 break-all">{model}</span>
                <button type="button" disabled={disabled} aria-label={t('移除模型 {{model}}', { model })} onClick={() => toggle(model)} className="inline-flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
                  <X className="size-3" />
                </button>
              </span>)}
              {!selected.length && <span className="text-xs text-muted-foreground">{t('尚未选择模型')}</span>}
            </div>
          </div>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-2rem)] max-h-(--radix-popover-content-available-height) flex flex-col overflow-hidden p-2">
        <Input aria-label={t('搜索模型')} placeholder={t('搜索模型')} value={query} onChange={event => setQuery(event.target.value)} />
        <div className="my-2 min-h-0 max-h-64 overflow-y-auto overscroll-contain touch-pan-y" tabIndex={0} role="group" aria-label={t('可选模型')}>
          {filtered.map(model => <div key={model} className="flex items-center gap-2 rounded-md px-2 hover:bg-accent">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 text-sm">
              <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={selected.includes(model)} disabled={disabled || (!selected.includes(model) && selected.length >= 50)} onChange={() => toggle(model)} />
              <span className="break-all">{model}</span>
            </label>
            <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`${t(defaultModel === model ? '取消默认模型' : '设为默认模型')} ${model}`} aria-pressed={defaultModel === model} disabled={disabled || (!selected.includes(model) && selected.length >= 50)} onClick={() => {
              if (!selected.includes(model)) update([...selected, model])
              setDefault(defaultModel === model ? '' : model)
            }}><Star className={defaultModel === model ? 'fill-primary text-primary' : 'text-muted-foreground'} /></Button>
          </div>)}
          {!filtered.length && <p className="p-3 text-sm text-muted-foreground">{t(options.length ? '没有匹配的模型' : '暂无模型，请获取模型或手动添加')}</p>}
        </div>
        <div className="mt-2 flex shrink-0 items-center justify-between border-t pt-2 text-xs text-muted-foreground">
          <span>{t('已选')} {selected.length}/50 · {t('点击星标设为默认')}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>{t('完成')}</Button>
        </div>
      </PopoverContent>
    </Popover>
    <p className="text-xs text-muted-foreground" role="status">{discovered != null ? `${t('已获取')} ${discovered.length} ${t('个模型')} · ` : ''}{t('勾选支持的模型，星标选择默认模型。')}</p>
  </section>
}
