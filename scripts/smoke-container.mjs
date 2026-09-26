// Isolated image installation/restart/backup smoke. Never mounts a working or production database.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
const image = process.argv[2]
if (!image) throw new Error('Usage: node scripts/smoke-container.mjs <built-image>')
const prefix = `coati-smoke-${randomBytes(6).toString('hex')}`
const db = `${prefix}-db`, app = `${prefix}-app`
const password = randomBytes(24).toString('hex')
const command = (...args) => {
  const result = spawnSync('docker', args, {encoding:'utf8',maxBuffer:4*1024*1024})
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed (diagnostic omitted to protect runtime secrets)`)
  return result.stdout.trim()
}
async function ready(name, check) {
  for(let attempt=0;attempt<60;attempt++) {
    try { if(check())return } catch {}
    await new Promise(resolve=>setTimeout(resolve,1000))
  }
  throw new Error(`${name} readiness deadline exceeded`)
}
try {
  command('network','create',prefix)
  command('run','-d','--name',db,'--network',prefix,'--network-alias','database',
    '-e','POSTGRES_USER=coati','-e','POSTGRES_DB=coati', '-e',`POSTGRES_PASSWORD=${password}`,'postgres:17-alpine')
  await ready('database',()=>command('exec',db,'pg_isready','-U','coati','-d','coati').includes('accepting connections'))
  command('run','-d','--name',app,'--network',prefix,
    '-e',`DATABASE_URL=postgresql://coati:${password}@database/coati`,
    '-e',`SECRET_KEY=${randomBytes(32).toString('hex')}`,
    '-e',`GATEWAY_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
    '-e',`ADMIN_PASSWORD=${randomBytes(24).toString('hex')}`,image)
  const healthy=()=>JSON.parse(command('exec',app,'curl','-fsS','http://localhost:5000/health')).status==='healthy'
  await ready('application',healthy)
  const sql = query => command('exec',db,'psql','-U','coati','-d','coati','-Atc',query)
  const before = sql('select count(*) from drizzle.__drizzle_migrations')
  if(Number(before)<38)throw new Error('Missing gateway migrations')
  if(sql("select count(*) from admin_users where username='admin'")!=='1')throw new Error('Bootstrap administrator missing')
  if(!command('exec',app,'curl','-fsS','http://localhost:5000/').includes('<!doctype html>'))throw new Error('Console asset missing')
  command('exec',db,'pg_dump','-U','coati','-d','coati','-Fc','-f','/tmp/coati-smoke.dump')
  command('exec',db,'createdb','-U','coati','coati_restore')
  command('exec',db,'pg_restore','-U','coati','-d','coati_restore','--exit-on-error','/tmp/coati-smoke.dump')
  const restored = command('exec',db,'psql','-U','coati','-d','coati_restore','-Atc','select count(*) from drizzle.__drizzle_migrations')
  if(restored!==before)throw new Error('Restored migration history mismatch')
  command('restart',app)
  await ready('restarted application',healthy)
  if(sql('select count(*) from drizzle.__drizzle_migrations')!==before)throw new Error('Restart changed migration count')
  console.log(`Container installation, console, health, backup/restore and idempotent restart passed (${before} migrations). No model calls.`)
} finally {
  for(const name of [app,db])spawnSync('docker',['rm','-fv',name],{stdio:'ignore'})
  spawnSync('docker',['network','rm',prefix],{stdio:'ignore'})
}
