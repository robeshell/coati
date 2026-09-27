import { nativeToolSupport, recordNativeToolSupport } from '../src/modules/gateway/native-tool-support'
import { searchOnlyQuery } from '../src/modules/gateway/search-shortcut'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeAll, afterAll, beforeEach, test, expect, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  openTestDb,
  buildTestApp,
  superAdminSession,
  cleanupFixture,
} from './helpers'
import { GatewayService, gatewayOptions } from '../src/modules/gateway/service'
import { SearchSettingsService } from '../src/modules/gateway/search-settings'
import { TavilySearchProvider } from '../src/modules/gateway/search-provider'
import { executeServerTool, executeServerToolResult } from '../src/modules/gateway/tool-execution'
import { executeWithServerTools, serverToolConfigs } from '../src/modules/gateway/server-tool-loop'
import { object, array } from '../src/modules/gateway/protocol/compat-helpers'
const db = openTestDb()
let app: FastifyInstance,
  mock: FastifyInstance,
  gateway: GatewayService,
  token = '',
  searches = 0,
  fetches = 0,
  modelCalls = 0,
  mode = 'normal',
  observedMessages: unknown
beforeAll(async () => {
  mock = Fastify()
  mock.post('/search', async () => {
    searches++
    return {
      results: [
        {
          url: 'https://example.com/page',
          title: 'Source',
          content: 'fixture snippet',
        },
      ],
    }
  })
  mock.post('/extract', async () => {
    fetches++
    return {
      results: [
        { url: 'https://example.com/page', raw_content: 'fixture document' },
      ],
    }
  })
  mock.post('/v1/messages', async (request, reply) => {
    modelCalls++
    const input = object(request.body)
    observedMessages = input
    if (mode === 'native-fetch') return {id:'native-fetch',type:'message',role:'assistant',model:'fixture',
      content:[{type:'web_fetch_tool_result',tool_use_id:'fetch',content:{type:'web_fetch_result',url:'https://example.com/page',
        content:{type:'document',source:{type:'text',data:'中文🙂abc'}}}}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:5}}
    if (mode === 'native-leaked' && array(input.tools).some(tool => String(object(tool).type).startsWith('web_search')))
      return {id:'native-fixture',type:'message',role:'assistant',model:'fixture',content:[{type:'text',text:'<tool_call>{"name":"web_search"}</tool_call>'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:5}}
    if (mode !== 'native-pending' && array(input.tools).some(tool => String(object(tool).type).startsWith('web_search')))
      return reply.code(400).send({error:{message:'unsupported web_search server tool'}})
    const completed = array(input.messages).some(message => array(object(message).content).some(block=>object(block).type==='tool_result'))
    return {id:'native-fixture',type:'message',role:'assistant',model:'fixture',
      content:completed ? [{type:'text',text:'Native fallback finished'}] : [{type:'tool_use',id:'native-search',name:'web_search',input:{query:'fixture'}}],
      stop_reason:completed?'end_turn':'tool_use', usage:{input_tokens:10,output_tokens:5}}
  })
  mock.post('/v1/chat/completions', async (request) => {
    modelCalls++
    const body = object(request.body),
      history = array(body.messages).map(object),
      round = history.filter((message) => message.role === 'tool').length
    const name = round === 0 || mode === 'repeat' ? 'web_search' : 'web_fetch'
    const args =
      name === 'web_search'
        ? (mode === 'multi-query' ? {queries:'["first","second","first"]', q:'third'} : { query: 'fixture' })
        : {
            url:
              mode === 'blocked'
                ? 'https://blocked.example/page'
                : 'https://example.com/page',
          }
    return {
      id: 'fixture-model',
      object: 'chat.completion',
      model: 'fixture',
      choices: [
        {
          index: 0,
          message:
            round >= 2 && mode !== 'repeat'
              ? { role: 'assistant', content: 'Finished with sources' }
              : {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'tool-' + round,
                      type: 'function',
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                },
          finish_reason:
            round >= 2 && mode !== 'repeat' ? 'stop' : 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        ...(mode === 'partial-usage' && round === 1 ? {} : {prompt_tokens_details: { cached_tokens: 4 }}),
      },
    }
  })
  const base = await mock.listen({ host: '127.0.0.1', port: 0 })
  vi.stubEnv('GATEWAY_ALLOW_PRIVATE_UPSTREAMS','true')
  app = await buildTestApp()
  const admin = await superAdminSession(app, db)
  gateway = new GatewayService(db.db, {
    ...gatewayOptions(app.config),
    allowPrivate: true,
  })
  const account = await gateway.saveUpstream({
    name: 'tool-loop-fixture',
    base_url: base + '/v1',
    protocol: 'openai',
    api_key: 'fixture',
    supported_models: ['fixture'],
  })
  await gateway.saveRoute({
    model: 'tool-fixture',
    upstream_id: account.id,
    upstream_model: 'fixture',
  })
  token = (
    await gateway.createKey(admin.userId, {
      name: 'tool-loop-fixture',
      models: ['tool-fixture'],
    })
  ).token
  const provider = new TavilySearchProvider(gateway.transport, {
    apiKey: 'fixture',
    baseUrl: base,
  })
  vi.spyOn(SearchSettingsService.prototype, 'provider').mockResolvedValue(
    provider,
  )
})
beforeEach(() => {
  searches = 0
  fetches = 0
  modelCalls = 0
  mode = 'normal'
  observedMessages = undefined
})
afterAll(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await app.close()
  await gateway.transport.close()
  await mock.close()
  await db.db.execute(
    sql`delete from gw_attempts where request_id in(select id from gw_requests where key_id in(select id from gw_keys where name='tool-loop-fixture'))`,
  )
  await db.db.execute(
    sql`delete from gw_requests where key_id in(select id from gw_keys where name='tool-loop-fixture')`,
  )
  await db.db.execute(sql`delete from gw_keys where name='tool-loop-fixture'`)
  await db.db.execute(sql`delete from gw_routes where model='tool-fixture'`)
  await db.db.execute(
    sql`delete from gw_upstreams where name='tool-loop-fixture'`,
  )
  await cleanupFixture(db)
  await db.pool.end()
})
const body = (stream = false) => ({
  model: 'tool-fixture',
  messages: [{ role: 'user', content: 'Search and fetch' }],
  max_tokens: 100,
  stream,
  tools: [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 1 },
    {
      type: 'web_fetch_20250910',
      name: 'web_fetch',
      max_uses: 1,
      allowed_domains: ['example.com'],
    },
  ],
})
test('search and fetch execute as bounded rounds with cache usage and durable child requests', async () => {
  const response = await executeWithServerTools(
    gateway,
    await gateway.authenticate(token),
    body(),
    'anthropic',
    AbortSignal.timeout(5000),
    {},
  )
  expect(response.json).toMatchObject({
    usage: { input_tokens: 18, output_tokens: 15, cache_read_input_tokens: 12, server_tool_use:{web_search_requests:1,web_fetch_requests:1} },
  })
  expect(
    array(object(response.json).content).map((block) => object(block).type),
  ).toEqual([
    'server_tool_use',
    'web_search_tool_result',
    'server_tool_use',
    'web_fetch_tool_result',
    'text',
  ])
  expect(searches).toBe(1)
  expect(fetches).toBe(1)
  const rows = await db.db.execute(
    sql`select id,protocol,status,raw_usage,request_context from gw_requests where key_id in(select id from gw_keys where name='tool-loop-fixture')`,
  )
  expect(rows.rows.filter((row) => row.protocol === 'web-search')).toHaveLength(
    1,
  )
  expect(rows.rows.filter((row) => row.protocol === 'web-fetch')).toHaveLength(
    1,
  )
  expect(rows.rows.every((row) => row.status === 'ok')).toBe(true)
  const search = rows.rows.find(row=>row.protocol==='web-search')!
  const fetch = rows.rows.find(row=>row.protocol==='web-fetch')!
  expect(object(search.raw_usage).parent_request_id).toBe(response.id)
  expect(object(fetch.raw_usage).parent_request_id).not.toBe(response.id)
  expect(rows.rows.some(row=>row.id===object(fetch.raw_usage).parent_request_id && row.protocol==='anthropic')).toBe(true)
})
test('buffered fallback emits a valid native Messages event sequence after accounting', async () => {
  const response = await executeWithServerTools(
    gateway,
    await gateway.authenticate(token),
    body(true),
    'anthropic',
    AbortSignal.timeout(5000),
    {},
  )
  let wire = ''
  if (response.stream) for await (const chunk of response.stream) wire += chunk
  expect(wire).toContain('event: message_start')
  const start = wire.split('\n').find(line => line.startsWith('data: '))!
  expect(JSON.parse(start.slice(6)).message.usage.cache_read_input_tokens).toBe(12)
  expect(wire).toContain('web_search_tool_result')
  expect(wire).toContain('Finished with sources')
  expect(wire).toContain('event: message_stop')
  expect(searches).toBe(1)
  expect(fetches).toBe(1)
})
test('fetch domain restrictions prevent provider extraction and return an explicit tool error', async () => {
  mode = 'blocked'
  const response = await executeWithServerTools(
    gateway,
    await gateway.authenticate(token),
    body(),
    'anthropic',
    AbortSignal.timeout(5000),
    {},
  )
  expect(JSON.stringify(response.json)).toContain('url_not_allowed')
  expect(searches).toBe(1)
  expect(fetches).toBe(0)
})
test('max uses and global round bounds prevent unbounded external requests', async () => {
  mode = 'repeat'
  await expect(
    executeWithServerTools(
      gateway,
      await gateway.authenticate(token),
      body(),
      'anthropic',
      AbortSignal.timeout(5000),
      {},
    ),
  ).rejects.toMatchObject({ code: 'tool_round_limit' })
  expect(searches).toBe(1)
  expect(fetches).toBe(0)
})

test('public Messages API actually dispatches the server-tool loop',async()=>{
  const response=await app.inject({method:'POST',url:'/v1/messages',headers:{authorization:`Bearer ${token}`},payload:body()})
  expect(response.statusCode).toBe(200)
  expect(response.json().content.some((block:Record<string,unknown>)=>block.type==='web_fetch_tool_result')).toBe(true)
  expect(searches).toBe(1);expect(fetches).toBe(1)
})

test('Chat and Responses fallback preserve actual search/fetch evidence in JSON and SSE', async () => {
  for (const protocol of ['openai','responses'] as const) for (const stream of [false,true]) {
    const input = protocol === 'responses' ? {...body(stream), input:'Search and fetch', messages:undefined, max_output_tokens:100, max_tokens:undefined} : body(stream)
    const response=await executeWithServerTools(gateway,await gateway.authenticate(token),input,protocol,AbortSignal.timeout(5000),{})
    let wire=JSON.stringify(response.json) ?? ''
    if(response.stream)for await(const chunk of response.stream)wire+=chunk
    expect(wire).toContain('https://example.com/page')
    expect(wire).toContain('fixture document')
    expect(wire).toContain('Finished with sources')
    expect(wire).not.toContain('protocol_error')
    expect((await gateway.repo.requestById(response.id))?.protocol).toBe(protocol)
  }
})

test('explicit native tool refusal retries with function tools and links the failed attempt', async () => {
  const account = (await db.db.execute(sql`select id,base_url from gw_upstreams where name='tool-loop-fixture'`)).rows[0]!
  await db.db.execute(sql`update gw_upstreams set protocol='anthropic' where id=${account.id}`)
  const nativeAccount = (await gateway.repo.upstreams()).find(row => row.id === account.id)!
  recordNativeToolSupport(gateway.repo.db, nativeAccount, true)
  recordNativeToolSupport(gateway.repo.db, nativeAccount, true, 'web-fetch')
  try {
    const response=await executeWithServerTools(gateway,await gateway.authenticate(token),body(),'anthropic',AbortSignal.timeout(5000),{})
    expect(JSON.stringify(response.json)).toContain('Native fallback finished')
    expect(searches).toBe(1)
    expect(fetches).toBe(0)
    const row=(await db.db.execute(sql`select request_context from gw_requests where id=${response.id}`)).rows[0]!
    expect(object(row.request_context).parent_request_id).toBeTruthy()
  } finally {
    await db.db.execute(sql`update gw_upstreams set protocol='openai' where id=${account.id}`)
  }
})

test('original request restrictions survive tool conversion and settlement failure is never retried as zero usage', async () => {
  const key = await gateway.authenticate(token)
  const input = {...body(),tools:[body().tools[0]],messages:[{role:'user',content:'Perform a web search for the query: fixture'}]}
  for (const headers of [{ 'x-coati-reasoning-policy':'invalid' }, { 'x-coati-compatibility-policy':'invalid' }]) {
    await expect(executeWithServerTools(gateway,key,input,'anthropic',AbortSignal.timeout(5000),headers)).rejects.toMatchObject({status:400,code:'invalid_request'})
  }
  expect(searches).toBe(0)
  expect(modelCalls).toBe(0)
  for (const extra of [{n:2},{store:true},{background:true}]) {
    await expect(executeWithServerTools(gateway,key,{...body(),...extra},'responses',AbortSignal.timeout(5000),{'x-coati-compatibility-policy':'strict'})).rejects.toThrow()
  }
  expect(searches).toBe(0)
  const finish=vi.spyOn(gateway.repo,'finish').mockRejectedValueOnce(new Error('fixture settlement outage'))
  try {
    await expect(executeServerTool(gateway,key,'tool-fixture','web_search',{query:'fixture'},'fixture-parent',AbortSignal.timeout(5000))).rejects.toThrow()
    expect(finish).toHaveBeenCalledTimes(1)
    expect(finish.mock.calls[0]![1]).toMatchObject({status:'ok'})
    expect(finish.mock.calls[0]![1].output_tokens).toBeGreaterThan(0)
  } finally { finish.mockRestore() }
})

test('partial round usage retains reported cache totals and labels incompleteness in all client protocols', async () => {
  mode = 'partial-usage'
  for (const protocol of ['anthropic','openai','responses'] as const) for (const stream of [false,true]) {
    const input = protocol === 'responses' ? {...body(stream),input:'Search and fetch',messages:undefined,max_output_tokens:100,max_tokens:undefined} : body(stream)
    const response = await executeWithServerTools(gateway,await gateway.authenticate(token),input,protocol,AbortSignal.timeout(5000),{})
    let wire = JSON.stringify(response.json) ?? ''
    if (response.stream) for await (const chunk of response.stream) wire += chunk
    expect(wire).toContain('sum_reported')
    expect(wire).toContain('partial_fields')
    expect(wire).toContain('cache_read_input_tokens')
    expect(wire).not.toContain('protocol_error')
    if (!stream) {
      const usage = object(object(response.json).usage)
      expect(usage.coati_usage).toMatchObject({rounds:3,partial_fields:expect.arrayContaining(['cache_read_input_tokens'])})
      expect(protocol === 'anthropic' ? usage.cache_read_input_tokens : object(usage[protocol==='openai'?'prompt_tokens_details':'input_tokens_details']).cached_tokens).toBe(8)
      expect(protocol === 'anthropic' ? Number(usage.input_tokens)+Number(usage.cache_read_input_tokens) : usage[protocol==='openai'?'prompt_tokens':'input_tokens']).toBe(30)
    }
  }
})

test('server-tool max uses preserves Python zero, large and malformed values', () => {
  const max = (value: unknown) => serverToolConfigs({ tools: [{ type: 'web_search_20250305', max_uses: value }] })[0]!.max
  expect([max(0), max(12), max(-1), max('9'), max('invalid')]).toEqual([0, 12, 0, 9, 5])
})


test.each(['native-pending', 'native-leaked'])('Messages streaming handles %s before returning the final SSE', async (nativeMode) => {
  const account = (await db.db.execute(sql`select id from gw_upstreams where name='tool-loop-fixture'`)).rows[0]!
  await db.db.execute(sql`update gw_upstreams set protocol='anthropic' where id=${account.id}`)
  const nativeAccount = (await gateway.repo.upstreams()).find(row => row.id === account.id)!
  recordNativeToolSupport(gateway.repo.db, nativeAccount, true)
  recordNativeToolSupport(gateway.repo.db, nativeAccount, true, 'web-fetch')
  mode = nativeMode
  try {
    const response = await executeWithServerTools(gateway, await gateway.authenticate(token), body(true), 'anthropic', AbortSignal.timeout(5000), {})
    let wire = ''
    if (response.stream) for await (const chunk of response.stream) wire += chunk
    expect(wire).toContain('Native fallback finished')
    expect(wire).not.toContain('<tool_call>')
    expect(wire).toContain('web_search_tool_result')
    expect(wire).toContain('event: message_stop')
    expect(searches).toBe(1)
    expect(nativeToolSupport(gateway.repo.db, nativeAccount)).toBe(false)
  } finally {
    await db.db.execute(sql`update gw_upstreams set protocol='openai' where id=${account.id}`)
  }
})


test('Messages replays Python search and fetch history without declaring tools again', async () => {
  const account = (await gateway.repo.upstreams()).find(row => row.name === 'tool-loop-fixture')!
  await db.db.execute(sql`update gw_upstreams set protocol='anthropic' where id=${account.id}`)
  const nativeAccount = (await gateway.repo.upstreams()).find(row => row.id === account.id)!
  recordNativeToolSupport(gateway.repo.db, nativeAccount, true)
  recordNativeToolSupport(gateway.repo.db, nativeAccount, true, 'web-fetch')
  const encoded = 'coati1:' + Buffer.from(JSON.stringify({url:'https://example.com',title:'Source',content:'Restored historical body'})).toString('base64')
  try {
    const response = await executeWithServerTools(gateway,await gateway.authenticate(token),{
      model:'tool-fixture',max_tokens:64,messages:[{role:'assistant',content:[
        {type:'server_tool_use',id:'old-search',name:'web_search',input:{query:'old query'}},
        {type:'web_search_tool_result',tool_use_id:'old-search',content:[{type:'web_search_result',encrypted_content:encoded}]},
        {type:'web_fetch_tool_result',tool_use_id:'old-fetch',content:{type:'web_fetch_result',url:'https://example.com',content:{type:'document',source:{type:'text',data:'Historical page body'}}}},
      ]},{role:'user',content:'Continue from these sources'}],
    },'anthropic',AbortSignal.timeout(5000),{})
    expect(response.json).toBeTruthy()
    const wire = JSON.stringify(observedMessages)
    expect(wire).toContain('Restored historical body')
    expect(wire).toContain('Historical page body')
    expect(wire).not.toContain('coati1:')
    expect(wire).not.toContain('server_tool_use')
    expect(searches+fetches).toBe(0)
  } finally {
    await db.db.execute(sql`update gw_upstreams set protocol='openai' where id=${account.id}`)
  }
})

test('query aliases expand into paired results, deduplicate and obey per-query search budget', async () => {
  mode = 'multi-query'
  const response = await executeWithServerTools(gateway, await gateway.authenticate(token), body(), 'anthropic', AbortSignal.timeout(5000), {})
  const content = array(object(response.json).content).map(object)
  const calls = content.filter(block => block.type === 'server_tool_use' && block.name === 'web_search')
  expect(calls.map(call => object(call.input).query)).toEqual(['first','second','third'])
  expect(new Set(calls.map(call => call.id)).size).toBe(3)
  for (const call of calls) expect(content[content.indexOf(call) + 1]).toMatchObject({type:'web_search_tool_result',tool_use_id:call.id})
  expect(content.filter(block => object(block.content).error_code === 'max_uses_exceeded')).toHaveLength(2)
  expect(searches).toBe(1)
  expect(fetches).toBe(1)
})

test('accounts recorded as nonexecuting use executable function tools without optimistic native declarations', async () => {
  const account = (await gateway.repo.upstreams()).find(row => row.name === 'tool-loop-fixture')!
  await db.db.execute(sql`update gw_upstreams set protocol='anthropic' where id=${account.id}`)
  try {
    const current = (await gateway.repo.upstreams()).find(row => row.id === account.id)!
    recordNativeToolSupport(gateway.repo.db, current, false)
    const response = await executeWithServerTools(gateway,await gateway.authenticate(token),body(),'anthropic',AbortSignal.timeout(5000),{})
    expect(JSON.stringify(response.json)).toContain('Native fallback finished')
    expect(array(object(observedMessages).tools).some(tool => String(object(tool).type).startsWith('web_search'))).toBe(false)
    const rows = await db.db.execute(sql`select status from gw_requests where key_id in(select id from gw_keys where name='tool-loop-fixture') and id=${response.id}`)
    expect(rows.rows).toEqual([{status:'ok'}])
  } finally {
    await db.db.execute(sql`update gw_upstreams set protocol='openai' where id=${account.id}`)
  }
})

test('dedicated search shortcut avoids model calls, keeps a real receipt and falls back on failure', async () => {
  const input = {...body(),tools:[body().tools[0]],messages:[{role:'user',content:'Perform a web search for the query: fixture'}]}
  expect(searchOnlyQuery({...input,messages:[{role:'user',content:'How much does Claude Code cost?'}]})).toBeUndefined()
  expect(searchOnlyQuery({...input,tools:body().tools})).toBeUndefined()
  expect(searchOnlyQuery({...input,messages:[...input.messages,{role:'assistant',content:'history'}]})).toBeUndefined()
  const key = await gateway.authenticate(token)
  for (const stream of [false,true]) {
    const response = await executeWithServerTools(gateway,key,{...input,stream},'anthropic',AbortSignal.timeout(5000),{})
    let wire=JSON.stringify(response.json) ?? ''
    if(response.stream) for await(const chunk of response.stream) wire+=chunk
    expect(wire).toContain('web_search_tool_result')
    expect(wire).toContain('fixture snippet')
    expect(modelCalls).toBe(0)
    const receipt=(await db.db.execute(sql`select status,protocol,usage_source,raw_usage,input_tokens,output_tokens from gw_requests where id=${response.id}`)).rows[0]!
    expect(receipt).toMatchObject({status:'ok',protocol:'web-search',usage_source:'estimated'})
    expect(object(receipt.raw_usage).parent_request_id).toBeUndefined()
    if (!stream) expect(object(response.json).usage).toMatchObject({input_tokens:Number(receipt.input_tokens),output_tokens:Number(receipt.output_tokens)})
  }
  const provider=vi.spyOn(TavilySearchProvider.prototype,'search').mockRejectedValueOnce(new Error('temporary search failure'))
  try {
    const response=await executeWithServerTools(gateway,key,input,'anthropic',AbortSignal.timeout(5000),{})
    expect(modelCalls).toBeGreaterThan(0)
    expect(JSON.stringify(response.json)).toContain('web_search_tool_result')
  } finally {provider.mockRestore()}
})


test('tool reservations use configured TTL and native extraction shares the UTF-8 bound', async () => {
  const account=(await gateway.repo.upstreams()).find(row=>row.name==='tool-loop-fixture')!
  const originalTtl=gateway.options.reservationTtlSeconds
  const provider=vi.spyOn(TavilySearchProvider.prototype,'fetch').mockResolvedValueOnce({url:'https://example.com/page',title:null,text:'中文🙂abc',retrieved_at:null,truncated:false})
  try {
    gateway.options.reservationTtlSeconds=7200
    const key=await gateway.authenticate(token)
    const args={url:'https://example.com/page',max_content_tokens:7}
    const direct=await executeServerToolResult(gateway,key,'tool-fixture','web_fetch',args,undefined,AbortSignal.timeout(5000))
    expect(direct.result).toMatchObject({text:'中文',truncated:true})
    const receipt=await gateway.repo.requestById(direct.id)
    expect(Date.parse(receipt!.expires_at!)-Date.parse(receipt!.created_at)).toBeGreaterThan(7190000)
    provider.mockRejectedValueOnce(new (await import('../src/modules/gateway/schema')).GatewayError(502,'fixture','search_upstream_error'))
    await gateway.saveUpstream({...account,protocol:'anthropic'},account.id)
    const nativeAccount=(await gateway.repo.upstreams()).find(row=>row.id===account.id)!
    recordNativeToolSupport(gateway.repo.db,nativeAccount,false,'web-search')
    mode='native-fetch'
    const native=await executeServerToolResult(gateway,key,'tool-fixture','web_fetch',args,undefined,AbortSignal.timeout(5000))
    expect(native.result).toMatchObject({text:'中文',truncated:true})
    expect(native.result).not.toHaveProperty('requestId')
    expect((await gateway.repo.requestById(native.id))?.usage_source).toBe('upstream')
  } finally {
    gateway.options.reservationTtlSeconds=originalTtl
    provider.mockRestore()
    await gateway.saveUpstream({...account,protocol:account.protocol},account.id)
  }
})
