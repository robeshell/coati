import Fastify,{type FastifyInstance} from 'fastify'
import {beforeAll,afterAll,beforeEach,test,expect} from 'vitest'
import {sql} from 'drizzle-orm'
import {buildTestApp,openTestDb,superAdminSession,createFixture,cleanupFixture,loginSession,FIXTURE_USER,FIXTURE_PASSWORD,type AuthedSession} from './helpers'
import {GatewayService,gatewayOptions} from '../src/modules/gateway/service'
import {SearchSettingsService} from '../src/modules/gateway/search-settings'
const db=openTestDb()
let app:FastifyInstance,mock:FastifyInstance,admin:AuthedSession,ordinary:AuthedSession,gateway:GatewayService,settings:SearchSettingsService
let calls=0
beforeAll(async()=>{
  mock=Fastify()
  mock.post('/search',async request=>{calls++;expect(request.headers.authorization).toBe('Bearer env-fixture-key');return {results:[{url:'https://example.com',title:'Fixture'}]}})
  const baseUrl=await mock.listen({host:'127.0.0.1',port:0})
  app=await buildTestApp();const actor=await createFixture(db);admin=await superAdminSession(app,db);ordinary=await loginSession(app,FIXTURE_USER,FIXTURE_PASSWORD,actor.userId)
  gateway=new GatewayService(db.db,{...gatewayOptions(app.config),allowPrivate:true})
  settings=new SearchSettingsService(gateway,{AGENT_WEBSEARCH_PROVIDER:'tavily',AGENT_WEBSEARCH_API_KEY:'env-fixture-key'},baseUrl)
})
beforeEach(async()=>{calls=0;await db.db.execute(sql`delete from gw_search_settings`)})
afterAll(async()=>{await app.close();await gateway.transport.close();await mock.close();await db.db.execute(sql`delete from gw_search_settings`);await cleanupFixture(db);await db.pool.end()})
test('encrypted overrides preserve blank secrets, clear suppresses env fallback, reset restores it; checks use saved state only',async()=>{
  expect(await settings.view()).toMatchObject({configured:true,has_api_key:true,source:{api_key:'environment'}})
  await settings.save({provider:'tavily',api_key:'saved-fixture-key',proxy_url:'https://user:fixture-password@proxy.example',timeout_seconds:20})
  const stored=await settings.repo.read()
  expect(stored.api_key).toMatch(/^v2\./);expect(stored.proxy_url).toMatch(/^v2\./)
  expect(JSON.stringify(await settings.view())).not.toMatch(/saved-fixture-key|fixture-password|v2\./)
  await settings.save({provider:'tavily',api_key:'',proxy_url:'',timeout_seconds:15})
  expect((await settings.repo.read()).api_key).toBe(stored.api_key)
  expect(calls).toBe(0)
  await settings.save({provider:'tavily',clear_api_key:true,clear_proxy:true,timeout_seconds:15})
  expect(await settings.view()).toMatchObject({configured:false,has_api_key:false,has_proxy:false})
  await expect(settings.test(AbortSignal.timeout(3000))).rejects.toMatchObject({status:400})
  expect(calls).toBe(0)
  await settings.reset()
  expect(await settings.test(AbortSignal.timeout(3000))).toMatchObject({ok:true,result_count:1,sample:['https://example.com/']})
  expect(calls).toBe(1)
  await settings.save({provider:'',timeout_seconds:15})
  expect(await settings.provider()).toBeNull()
})
test('admin and legacy endpoints enforce permissions and never return credentials',async()=>{
  const path='/api/admin/gateway/web-search'
  expect((await ordinary.inject({url:path})).statusCode).toBe(403)
  expect((await ordinary.inject({method:'PUT',url:path,payload:{provider:'tavily'}})).statusCode).toBe(403)
  expect((await ordinary.inject({method:'POST',url:path+'/test',payload:{}})).statusCode).toBe(403)
  const saved=await admin.inject({method:'PUT',url:path,payload:{provider:'tavily',api_key:'api-fixture-secret',timeout_seconds:15}})
  expect(saved.statusCode).toBe(200);expect(saved.body).not.toContain('api-fixture-secret')
  expect((await admin.inject({url:'/api/admin/agent/web-search'})).json()).toMatchObject({has_api_key:true,configured:true})
  expect((await admin.inject({method:'PUT',url:path,payload:{provider:'tavily',api_key:'x',clear_api_key:true}})).statusCode).toBe(400)
  expect((await admin.inject({method:'DELETE',url:path})).statusCode).toBe(200)
  expect(calls).toBe(0)
})
