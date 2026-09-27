/** Explicitly authorized local live acceptance. Credentials never leave process memory. */
import {writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {UsageMeter} from '../src/modules/gateway/stream'
import {normalizeUsage} from '../src/modules/gateway/usage'
import type {Protocol} from '../src/modules/gateway/schema'
import {sql} from 'drizzle-orm'
import {loadConfig,loadEnvFiles} from '../src/config'
import {createDb} from '../src/db/client'
import {GatewayService,gatewayOptions} from '../src/modules/gateway/service'
loadEnvFiles('development')
const config=loadConfig(), address=new URL(config.databaseUrl)
if(!['localhost','127.0.0.1'].includes(address.hostname)||address.pathname!='/coati_node_dev')throw Error('Local dev only')
if(process.env.COATI_LIVE_ACCEPTANCE!=='authorized')throw Error('Explicit authorization required')
const handle=createDb(config.databaseUrl), gateway=new GatewayService(handle.db,gatewayOptions(config))
const run=Date.now(),dir=`/tmp/coati-acceptance-${run}`
const {mkdirSync}=await import('node:fs');mkdirSync(dir,{mode:0o700})
const routes:any[]=[],keys:any[]=[],results:any[]=[],samples:any[]=[]
const cleanupErrors:string[]=[]
let stage='preflight',stop=false,started=0,fatal:string|undefined
process.on('SIGTERM',()=>{stop=true});process.on('SIGINT',()=>{stop=true})
const save=()=>writeFileSync(`${dir}/report.json`,JSON.stringify({run,stage,started,updated:Date.now(),pid:process.pid,results,samples,fatal,cleanup_errors:cleanupErrors,route_ids:routes.map(r=>r.id),key_ids:keys.map(k=>k.id)},null,2),{mode:0o600})
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function key(models:string[],limit=2000000){const k=await gateway.createKey(1,{name:`长时验收 ${run}`,models,daily_limit:limit,expires_days:1,rpm_limit:120,concurrency_limit:2});keys.push(k);save();return k}
async function call(k:any,model:string,protocol:string,stream:boolean,prompt:string,extra:any={},category='text'){
 const endpoint=protocol==='openai'?'chat/completions':protocol==='responses'?'responses':'messages'
 const body=protocol==='responses'?{model,input:prompt,max_output_tokens:128,stream,...extra}:{model,messages:[{role:'user',content:prompt}],max_tokens:128,stream,...(protocol==='openai'&&stream?{stream_options:{include_usage:true}}:{}),...extra}
 const before=Date.now()
 try{
 const response=await fetch(`http://localhost:5004/v1/${endpoint}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${k.token}`,'x-coati-reasoning-policy':'text-only'},body:JSON.stringify(body),signal:AbortSignal.timeout(65000)})
 const text=await response.text();let json:any
 const events=stream?text.split('\n').filter(l=>l.startsWith('data: ')&&l!=='data: [DONE]').flatMap(l=>{try{return[JSON.parse(l.slice(6))]}catch{return[]}}):[]
 if(!stream||!response.ok){try{json=JSON.parse(text)}catch{}}
 const failure=events.find(e=>e.type==='error'||e.error||e.type==='response.failed'||e.type==='response.incomplete')
 const terminal=!stream||(protocol==='openai'?text.includes('data: [DONE]'):events.some(e=>e.type===(protocol==='responses'?'response.completed':'message_stop')))
 const content=stream?events.map(e=>e.choices?.[0]?.delta?.content||e.delta?.text||(e.type==='response.output_text.delta'?e.delta:'')||'').join(''):json?.choices?.[0]?.message?.content||json?.content?.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('')||json?.output?.flatMap((i:any)=>i.content||[]).map((c:any)=>c.text||'').join('')||''
 const meter=new UsageMeter(); for(const event of stream?events:[json])if(event&&response.ok&&!failure)meter.observe(event,protocol as Protocol)
 const item={usage:normalizeUsage(meter.rawUsage,protocol as Protocol),category,model,protocol,stream,http:response.status,ok:response.ok&&!failure&&terminal&&content.length>0&&(category!=='image'||/red|红/i.test(content)),ms:Date.now()-before,id:response.headers.get('x-request-id'),chars:content.length,terminal,error:json?.error?.code||failure?.error?.code||failure?.type,tools:category==='tools'?text.includes('web_search_tool_result'):undefined}
 results.push(item);save();return item
 }catch(error){const item={category,model,protocol,stream,ok:false,ms:Date.now()-before,error:error instanceof Error?error.name:'unknown'};results.push(item);save();return item}
}
try{
 const accounts=(await gateway.repo.upstreams()).filter(a=>a.enabled&&['DeepSeek','deepseek anth','deepseek response'].includes(a.name))
 if(accounts.length!==3)throw Error('Expected three verified DeepSeek protocol accounts')
 for(const a of accounts){routes.push(await gateway.savePublicRoute({model:`live-${run}-${a.protocol}`,upstream_id:a.id,upstream_model:'deepseek-flash',enabled:true,fallback_enabled:false}));save()}
 const k=await key(routes.map(r=>r.model))
 stage='matrix';save()
 for(const route of routes)for(const protocol of ['openai','responses','anthropic'])for(const stream of [false,true]){
  if(stop)throw Error('Stopped')
  const result=await call(k,route.model,protocol,stream,'Reply with exactly OK.')
  if(!result.ok)throw Error('Basic matrix failed; soak not started')
 }
 stage='tools';save()
 const route=routes.find(r=>r.model.endsWith('-openai'))!
 for(const protocol of ['openai','responses','anthropic'])for(const stream of [false,true]){
  const tools=protocol==='anthropic'?[{type:'web_search_20250305',name:'web_search',max_uses:1}]:[{type:'web_search',max_uses:1}]
  await call(k,route.model,protocol,stream,'Use web_search once to find the official TypeScript narrowing documentation. Give the source URL and one short sentence.',{tools,...(protocol==='responses'?{max_output_tokens:1024}:{max_tokens:1024})},'tools')
 }
 stage='image';save()
 const vision=(await gateway.repo.upstreams()).find(a=>a.enabled&&a.name==='千问OpenAI'&&a.supported_models.includes('qwen3.8-flash'))
 if(vision){
  const vr=await gateway.savePublicRoute({model:`live-${run}-vision`,upstream_id:vision.id,upstream_model:'qwen3.8-flash',enabled:true,fallback_enabled:false});routes.push(vr);const vk=await key([vr.model]);save()
  const url='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC'
  for(const protocol of ['openai','responses','anthropic'])for(const stream of [false,true]){
   const content=protocol==='openai'?[{type:'text',text:'What single color fills this image? Reply with one word.'},{type:'image_url',image_url:{url}}]:protocol==='responses'?[{type:'input_text',text:'What single color fills this image? Reply with one word.'},{type:'input_image',image_url:url}]:[{type:'text',text:'What single color fills this image? Reply with one word.'},{type:'image',source:{type:'base64',media_type:'image/png',data:url.split(',')[1]}}]
   await call(vk,vr.model,protocol,stream,'',protocol==='responses'?{input:[{role:'user',content}]}:{messages:[{role:'user',content}]},'image')
  }
 }
 stage='access';save()
 const limited=await key([route.model],1)
 const denied=await call(limited,route.model,'openai',false,'Reply OK',{},'quota-denial')
 if(!('http' in denied)||denied.http!==429)throw Error('Quota denial did not return 429')
 stage='soak';started=Date.now();save()
 const prefix=Array.from({length:100},(_,i)=>`Reference rule ${i+1}: Gateway operations must preserve request identity, bounded streams, accurate token accounting, cancellation and source attribution.`).join('\n')
 let failed=0,batch=0
 while(!stop&&Date.now()-started<30*60*1000){
  const begin=Date.now()
  const batchResults=await Promise.all([0,1].map(i=>call(k,route.model,['openai','responses','anthropic'][(batch*2+i)%3]!,Boolean((batch+i)%2),prefix+'\nReply with exactly OK.',{},'soak')))
  for(const result of batchResults){
   if(!result.ok)continue
   if(!('id' in result)||!result.id||!('usage' in result))throw Error('Missing wire request identity/usage')
   const row=(await handle.db.execute(sql`select input_tokens,output_tokens,cache_read_tokens,status from gw_requests where id=${result.id}`)).rows[0]
   if(!row||row.status!=='ok'||Number(row.input_tokens)!==result.usage.input||Number(row.output_tokens)!==result.usage.output||(result.usage.cache_read_tokens!==null&&Number(row.cache_read_tokens)!==result.usage.cache_read_tokens))throw Error('Wire/ledger mismatch')
  }
  failed=batchResults.some(r=>!r.ok)?failed+1:0
  const rows=(await handle.db.execute(sql`select count(*)::int as requests,count(*) filter(where status='reserved')::int as active,sum(input_tokens)::bigint as input,sum(output_tokens)::bigint as output,sum(cache_read_tokens)::bigint as cache from gw_requests where key_id=${k.id}`)).rows
  let rss='unavailable';try{const pid=execFileSync('lsof',['-tiTCP:5004','-sTCP:LISTEN'],{encoding:'utf8'}).trim().split('\n')[0]!;rss=execFileSync('ps',['-p',pid,'-o','rss='],{encoding:'utf8'}).trim()}catch{}
  samples.push({time:Date.now(),rss_kb:rss,...rows[0]});batch++;save()
  console.log(JSON.stringify({dir,stage,elapsed_s:Math.round((Date.now()-started)/1000),batch,ok:batchResults.every(r=>r.ok)}))
  if(failed>=3)throw Error('Three consecutive failed batches; stopped')
  if(Number(rows[0]?.active)>0)throw Error('Unsettled requests after batch')
  await delay(Math.max(0,20000-(Date.now()-begin)))
 }
 stage=stop?'stopped':'complete'
}catch(error){fatal=error instanceof Error?error.message:'unknown';stage='failed'}
finally{
 for(const k of keys)try{await gateway.repo.revoke(k.id,1)}catch{cleanupErrors.push(`key:${k.id}`)}
 for(const r of routes)try{await gateway.savePublicRoute({enabled:false},r.id);await gateway.repo.deletePublicRoute(r.id)}catch{cleanupErrors.push(`route:${r.id}`)}
 const ledger=keys.length?(await handle.db.execute(sql`select id,key_id,status,protocol,input_tokens,output_tokens,cache_read_tokens,usage_source,error,request_context,raw_usage from gw_requests where key_id in (${sql.join(keys.map(k=>sql`${k.id}`),sql`,`)}) order by created_at`)).rows:[]
 writeFileSync(`${dir}/ledger.json`,JSON.stringify(ledger,null,2),{mode:0o600});save()
 console.log(JSON.stringify({dir,stage,fatal,cleaned:cleanupErrors.length===0,calls:results.length}))
 await gateway.transport.close();await handle.pool.end()
}
