import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PageHeader from '@/shared/components/PageHeader'
import { Button } from '@/components/ui/button'
import { listGateway } from '@/modules/gateway/api/gateway'
export default function Overview() {
  const { t } = useTranslation()

  const [data, setData] = useState(null),
    [error, setError] = useState('')
  const load = useCallback(
    () =>
      listGateway('overview')
        .then((r) => {
          setData(r)
          setError('')
        })
        .catch((e) => setError(e.message)),
    [],
  )
  useEffect(() => {
    void load()
  }, [load])
  return (
    <>
      <PageHeader
        title="网关总览"
        description="今日 · UTC"
        actions={
          <Button variant="outline" onClick={load}>
            {t('刷新')}
          </Button>
        }
      />
      {error && (
        <p role="alert" className="text-danger mb-4">
          {error}
        </p>
      )}
      <div className="bg-card mb-6 grid grid-cols-2 gap-6 rounded-xl border p-6 lg:grid-cols-4">
        {[
          ['requests', '请求数'],
          ['active', '进行中'],
          ['failed', '异常请求'],
          ['tokens', 'Token 用量'],
        ].map(([key, label]) => (
          <div key={key}>
            <p className="text-muted-foreground text-sm">{label}</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">
              {data ? Number(data[key]).toLocaleString() : '—'}
            </p>
          </div>
        ))}
      </div>
      <section className="bg-card rounded-xl border p-6">
        <h2 className="text-lg font-semibold">{t('接入你的第一个模型')}</h2>
        <div className="mt-5 divide-y">
          {[
            [
              '1',
              '添加模型服务',
              '配置上游协议、API 地址与密钥。',
              '/gateway/upstreams',
            ],
            [
              '2',
              '配置对外模型',
              '为客户端提供稳定的模型名称，选择实际调用的上游。',
              '/gateway/routes',
            ],
            [
              '3',
              '创建访问密钥',
              '设置允许的模型、调用配额和有效期。',
              '/gateway/keys',
            ],
          ].map(([n, title, desc, url]) => (
            <div
              key={n}
              className="flex items-center justify-between gap-4 py-5"
            >
              <div>
                <h3 className="font-medium">
                  {n}. {title}
                </h3>
                <p className="text-muted-foreground mt-1 text-sm">{desc}</p>
              </div>
              <Button variant="outline" asChild>
                <Link to={url}>{t('前往配置')}</Link>
              </Button>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground mt-5 text-sm">
          {t('API 基础路径：')}
          <code>/v1</code>
          {t('。兼容原有')}
          <code>/api/agent/v1</code>
          {t('路径。用量可能包含明确标记的估算值。')}
        </p>
      </section>
    </>
  )
}
