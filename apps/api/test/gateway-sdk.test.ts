import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import Fastify, {type FastifyInstance} from 'fastify'
import {beforeAll,afterAll,test,expect,vi} from 'vitest'
import {sql} from 'drizzle-orm'
import {openTestDb,buildTestApp,superAdminSession,cleanupFixture} from './helpers'
import {GatewayService,gatewayOptions} from '../src/modules/gateway/service'
const db=openTestDb()
let app:FastifyInstance,upstream:FastifyInstance,gateway:GatewayService,openai:OpenAI,anthropic:Anthropic
beforeAll(async()=>{
  upstream=Fastify()
  upstream.post('/v1/chat/completions',async(request,reply)=>{
    const body=request.body as {stream?:boolean}
    const usage={prompt_tokens:12,completion_tokens:1,prompt_tokens_details:{cached_tokens:4}}
    if(body.stream) {
      reply.type('text/event-stream')
      return [
        {id:'sdk-fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'Hello'},finish_reason:null}]},
        {id:'sdk-fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}],usage},
      ].map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join('')+'data: [DONE]\n\n'
    }
    return {id:'sdk-fixture',object:'chat.completion',model:'fixture',choices:[{index:0,message:{role:'assistant',content:'Hello'},finish_reason:'stop'}],usage}
  })
  const base=await upstream.listen({host:'127.0.0.1',port:0})
  vi.stubEnv('GATEWAY_ALLOW_PRIVATE_UPSTREAMS','true')
  app=await buildTestApp()
  const admin=await superAdminSession(app,db)
  gateway=new GatewayService(db.db,{...gatewayOptions(app.config),allowPrivate:true})
  const account=await gateway.saveUpstream({name:'sdk-fixture',protocol:'openai',base_url:base+'/v1',api_key:'fixture',supported_models:['fixture']})
  await gateway.saveRoute({model:'sdk-fixture',upstream_id:account.id,upstream_model:'fixture'})
  const key=await gateway.createKey(admin.userId,{name:'sdk-fixture',models:['sdk-fixture']})
  const url=await app.listen({host:'127.0.0.1',port:0})
  openai=new OpenAI({baseURL:url+'/v1',apiKey:key.token,maxRetries:0})
  anthropic=new Anthropic({baseURL:url,apiKey:key.token,authToken:null,maxRetries:0})
})
afterAll(async()=>{
  vi.unstubAllEnvs()
  await app?.close();await gateway?.transport.close();await upstream?.close()
  await db.db.execute(sql`delete from gw_attempts where request_id in(select id from gw_requests where key_id in(select id from gw_keys where name='sdk-fixture'))`)
  await db.db.execute(sql`delete from gw_requests where key_id in(select id from gw_keys where name='sdk-fixture')`)
  await db.db.execute(sql`delete from gw_keys where name='sdk-fixture'`)
  await db.db.execute(sql`delete from gw_routes where model='sdk-fixture'`)
  await db.db.execute(sql`delete from gw_upstreams where name='sdk-fixture'`)
  await cleanupFixture(db);await db.pool.end()
})
test('official SDKs consume all three JSON/SSE entrypoints through a real gateway socket',async()=>{
  const chat=await openai.chat.completions.create({model:'sdk-fixture',messages:[{role:'user',content:'Hello'}]})
  expect(chat.choices[0]?.message.content).toBe('Hello')
  const response=await openai.responses.create({model:'sdk-fixture',input:'Hello',store:false})
  expect(response.output_text).toBe('Hello')
  const message=await anthropic.messages.create({model:'sdk-fixture',messages:[{role:'user',content:'Hello'}],max_tokens:10})
  expect(message.content[0]).toMatchObject({type:'text',text:'Hello'})
  let chatText=''
  for await(const event of await openai.chat.completions.create({model:'sdk-fixture',messages:[{role:'user',content:'Hello'}],stream:true}))chatText+=event.choices[0]?.delta.content??''
  expect(chatText).toBe('Hello')
  let responseText=''
  for await(const event of await openai.responses.create({model:'sdk-fixture',input:'Hello',store:false,stream:true}))if(event.type==='response.output_text.delta')responseText+=event.delta
  expect(responseText).toBe('Hello')
  let messageText=''
  for await(const event of await anthropic.messages.create({model:'sdk-fixture',messages:[{role:'user',content:'Hello'}],max_tokens:10,stream:true}))if(event.type==='content_block_delta'&&event.delta.type==='text_delta')messageText+=event.delta.text
  expect(messageText).toBe('Hello')
})
