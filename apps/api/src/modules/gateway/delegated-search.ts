import { orderCandidates, smoothCandidates } from './selection'
import { preferredHealthy } from './scheduling-policy'
import type { Candidate } from './pool-route'
import type { SearchCapability } from './capability-route'
import { nativeToolSupport, recordNativeToolSupport } from './native-tool-support'
import type { GatewayService } from './service'
import { GatewayError } from './schema'
import { webpage, type SearchSource } from './search-provider'
import { array, object } from './protocol/compat-helpers'

/** Only native tool results/citations count as sources; never parse invented URLs from prose. */
export function searchSources(raw: unknown, limit: number): SearchSource[] {
  const body = object(raw),
    sources: SearchSource[] = [],
    seen = new Set<string>()
  const add = (raw: unknown) => {
    const item = object(raw)
    if (typeof item.url !== 'string') return
    const url = webpage(item.url)
    if (!url || seen.has(url.href) || sources.length >= limit) return
    seen.add(url.href)
    sources.push({
      url: url.href,
      title:
        typeof item.title === 'string' ? item.title.slice(0, 1000) : url.href,
    })
  }
  for (const item of array(body.output).map(object)) {
    if (item.type === 'web_search_call' && item.status === 'completed')
      array(object(item.action).sources).forEach(add)
    if (item.type === 'message')
      for (const part of array(item.content).map(object))
        for (const annotation of array(part.annotations).map(object))
          if (annotation.type === 'url_citation') add(annotation)
  }
  for (const block of array(body.content).map(object)) {
    if (block.type === 'web_search_tool_result')
      for (const source of array(block.content).map(object))
        if (source.type === 'web_search_result') add(source)
    if (block.type === 'text')
      for (const citation of array(block.citations).map(object))
        if (citation.type === 'web_search_result_location') add(citation)
  }
  return sources
}
async function capabilityCandidates(gateway: GatewayService, owner: number, capability: SearchCapability) {
  let candidates = await gateway.repo.candidates(capability, false, false, owner)
  if (!candidates.length) candidates = await gateway.repo.capabilityCandidates(capability)
  candidates = candidates.filter(candidate =>
    (candidate.upstream.protocol === 'anthropic' || (capability === 'web-search' && candidate.upstream.protocol === 'responses')) &&
    nativeToolSupport(gateway.repo.db, candidate.upstream, capability) !== false)
  candidates = preferredHealthy(orderCandidates(candidates), gateway.repo.schedulingPolicy)
  const load = await gateway.repo.poolLoad(capability, candidates.map(candidate => candidate.upstream.id))
  candidates = smoothCandidates(candidates, {...load,bindings:{},last:null})
  candidates.sort((a,b) => Number(nativeToolSupport(gateway.repo.db,b.upstream,capability) === true) - Number(nativeToolSupport(gateway.repo.db,a.upstream,capability) === true))
  return candidates.slice(0, gateway.options.maxAttempts ?? 3)
}
async function observe(gateway: GatewayService, candidate: Candidate, requestId: string, executes: boolean, capability: SearchCapability) {
  const selected = await gateway.repo.selectedUpstream(requestId).catch(error => {gateway.report(error);return undefined})
  if (selected?.id === candidate.upstream.id) recordNativeToolSupport(gateway.repo.db,candidate.upstream,executes,capability)
}
function stopFallback(error: unknown, signal: AbortSignal) {
  if (signal.aborted || !(error instanceof GatewayError) ||
      [499,504].includes(error.status) || error.code === 'settlement_failed') return true
  // Supplier authentication/rate failures may switch accounts; caller admission failures may not.
  if (error.code === 'upstream_error') return false
  return [401,403,429].includes(error.status)
}
export async function delegatedSearch(
  gateway: GatewayService,
  key: Awaited<ReturnType<GatewayService['authenticate']>>,
  query: string,
  limit: number,
  signal: AbortSignal,
  headers: Record<string, unknown>,
  parentRequestId: string,
  authorizationModel?: string,
) {
  const candidates = await capabilityCandidates(gateway,key.owner_id,'web-search')
  let last: unknown = new GatewayError(503,'没有可用的原生搜索模型路由','search_unconfigured')
  for (const candidate of candidates) {
    const protocol = candidate.upstream.protocol as 'anthropic' | 'responses'
    const common = {model:'web-search',stream:false}
    const body = protocol === 'responses' ? {
      ...common,input:query,max_output_tokens:4096,store:false,tools:[{type:'web_search'}],
      include:['web_search_call.action.sources'],tool_choice:'required',
    } : {
      ...common,messages:[{role:'user',content:query}],max_tokens:4096,
      tools:[{type:'web_search_20250305',name:'web_search',max_uses:1}],
      tool_choice:{type:'tool',name:'web_search'},
    }
    try {
      const response = await gateway.execute(key,body,protocol,signal,headers,{
        authorizationModel,capability:'web-search',upstreamProtocol:protocol,upstreamIds:[candidate.upstream.id],parentRequestId,
      })
      const sources = searchSources(response.json,limit)
      await observe(gateway,candidate,response.id,sources.length > 0,'web-search')
      if (!sources.length) {
        const error = new GatewayError(502,'模型未返回可验证的搜索来源','search_not_executed')
        error.requestId = response.id
        throw error
      }
      return {id:response.id,json:{query,sources,truncated:false}}
    } catch (error) {
      if (stopFallback(error,signal)) throw error
      last = error
    }
  }
  throw last
}

/** Fetch evidence must come from a completed native result, never the model's prose. */
export async function delegatedFetch(
  gateway: GatewayService,
  key: Awaited<ReturnType<GatewayService['authenticate']>>,
  url: string,
  maxContentTokens: number | undefined,
  signal: AbortSignal,
  parentRequestId: string,
  authorizationModel?: string,
) {
  const candidates = await capabilityCandidates(gateway,key.owner_id,'web-fetch')
  let last: unknown = new GatewayError(503,'没有可用的原生抓取模型路由','search_unconfigured')
  for (const candidate of candidates) {
    try {
      const response = await gateway.execute(key,{
        model:'web-fetch',stream:false,max_tokens:4096,messages:[{role:'user',content:url}],
        tools:[{type:'web_fetch_20250910',name:'web_fetch',max_uses:1,
          ...(maxContentTokens === undefined ? {} : {max_content_tokens:maxContentTokens})}],
        tool_choice:{type:'tool',name:'web_fetch'},
      },'anthropic',signal,{}, {authorizationModel,capability:'web-fetch',upstreamProtocol:'anthropic',upstreamIds:[candidate.upstream.id],parentRequestId})
      for (const block of array(object(response.json).content).map(object)) {
        if (block.type !== 'web_fetch_tool_result') continue
        const result=object(block.content), document=object(result.content), source=object(document.source)
        const target=typeof result.url === 'string' ? webpage(result.url) : null
        if (result.type === 'web_fetch_result' && target && source.type === 'text' && typeof source.data === 'string') {
          await observe(gateway,candidate,response.id,true,'web-fetch')
          return {requestId:response.id,url:target.href,title:typeof document.title === 'string' ? document.title : null,
            text:source.data,retrieved_at:result.retrieved_at ?? null,truncated:false}
        }
      }
      await observe(gateway,candidate,response.id,false,'web-fetch')
      const error=new GatewayError(502,'模型未返回可验证的抓取正文','fetch_not_executed')
      error.requestId=response.id
      throw error
    } catch(error) {
      if (stopFallback(error,signal)) throw error
      last=error
    }
  }
  throw last
}
