import type { TavilySearchProvider, SearchSource } from './search-provider'
import { delegatedFetch, delegatedSearch } from './delegated-search'
import { webpage, permitted } from './search-provider'
import { randomUUID } from 'node:crypto'
import { utcNowIso } from '@/common/serialize'
import type { GatewayService } from './service'
import { GatewayError } from './schema'
import { SearchSettingsService } from './search-settings'
import { reservationTtlSeconds } from './quota-policy'

/** Tool requests share the caller's model grant and owner/key admission barrier. */
export async function executeServerToolResult(
  gateway: GatewayService,
  key: Awaited<ReturnType<GatewayService['authenticate']>>,
  model: string,
  kind: 'web_search' | 'web_fetch',
  args: Record<string, unknown>,
  parent: string | undefined,
  signal: AbortSignal,
) {
  if (Buffer.byteLength(JSON.stringify(args)) > 4000)
    throw new GatewayError(400, '工具参数超过大小上限', 'invalid_request')
  if (kind === 'web_fetch') {
    const url = typeof args.url === 'string' ? webpage(args.url) : null
    if (
      !url ||
      !permitted(
        url,
        (args.allowed_domains ?? []) as string[],
        (args.blocked_domains ?? []) as string[],
      )
    )
      throw new GatewayError(400, '网页地址不在允许范围', 'url_not_allowed')
  }
  const id = randomUUID(),
    start = Date.now()
  const denied = await gateway.repo.reserve(key.id, {
    id,
    model,
    protocol: kind.replace('_', '-'),
    reserved_tokens: 20000,
    expires_at: utcNowIso(new Date(Date.now() + (gateway.options.reservationTtlSeconds ?? reservationTtlSeconds()) * 1000)) + 'Z',
  })
  if (denied)
    throw new GatewayError(
      denied === 'unauthorized'
        ? 401
        : ['insufficient_scope', 'model_not_allowed'].includes(denied)
          ? 403
          : 429,
      denied,
      denied,
    )
  const settle = async (values: Parameters<typeof gateway.repo.finish>[1]) => {
    try {
      const rows = await gateway.repo.finish(id, values)
      if (rows.length !== 1) throw new Error('Tool settlement did not update reservation')
    } catch {
      const error = new GatewayError(500, '用量结算失败，请使用请求 ID 联系管理员', 'settlement_failed')
      error.requestId = id
      throw error
    }
  }
  let attempted = false
  let result: Awaited<ReturnType<TavilySearchProvider['fetch']>> | SearchSource[]
  try {
    if (signal.aborted) throw new GatewayError(499, '请求已取消', 'cancelled')
    const provider = await new SearchSettingsService(gateway).provider()
    if (!provider)
      throw new GatewayError(503, '未配置可用的搜索服务', 'search_unconfigured')
    attempted = true
    result =
      kind === 'web_search'
        ? await provider.search({ ...args, query: typeof args.query === 'string' ?
          args.query + (args.user_location && typeof args.user_location === 'object' ?
            ' (' + ['city','region','country'].map(field => (args.user_location as Record<string,string>)[field]).filter(Boolean).join(', ') + ')' : '') : args.query }, signal)
        : await provider.fetch({ ...args, max_characters: typeof args.max_content_tokens === 'number' ? Math.min(12000, args.max_content_tokens) : 12000 }, signal)
    if (kind === 'web_fetch' && 'text' in result)
      result = boundFetch(result, args.max_content_tokens)
    // Bound both model history and the local estimated tool debit.
    const json = JSON.stringify(result)
    if (Buffer.byteLength(json) > 55000)
      throw new GatewayError(
        502,
        '工具结果超过允许大小',
        'tool_result_too_large',
      )
  } catch (cause) {
    const error =
      cause instanceof GatewayError
        ? cause
        : new GatewayError(502, '服务端工具执行失败', 'tool_failed')
    await settle({
      status: error.status === 499 ? 'cancelled' : 'upstream_error',
      http_status: error.status,
      error: error.message,
      input_tokens: 0,
      output_tokens: 0,
      usage_source: 'estimated',
      duration_ms: Date.now() - start,
      raw_usage: {
        provider: attempted ? 'tavily' : null,
        tool: kind,
        parent_request_id: parent,
        calls: attempted ? 1 : 0,
      },
    })
    error.requestId = id
    if (!signal.aborted && ![401,403,429,499,504].includes(error.status) &&
        ['search_unconfigured','search_auth_failed','search_upstream_error','search_connection_failed','fetch_empty_result'].includes(error.code)) {
      try {
        let result: Omit<Awaited<ReturnType<typeof delegatedFetch>>, 'requestId'> | SearchSource[], resultId: string
        if (kind === 'web_search') {
          const delegated = await delegatedSearch(gateway,key,String(args.query),5,signal,{},id,model)
          result = delegated.json.sources
          resultId = delegated.id
        } else {
          const {requestId, ...fetched} = await delegatedFetch(gateway,key,String(args.url),typeof args.max_content_tokens==='number'?args.max_content_tokens:undefined,signal,id,model)
          result = fetched
          resultId = requestId
        }
        const allowed=(args.allowed_domains??[]) as string[], blocked=(args.blocked_domains??[]) as string[]
        if(Array.isArray(result)) return {id:resultId,result:result.filter(source=>{const url=webpage(source.url);return url && permitted(url,allowed,blocked)})}
        const url=webpage(result.url)
        if(!url || !permitted(url,allowed,blocked))throw new GatewayError(422,'抓取结果跳转到了不允许的域名','fetch_url_not_allowed')
        return {id:resultId,result:boundFetch(result,args.max_content_tokens)}
      } catch (fallback) {
        if(fallback instanceof GatewayError && fallback.code==='search_unconfigured')throw error
        throw fallback
      }
    }
    throw error
  }
    await settle({
      status: 'ok',
      http_status: 200,
      input_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(args)) / 3),
      output_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(result)) / 3),
      usage_source: 'estimated',
      duration_ms: Date.now() - start,
      raw_usage: {
        provider: 'tavily',
        tool: kind,
        parent_request_id: parent,
        calls: 1,
      },
    })
    return {id,result}

}

export async function executeServerTool(...args: Parameters<typeof executeServerToolResult>) {
  return (await executeServerToolResult(...args)).result
}

/** Both extraction providers obey the same conservative UTF-8 budget, without splitting a code point. */
function boundFetch<T extends {text:string;truncated:boolean}>(result:T, maxTokens:unknown):T {
  const maxBytes = typeof maxTokens === 'number' ? Math.min(12000,maxTokens) : Infinity
  let bytes=0, text=''
  for (const char of result.text) {
    bytes += Buffer.byteLength(char)
    if (bytes > maxBytes || text.length + char.length > 12000) break
    text += char
  }
  return {...result,text,truncated:result.truncated || text.length < result.text.length}
}
