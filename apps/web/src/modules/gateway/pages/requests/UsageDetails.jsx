import { useTranslation } from 'react-i18next'

const fields = [
  ['input_tokens', '输入 Token（含缓存）'],
  ['output_tokens', '输出 Token（含推理）'],
  ['cache_read_tokens', '缓存读取 Token'],
  ['cache_write_tokens', '缓存写入 Token'],
  ['cache_miss_tokens', '缓存未命中 Token'],
  ['cache_write_5m_tokens', '5 分钟缓存写入 Token'],
  ['cache_write_1h_tokens', '1 小时缓存写入 Token'],
  ['reasoning_tokens', '推理 Token'],
]
export default function UsageDetails({ request }) {
  const { t, i18n } = useTranslation()
  const hasRaw = request.raw_usage && Object.keys(request.raw_usage).length > 0
  return (
    <section className="mt-6" aria-label={t('Token 用量明细')}>
      <h3 className="mb-3 font-medium">{t('Token 用量明细')}</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        {t('缓存属于输入，推理属于输出；子项不重复计入总量。')}
      </p>
      <dl className="divide-y text-sm">
        {fields.map(([key, label]) => (
          <div key={key} className="flex items-baseline justify-between gap-4 py-2">
            <dt className="text-muted-foreground">{t(label)}</dt>
            <dd className="shrink-0 tabular-nums">
              {request[key] == null ? t('未报告') : Number(request[key]).toLocaleString(i18n.language)}
              {key === 'cache_miss_tokens' && request.cache_miss_tokens != null && request.cache_miss_source === 'derived' && <span className="ml-1 text-muted-foreground">{t('（推导）')}</span>}
              {['input_tokens', 'output_tokens'].includes(key) && request.usage_source === 'estimated' && <span className="ml-1 text-muted-foreground">{t('（估算）')}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer rounded py-2 font-medium focus-visible:outline focus-visible:outline-2">{t('上游原始用量')}</summary>
        {hasRaw ? <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify(request.raw_usage, null, 2)}</pre> : <p className="py-2 text-muted-foreground">{t('未报告')}</p>}
      </details>
    </section>
  )
}
