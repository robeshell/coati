import { nativeToolSupport, recordNativeToolSupport } from './native-tool-support'
import { bridgePolicy } from './bridge-policy'
import { normalizeServerToolHistory as normalizeHistory } from './token-estimate'
import { serverToolId } from './protocol/responses-anthropic'
import { z } from 'zod'
import { domainFilter } from './search-provider'
import { randomUUID } from 'node:crypto'
import type { GatewayService } from './service'
import { GatewayError, requestSchema, requiresResponseStorage, type Protocol } from './schema'
import { object, array, type Obj } from './protocol/compat-helpers'
import { bridgeRequest, bridgeResponse } from './protocol/bridge'
import { executeServerTool, executeServerToolResult } from './tool-execution'
import { searchOnlyQuery, searchResultBlocks } from './search-shortcut'
import { aggregateToolUsage, usageForProtocol } from './usage'
import { bridgeStream } from './protocol/stream-bridge'
import { UsageMeter, streamError } from './stream'

type Config = {
  name: 'web_search' | 'web_fetch'
  max: number
  allowed_domains: unknown
  blocked_domains: unknown
  user_location?: Record<string, string>
  max_content_tokens?: number
}
const domains = z.array(domainFilter).max(100)
const kind = (tool: Obj) =>
  String(tool.type).startsWith('web_search')
    ? 'web_search'
    : String(tool.type).startsWith('web_fetch')
      ? 'web_fetch'
      : null
export function serverToolConfigs(body: Obj): Config[] {
  const configs: Config[] = []
  for (const tool of array(body.tools).map(object)) {
    const name = kind(tool)
    if (!name) continue
    if (configs.some((config) => config.name === name))
      throw new GatewayError(400, '服务端工具声明重复', 'invalid_request')
    // Python int-or-none: malformed values use the default, negatives clamp to zero.
    const raw = tool.max_uses
    const numeric = typeof raw === 'string' && /^[+-]?\d+$/.test(raw.trim()) ? Number(raw)
      : typeof raw === 'number' || typeof raw === 'boolean' ? Number(raw) : NaN
    const max = Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 5
    configs.push({
      name,
      max,
      allowed_domains: domains.parse(tool.allowed_domains ?? object(tool.filters).allowed_domains ?? []),
      blocked_domains: domains.parse(tool.blocked_domains ?? []),
      ...(tool.user_location === undefined ? {} : {user_location: z.object({
        type:z.literal('approximate').optional(), city:z.string().max(100).optional(),
        region:z.string().max(100).optional(), country:z.string().max(100).optional(),
        timezone:z.string().max(100).optional(),
      }).strict().parse(tool.user_location)}),
      ...(tool.max_content_tokens === undefined ? {} : {max_content_tokens:z.number().int().min(1).max(100000).parse(tool.max_content_tokens)}),
    })
  }
  const names = new Set(configs.map(config => config.name as string))
  if (array(body.tools).map(object).some(tool => !kind(tool) && names.has(String(tool.name ?? object(tool.function).name))))
    throw new GatewayError(400, '服务端工具与函数工具名称冲突', 'invalid_request')
  return configs
}
/** Match legacy aliases, list-valued queries and JSON-encoded query lists. */
export function searchQueries(input: unknown): string[] {
  if (typeof input === 'string') {
    try { const parsed = JSON.parse(input); input = parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? parsed : {query:input} }
    catch { input = {query:input} }
  }
  const flatten = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(flatten)
    if (value == null) return []
    if (typeof value === 'string') {
      const text = value.trim()
      if (!text) return []
      try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed.map(item => String(item ?? '').trim()).filter(Boolean) } catch { /* Plain query. */ }
      return [text]
    }
    return [typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value)]
  }
  return [...new Set(['query','queries','q','search_query','search_queries'].flatMap(key => flatten(object(input)[key])))]
}
async function* frames(body: Obj) {
  const emit = (event: string, value: Obj) =>
    Buffer.from(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
  yield emit('message_start', {
    type: 'message_start',
    message: {
      ...body,
      content: [],
      stop_reason: null,
      usage: {
        ...object(body.usage),
        output_tokens: 0,
      },
    },
  })
  let index = 0
  for (const block of array(body.content).map(object)) {
    const simple = ['text', 'thinking', 'tool_use'].includes(String(block.type))
    const start = simple
      ? {
          ...block,
          ...(block.type === 'text'
            ? { text: '' }
            : block.type === 'thinking'
              ? { thinking: '', signature: undefined }
              : { input: {} }),
        }
      : block
    yield emit('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: start,
    })
    if (simple) {
      const delta =
        block.type === 'text'
          ? { type: 'text_delta', text: block.text }
          : block.type === 'thinking'
            ? { type: 'thinking_delta', thinking: block.thinking }
            : {
                type: 'input_json_delta',
                partial_json: JSON.stringify(block.input),
              }
      yield emit('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta,
      })
      if (block.type === 'thinking' && block.signature)
        yield emit('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: block.signature },
        })
    }
    yield emit('content_block_stop', { type: 'content_block_stop', index })
    index++
  }
  yield emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: body.stop_reason, stop_sequence: body.stop_sequence ?? null },
    usage: body.usage,
  })
  yield emit('message_stop', { type: 'message_stop' })
}
/** Messages server tools complete their loop before emitting SSE, as in Python. */
export async function executeWithServerTools(
  gateway: GatewayService,
  key: Awaited<ReturnType<GatewayService['authenticate']>>,
  raw: unknown,
  protocol: Protocol,
  signal: AbortSignal,
  headers: Record<string, unknown>,
) {
  const body = requestSchema.parse(protocol === 'anthropic' ? normalizeHistory(object(raw)) : raw)
  const bridgeOptions = bridgePolicy(headers)
  raw = body
  // Validate the original client contract before an intermediate conversion can drop fields.
  if (requiresResponseStorage(body, headers['x-coati-compatibility-policy']) || !key.scopes.includes('chat') ||
      (!key.models.includes('*') && !key.models.includes(body.model)))
    return gateway.execute(key, raw, protocol, signal, headers)
  const configs = serverToolConfigs(body)
  if (!configs.length)
    return gateway.execute(key, raw, protocol, signal, headers)
  if (typeof body.model !== 'string')
    throw new GatewayError(400, 'model 为必填字段')
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(gateway.options.timeoutMs),
  ])
  let nativeFailureParent: string | undefined
  const shortcutQuery = protocol === 'anthropic' && configs[0]?.max !== 0 ? searchOnlyQuery(body) : undefined
  if (shortcutQuery) {
    try {
      const config = configs[0]!
      const result = await executeServerToolResult(gateway, key, body.model, 'web_search', {
        query:shortcutQuery,limit:5,allowed_domains:config.allowed_domains,
        blocked_domains:config.blocked_domains,user_location:config.user_location,
      }, undefined, deadline)
      if (Array.isArray(result.result) && result.result.length) {
        const receipt = await gateway.repo.requestById(result.id)
        if (!receipt || receipt.status !== 'ok') {
          const error = new GatewayError(500, '搜索用量结算记录不可用', 'settlement_failed')
          error.requestId = result.id
          throw error
        }
        const usage = receipt.upstream_protocol && ['openai','anthropic','responses'].includes(receipt.upstream_protocol)
          ? usageForProtocol(object(receipt.raw_usage),receipt.upstream_protocol as Protocol,'anthropic')
          : {input_tokens:receipt.input_tokens,output_tokens:receipt.output_tokens}
        const payload = {
          id:'msg_' + randomUUID().replace(/-/g,''),type:'message',role:'assistant',model:body.model,
          content:searchResultBlocks('srvtoolu_' + randomUUID().replace(/-/g,'').slice(0,16),shortcutQuery,result.result),
          stop_reason:'end_turn',stop_sequence:null,
          // Return the settled counters, including native-provider cache usage when present.
          usage:{...usage,server_tool_use:{web_search_requests:1,web_fetch_requests:0}},
        }
        return body.stream ? {id:result.id,stream:frames(payload)} : {id:result.id,json:payload}
      }
      nativeFailureParent = result.id
    } catch (error) {
      if (deadline.aborted || !(error instanceof GatewayError) ||
          [401,403,429,499,504].includes(error.status) || error.code === 'settlement_failed') throw error
      nativeFailureParent = error.requestId
    }
  }
  const candidates = await gateway.repo.candidates(
    body.model,
    false,
    false,
    key.owner_id,
  )
  let initialResponse: {id:string;json:Obj} | undefined
  const nativeIds = candidates.filter(candidate => candidate.upstream.protocol === protocol &&
    configs.every(config => nativeToolSupport(gateway.repo.db, candidate.upstream, config.name === 'web_fetch' ? 'web-fetch' : 'web-search') === true)).map(candidate => candidate.upstream.id)
  // Responses cannot express a search call budget, block list, or native fetch.
  const nativeExpressible = protocol === 'anthropic' || (protocol === 'responses' &&
    array(body.tools).map(object).filter(tool => kind(tool)).every(tool => kind(tool) === 'web_search' &&
      tool.max_uses == null && !array(tool.blocked_domains).length))
  if(nativeExpressible && nativeIds.length) {
    try {
      const native = await gateway.execute(key,protocol === 'anthropic' ? { ...body, stream: false } : raw,protocol,deadline,headers,{upstreamProtocol:protocol,upstreamIds:nativeIds})
      if(native.stream) return native
      const nativeBlocks=array(protocol==='anthropic'?object(native.json).content:object(native.json).output)
      const pending = nativeBlocks.some(block=>['tool_use','function_call'].includes(String(object(block).type))&&configs.some(config=>config.name===object(block).name))
      const leaked = protocol === 'anthropic' && !nativeBlocks.some(block => object(block).type === 'server_tool_use') &&
        nativeBlocks.some(block => object(block).type === 'text' && ['<tool_call>', '<function=', '<｜tool▁call▁begin｜>'].some(marker => String(object(block).text ?? '').includes(marker)))
      if(!pending && !leaked)return protocol === 'anthropic' && body.stream ? { id: native.id, stream: frames(object(native.json)) } : native
      const selected = await gateway.repo.selectedUpstream(native.id).catch(error => { gateway.report(error); return undefined })
      const observed = candidates.find(candidate => candidate.upstream.id === selected?.id)?.upstream
      if (observed) for (const config of configs.filter(config => leaked || nativeBlocks.some(block => object(block).name === config.name))) recordNativeToolSupport(gateway.repo.db, observed, false, config.name === 'web_fetch' ? 'web-fetch' : 'web-search')
      if (leaked && !pending) {
        // Keep the settled attempt linked, but never replay malformed tool-call prose.
        nativeFailureParent = native.id
      } else {
        const converted=bridgeResponse(native.json,protocol,'anthropic',body.model)
        converted.usage=usageForProtocol(object(object(native.json).usage),protocol,'anthropic')
        if(!array(converted.content).some(block=>object(block).type==='tool_use'&&configs.some(config=>config.name===object(block).name)))return native
        initialResponse={id:native.id,json:converted}
      }
    }catch(error){
      if(!(error instanceof GatewayError)||error.code!=='upstream_error'||!/(unsupported|not supported|unknown|invalid).{0,80}(web_search|web_fetch|server.?tool)|(web_search|web_fetch).{0,80}(unsupported|not supported)/i.test(error.message))throw error
      nativeFailureParent=error.requestId
      if (error.requestId) {
        const selected = await gateway.repo.selectedUpstream(error.requestId).catch(error => { gateway.report(error); return undefined })
        const observed = candidates.find(candidate => candidate.upstream.id === selected?.id)?.upstream
        const namedTools = configs.filter(config => error.message.includes(config.name))
        if (observed) for (const config of namedTools.length ? namedTools : configs) recordNativeToolSupport(gateway.repo.db, observed, false, config.name === 'web_fetch' ? 'web-fetch' : 'web-search')
      }
    }
  }
  const generic = configs.map((config) => ({
    name: config.name,
    description:
      config.name === 'web_search'
        ? 'Search the web for current sources.'
        : 'Fetch a web page.',
    input_schema: {
      type: 'object',
      properties:
        config.name === 'web_search'
          ? { query: { type: 'string' } }
          : { url: { type: 'string' } },
      required: [config.name === 'web_search' ? 'query' : 'url'],
    },
  }))
  const clean = {
    ...body,
    tools: [...array(body.tools).filter((tool) => !kind(object(tool))), ...generic.map(tool => {
      if(protocol==='anthropic')return tool
      const fn={name:tool.name,description:tool.description,parameters:tool.input_schema}
      return protocol==='responses'?{type:'function',...fn}:{type:'function',function:fn}
    })],
    ...(protocol==='responses' && configs.some(config=>config.name===object(body.tool_choice).type)
      ? {tool_choice:{type:'function',name:object(body.tool_choice).type}} : {}),
    stream: false,
  }
  let canonical: Obj
  try {
    canonical = normalizeHistory(
      bridgeRequest(clean, protocol, 'anthropic', bridgeOptions),
    )
  } catch {
    throw new GatewayError(
      400,
      '请求无法转换为服务端工具执行格式',
      'unsupported_feature',
    )
  }
  const counts = new Map<string, number>(),
    content: Obj[] = [],
    roundUsage: Obj[] = []
  let root = '',
    last: Obj = {},
    totalBytes = 0
  const maxRounds = Math.min(10, Math.max(2, Math.min(...configs.map(config => config.max)) + 2))
  for (let round = 0; round < maxRounds; round++) {
    if (round === maxRounds - 1) {
      canonical = { ...canonical, tools: array(canonical.tools).filter(raw => !configs.some(config => object(raw).name === config.name)) }
      delete canonical.tool_choice
    }
    if (deadline.aborted)
      throw new GatewayError(
        signal.aborted ? 499 : 504,
        '服务端工具执行已取消或超时',
      )
    const response = round===0 && initialResponse ? initialResponse : await gateway.execute(
      key,
      canonical,
      'anthropic',
      deadline,
      headers,
      { parentRequestId: root || nativeFailureParent, inboundProtocol: protocol },
    )
    root ||= response.id
    last = object(response.json)
    const blocks = array(last.content).map(object)
    totalBytes += Buffer.byteLength(JSON.stringify(last))
    if (totalBytes > 1024 * 1024)
      throw new GatewayError(
        502,
        '服务端工具会话超过大小上限',
        'tool_history_too_large',
      )
    roundUsage.push(object(last.usage))
    const serverCalls = blocks.filter(
      (block) =>
        block.type === 'tool_use' &&
        configs.some((config) => config.name === block.name),
    )
    if (!serverCalls.length) {
      content.push(...blocks)
      break
    }
    const wireIds = new Map(serverCalls.map(call=>[call,serverToolId(root+"_"+round+"_"+String(call.id))]))
    const replies: Obj[] = []
    const emitted = new Map<Obj, Obj[]>()
    for (const call of serverCalls) {
      const config = configs.find((config) => config.name === call.name)!
      const queries = config.name === 'web_search' ? searchQueries(call.input) : []
      const inputs = config.name === 'web_search' ? (queries.length ? queries : ['']).map(query => ({query})) : [object(call.input)]
      const results: Obj[] = [], replyValues: unknown[] = []
      let anyError = false
      for (const [offset, input] of inputs.entries()) {
        const count = counts.get(config.name) ?? 0
        const wireId = wireIds.get(call)! + (offset ? '_' + offset : '')
        let value: unknown, errorCode: string | undefined
        try {
          if (config.name === 'web_search' && !queries.length)
            throw new GatewayError(400, '搜索工具缺少查询词', 'invalid_tool_input')
          if (count >= config.max)
            throw new GatewayError(
              429,
              '服务端工具达到调用上限',
              'max_uses_exceeded',
            )
          counts.set(config.name, count + 1)
          if (config.name === 'web_search' && Array.from(String(input.query)).length > 400)
            throw new GatewayError(400, '搜索查询词超过长度上限', 'query_too_long')
          value = await executeServerTool(
            gateway,
            key,
            body.model,
            config.name,
            {
              ...input,
              ...(config.name === 'web_search' ? { limit: 5 } : {}),
              allowed_domains: config.allowed_domains,
              blocked_domains: config.blocked_domains,
              ...(config.user_location ? {user_location:config.user_location}:{}),
              ...(config.max_content_tokens ? {max_content_tokens:config.max_content_tokens}:{}),
            },
            response.id,
            deadline,
          )
        } catch (error) {
          if (
            deadline.aborted ||
            (error instanceof GatewayError && ([401, 403].includes(error.status) || error.code === 'settlement_failed' || (error.status === 429 && error.code !== 'max_uses_exceeded')))
          )
            throw error
          errorCode = error instanceof GatewayError ? error.code : 'tool_failed'
          value = { error: errorCode }
        }
        replyValues.push(value)
        anyError ||= !!errorCode
        const resultType =
          config.name === 'web_search'
            ? 'web_search_tool_result'
            : 'web_fetch_tool_result'
        results.push({ ...call, id: wireId, type: 'server_tool_use', input }, {
          type: resultType,
          tool_use_id: wireId,
          content: errorCode
            ? { type: resultType + '_error', error_code: errorCode }
            : config.name === 'web_search'
              ? array(value).map((source) => ({
                  ...object(source),
                  type: 'web_search_result',
                  encrypted_content:
                    'coati1:' +
                    Buffer.from(
                      JSON.stringify({
                        url: object(source).url,
                        title: object(source).title,
                        content: object(source).snippet,
                      }),
                    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
                }))
              : {
                  type: 'web_fetch_result',
                  url: object(value).url,
                  content: {
                    type: 'document',
                    source: {
                      type: 'text',
                      media_type: 'text/plain',
                      data: object(value).text,
                    },
                    title: object(value).title,
                  },
                },
        })
        totalBytes += Buffer.byteLength(JSON.stringify(results.slice(-2)))
        if (totalBytes > 1024 * 1024)
          throw new GatewayError(502, '服务端工具会话超过大小上限', 'tool_history_too_large')
      }
      emitted.set(call, results)
      replies.push({type:'tool_result', tool_use_id:call.id,
        content:JSON.stringify(replyValues.length === 1 ? replyValues[0] : replyValues),
        ...(anyError ? {is_error:true} : {})})
    }
    content.push(...blocks.flatMap(block => emitted.get(block) ?? [block]))
    if (
      blocks.some(
        (block) => block.type === 'tool_use' && !serverCalls.includes(block),
      )
    )
      break
    if (round === maxRounds - 1)
      throw new GatewayError(
        502,
        '服务端工具超过最大对话轮次',
        'tool_round_limit',
      )
    canonical = {
      ...canonical,
      messages: [
        ...array(canonical.messages),
        { role: 'assistant', content: blocks },
        { role: 'user', content: replies },
      ],
      tool_choice: { type: 'auto' },
    }
  }
  const final = {
    ...last,
    id: root || randomUUID(),
    model: body.model,
    content,
    usage: {...aggregateToolUsage(roundUsage), server_tool_use: {web_search_requests:counts.get('web_search') ?? 0, web_fetch_requests:counts.get('web_fetch') ?? 0}},
  }
  // Chat/Responses have no shared fetch-result block. Preserve server evidence as
  // explicit text, rather than dropping it or fabricating provider-native citations.
  const wireFinal = protocol === 'anthropic' ? final : {
    ...final, content: content.flatMap(block => {
      if (block.type === 'server_tool_use') return []
      if (['web_search_tool_result','web_fetch_tool_result'].includes(String(block.type))) {
        const results = Array.isArray(block.content) ? block.content.map(raw => {
          const source = {...object(raw)}
          delete source.encrypted_content
          return source
        }) : block.content
        return [{type:'text',text:'\n[' + String(block.type) + ']\n' + JSON.stringify(results) + '\n'}]
      }
      return [block]
    }),
  }
  if (body.stream) {
    const model = body.model
    async function* stream() {
      try {
        yield* bridgeStream(
          frames(wireFinal),
          'anthropic',
          protocol,
          model,
          new UsageMeter(),
          bridgeOptions,
        )
      } catch {
        yield streamError(
          protocol,
          '服务端工具结果无法转换',
          root,
          'protocol_error',
        )
      }
    }
    return { id: root, stream: stream() }
  }
  let converted: Obj
  try {
    converted = bridgeResponse(
      wireFinal,
      'anthropic',
      protocol,
      body.model,
      bridgeOptions,
    )
  } catch {
    const error = new GatewayError(
      502,
      '服务端工具结果无法转换',
      'protocol_error',
    )
    error.requestId = root
    throw error
  }

  converted.usage = protocol === 'anthropic' ? final.usage : usageForProtocol(final.usage, 'anthropic', protocol)
  return { id: root, json: converted }
}
