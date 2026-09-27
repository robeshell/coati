import { capabilityCandidate } from '../src/modules/gateway/capability-route'
import { executeServerTool } from '../src/modules/gateway/tool-execution'
import Fastify, { type FastifyInstance } from 'fastify'
import { beforeAll, afterAll, beforeEach, test, expect, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  buildTestApp,
  openTestDb,
  superAdminSession,
  cleanupFixture,
  type AuthedSession,
} from './helpers'
import { GatewayService, gatewayOptions } from '../src/modules/gateway/service'
import { SearchSettingsService } from '../src/modules/gateway/search-settings'
import { TavilySearchProvider } from '../src/modules/gateway/search-provider'
import { WebSearchService } from '../src/modules/gateway/web-search'
const db = openTestDb()
let delegateBase = ''
let app: FastifyInstance,
  mock: FastifyInstance,
  admin: AuthedSession,
  gateway: GatewayService,
  provider: TavilySearchProvider
let calls = 0,
  mode = 'ok',
  token = '',
  keyId = 0,
  observedLimit: unknown
let entered: () => void, release: () => void
beforeAll(async () => {
  mock = Fastify()
  mock.post('/rejected/v1/responses', async (_request, reply) => reply.code(401).send({error:{message:'fixture invalid account'}}))
  mock.post('/search', async (_request, reply) => {
    calls++
    observedLimit = (_request.body as Record<string, unknown>).max_results
    if (mode === 'hold') {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    if (mode === 'fail')
      return reply.code(401).send({ error: 'never-echo-fixture-secret' })
    return {
      results: [
        {
          url: 'https://example.com',
          title: 'Fixture',
          content: '文'.repeat(15000),
        },
      ],
    }
  })
  mock.post('/v1/responses', async () => ({
    id: 'delegate-fixture',
    object: 'response',
    status: 'completed',
    model: 'native-search',
    output: [
      {
        type: 'web_search_call',
        id: 'call-fixture',
        status: 'completed',
        action: {
          type: 'search',
          sources: [
            { url: 'https://example.org/source', title: 'Native source' },
          ],
        },
      },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 7,
      input_tokens_details: { cached_tokens: 4 },
    },
  }))
  mock.post('/v1/messages', async () => ({
    id:'fetch-fixture',type:'message',role:'assistant',model:'native-search',stop_reason:'end_turn',
    content:[{type:'web_fetch_tool_result',tool_use_id:'fetch1',content:{type:'web_fetch_result',url:'https://example.org/source',content:{type:'document',title:'Native document',source:{type:'text',data:'Verified document'}}}}],
    usage:{input_tokens:8,output_tokens:4},
  }))
  const baseUrl = await mock.listen({ host: '127.0.0.1', port: 0 })
  delegateBase = baseUrl
  app = await buildTestApp()
  admin = await superAdminSession(app, db)
  gateway = new GatewayService(db.db, {
    ...gatewayOptions(app.config),
    allowPrivate: true,
  })
  provider = new TavilySearchProvider(gateway.transport, {
    apiKey: 'fixture',
    baseUrl,
  })
  vi.spyOn(SearchSettingsService.prototype, 'provider').mockImplementation(
    async () => provider,
  )
})
async function clean() {
  await db.db.execute(
    sql`delete from gw_attempts where request_id in (select id from gw_requests where key_id in (select id from gw_keys where name like 'search-fixture%'))`,
  )
  await db.db.execute(sql`delete from gw_routes where model in ('web-search','web-fetch')`)
  await db.db.execute(
    sql`delete from gw_upstreams where name like 'delegated-fixture%'`,
  )
  await db.db.execute(
    sql`delete from gw_requests where key_id in (select id from gw_keys where name like 'search-fixture%')`,
  )
  await db.db.execute(
    sql`delete from gw_keys where name like 'search-fixture%'`,
  )
}
beforeEach(async () => {
  await clean()
  calls = 0
  mode = 'ok'
  const key = await gateway.createKey(admin.userId, {
    name: 'search-fixture',
    models: ['web-search'],
    concurrency_limit: 1,
  })
  token = key.token
  keyId = key.id
})
afterAll(async () => {
  vi.restoreAllMocks()
  await app.close()
  await gateway.transport.close()
  await mock.close()
  await clean()
  await cleanupFixture(db)
  await db.pool.end()
})
const request = (
  payload: Record<string, unknown> = { query: 'fixture search' },
  path = '/v1/web-search',
  authorization = `Bearer ${token}`,
) =>
  app.inject({ method: 'POST', url: path, headers: { authorization }, payload })
test('public aliases return bounded sources and honest estimated accounting, preserving request identity', async () => {
  const response = await request(
    { query: 'fixture search', max_results: 2 },
    '/api/agent/v1/web-search',
  )
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({
    query: 'fixture search',
    truncated: true,
    sources: [{ url: 'https://example.com/', title: 'Fixture' }],
  })
  expect(response.headers['x-agent-request-id']).toBe(
    response.headers['x-request-id'],
  )
  const rows = await db.db.execute(
    sql`select * from gw_requests where key_id=${keyId}`,
  )
  expect(rows.rows).toHaveLength(1)
  expect(rows.rows[0]).toMatchObject({
    status: 'ok',
    protocol: 'web-search',
    model: 'web-search',
    usage_source: 'estimated',
    cache_read_tokens: null,
    raw_usage: { provider: 'tavily', search_requests: 1, result_count: 1 },
  })
  expect(Number(rows.rows[0]!.output_tokens)).toBeLessThanOrEqual(4096)
  expect(new Date(String(rows.rows[0]!.expires_at)).getTime()-new Date(String(rows.rows[0]!.created_at)).getTime()).toBeGreaterThan(3590000)
  expect(JSON.stringify(rows.rows)).not.toContain('fixture search')
  expect(calls).toBe(1)
})
test('authorization, validation, daily quota and concurrent reservation block outbound calls', async () => {
  expect(
    (await request({}, '/v1/web-search', 'Bearer invalid')).statusCode,
  ).toBe(401)
  expect((await request({ query: '' })).statusCode).toBe(400)
  await db.db.execute(
    sql`update gw_keys set scopes='["profile"]'::jsonb where id=${keyId}`,
  )
  expect((await request()).statusCode).toBe(403)
  await db.db.execute(
    sql`update gw_keys set scopes='["chat"]'::jsonb,models='["another-model"]'::jsonb where id=${keyId}`,
  )
  expect((await request()).statusCode).toBe(403)
  await db.db.execute(
    sql`update gw_keys set models='["web-search"]'::jsonb,daily_limit=1 where id=${keyId}`,
  )
  expect((await request()).statusCode).toBe(429)
  expect(calls).toBe(0)
  await db.db.execute(sql`update gw_keys set daily_limit=0 where id=${keyId}`)
  mode = 'hold'
  const pendingEntry = new Promise<void>((resolve) => {
    entered = resolve
  })
  const first = request().then((result) => result)
  await pendingEntry
  try {
    expect((await request()).statusCode).toBe(429)
    expect(calls).toBe(1)
  } finally {
    release()
  }
  expect((await first).statusCode).toBe(200)
})
test('supplier failure and cancellation settle reservations without leaking secrets', async () => {
  mode = 'fail'
  const failure = await request()
  expect(failure.statusCode).toBe(502)
  expect(failure.body).not.toContain('never-echo')
  const search = new WebSearchService(gateway)
  const key = await gateway.authenticate(token)
  await expect(
    search.run(key, { query: 'cancel fixture' }, AbortSignal.abort()),
  ).rejects.toMatchObject({ status: 499 })
  const rows = await db.db.execute(
    sql`select status,input_tokens,output_tokens from gw_requests where key_id=${keyId} order by created_at`,
  )
  expect(rows.rows.map((row) => row.status)).toEqual([
    'upstream_error',
    'cancelled',
  ])
  expect(
    rows.rows.every(
      (row) =>
        Number(row.input_tokens) === 0 && Number(row.output_tokens) === 0,
    ),
  ).toBe(true)
  expect(calls).toBe(1)
})

test('missing configuration produces an audited unavailable response without outbound calls', async () => {
  vi.spyOn(SearchSettingsService.prototype, 'provider').mockResolvedValueOnce(
    null,
  )
  const response = await request()
  expect(response.statusCode).toBe(503)
  expect(response.json().error.code).toBe('search_unconfigured')
  const rows = await db.db.execute(
    sql`select status,raw_usage from gw_requests where id=${response.json().request_id}`,
  )
  expect(rows.rows[0]).toMatchObject({
    status: 'upstream_error',
    raw_usage: { search_requests: 0 },
  })
  expect(calls).toBe(0)
})

test('provider failure delegates to an explicitly configured native route with normal model usage and parent linkage', async () => {
  mode = 'fail'
  const account = await gateway.saveUpstream({
    name: 'delegated-fixture',
    base_url: delegateBase + '/v1',
    protocol: 'responses',
    api_key: 'fixture-native-key',
    supported_models: ['native-search'],
  })
  await gateway.saveRoute({
    model: 'web-search',
    upstream_id: account.id,
    upstream_model: 'native-search',
  })
  // Gateway API instance has production egress restrictions; use the local-only service test instance.
  const result = await new WebSearchService(gateway).run(
    await gateway.authenticate(token),
    { query: 'native fixture' },
    AbortSignal.timeout(5000),
  )
  expect(result.json.sources).toEqual([
    { url: 'https://example.org/source', title: 'Native source' },
  ])
  const rows = await db.db.execute(
    sql`select id,status,input_tokens,cache_read_tokens,request_context from gw_requests where key_id=${keyId} order by created_at`,
  )
  expect(rows.rows).toHaveLength(2)
  expect(rows.rows[0]!.status).toBe('upstream_error')
  expect(rows.rows[1]).toMatchObject({
    id: result.id,
    status: 'ok',
    request_context: { parent_request_id: rows.rows[0]!.id },
  })
  expect(Number(rows.rows[1]!.input_tokens)).toBe(12)
  expect(Number(rows.rows[1]!.cache_read_tokens)).toBe(4)
})

test('unconfigured extraction delegates to native fetch evidence with quota and URL restrictions', async()=>{
  const account=await gateway.saveUpstream({name:'delegated-fixture',base_url:delegateBase+'/v1',protocol:'anthropic',api_key:'fixture',supported_models:['native-search']})
  await gateway.saveRoute({model:'web-fetch',upstream_id:account.id,upstream_model:'native-search'})
  await db.db.execute(sql`update gw_keys set models='["web-search"]'::jsonb where id=${keyId}`)
  vi.spyOn(SearchSettingsService.prototype,'provider').mockResolvedValueOnce(null)
  const result=await executeServerTool(gateway,await gateway.authenticate(token),'web-search','web_fetch',{url:'https://example.org/source',allowed_domains:['example.org/source']},'parent-fixture',AbortSignal.timeout(5000))
  expect(result).toMatchObject({url:'https://example.org/source',text:'Verified document'})
  const rows=(await db.db.execute(sql`select status,request_context from gw_requests where key_id=${keyId} order by created_at`)).rows
  expect(rows).toHaveLength(2)
  expect(rows[1]?.status).toBe('ok')
  expect(rows[1]?.request_context).toHaveProperty('parent_request_id')
  const key = await gateway.authenticate(token)
  expect(key.models).toEqual(['web-search'])
  const payload = {model:'web-fetch',max_tokens:32,messages:[{role:'user',content:'fixture'}]}
  await expect(gateway.execute(key,payload,'anthropic',AbortSignal.timeout(5000))).rejects.toMatchObject({status:403,code:'model_forbidden'})
  await expect(gateway.execute(key,payload,'anthropic',AbortSignal.timeout(5000),{},
    {authorizationModel:'web-search',parentRequestId:'not-a-parent'})).rejects.toMatchObject({status:403,code:'model_not_allowed'})
})


test('direct search clamps Python integer limits and rejects malformed strings before outbound work', async () => {
  for (const [value,expected] of [[99,8],[-1,1],[null,5],[' 3 ',3]] as const) {
    const response = await request({query:'fixture',max_results:value})
    expect(response.statusCode,response.body).toBe(200)
    expect(observedLimit).toBe(expected)
  }
  const before = calls
  expect((await request({query:'fixture',max_results:'3.5'})).statusCode).toBe(400)
  expect(calls).toBe(before)
})

test('direct search never reports success or retries after a lost settlement', async () => {
  const finish = vi.spyOn(gateway.repo, 'finish').mockResolvedValueOnce([])
  try {
    await expect(new WebSearchService(gateway).run(await gateway.authenticate(token),
      {query:'fixture'}, AbortSignal.timeout(5000))).rejects.toMatchObject({
        code:'settlement_failed',status:500,requestId:expect.any(String),
      })
    expect(finish).toHaveBeenCalledTimes(1)
    expect(calls).toBe(1)
    const rows = await db.db.execute(sql`select status from gw_requests where key_id=${keyId}`)
    expect(rows.rows).toEqual([{status:'reserved'}])
  } finally { finish.mockRestore() }
})

test('automatic native search uses configured accounts without creating aliases and respects an explicit disabled alias', async () => {
  mode = 'fail'
  const rejected = await gateway.saveUpstream({name:'delegated-fixture-rejected',base_url:delegateBase+'/rejected/v1',
    protocol:'responses',api_key:'fixture',supported_models:['native-search'],priority:200})
  const account = await gateway.saveUpstream({name:'delegated-fixture',base_url:delegateBase+'/v1',
    protocol:'responses',api_key:'fixture',supported_models:['native-search']})
  const service = new WebSearchService(gateway)
  const key = await gateway.authenticate(token)
  const result = await service.run(key,{query:'automatic fixture'},AbortSignal.timeout(5000))
  expect(result.json.sources[0]?.url).toBe('https://example.org/source')
  const [row] = (await db.db.execute(sql`select model,execution,status from gw_requests where id=${result.id}`)).rows
  expect(row).toMatchObject({model:'web-search',status:'ok',execution:{route_id:null,upstream_id:account.id,upstream_model:'native-search'}})
  const failed = (await db.db.execute(sql`select status,http_status from gw_requests where key_id=${keyId} and execution->>'upstream_id'=${String(rejected.id)}`)).rows
  expect(failed).toEqual([{status:'upstream_error',http_status:401}])
  expect((await db.db.execute(sql`select id from gw_routes where model='web-search'`)).rows).toHaveLength(0)
  const stored = (await gateway.repo.upstreams()).find(row => row.id === account.id)!
  expect(capabilityCandidate({...stored,protocol:'openai',provider:'deepseek'},'web-search')?.upstream).toMatchObject({protocol:'anthropic',base_url:delegateBase+'/anthropic'})
  expect(capabilityCandidate({...stored,protocol:'openai',provider:'openai-compatible'},'web-search')).toBeUndefined()
  expect(capabilityCandidate({...stored,scope:'personal',owner_user_id:key.owner_id},'web-search')).toBeUndefined()
  await gateway.saveRoute({model:'web-search',upstream_id:account.id,upstream_model:'native-search',enabled:false})
  await expect(service.run(key,{query:'disabled fixture'},AbortSignal.timeout(5000))).rejects.toMatchObject({code:'search_auth_failed'})
  expect((await db.db.execute(sql`select id from gw_requests where key_id=${keyId} and upstream_protocol='responses'`)).rows).toHaveLength(2)
})
