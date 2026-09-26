import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const root=new URL('../',import.meta.url)
const routes=readFileSync(new URL('apps/api/src/router.ts',root),'utf8')
if(routes.includes('component-center'))throw new Error('Example routes must not be part of the gateway application')
for(const [command,args] of [
  ['pnpm',['--filter','@coati/api','exec','eslint','src/modules/gateway','src/db/schema/gateway']],
  ...(!process.argv.includes('--static') ? [['pnpm',['--filter','@coati/api','test','gateway','migration-chain','setup-once']]] : []),
]){
  const result=spawnSync(command,args,{cwd:root,stdio:'inherit'})
  if(result.status!==0)process.exit(result.status??1)
}
console.log(process.argv.includes('--static') ? 'Gateway static gate passed; runtime checks are separate.' : 'Gateway contract, migration and bootstrap checks passed. This does not certify legacy parity or production readiness.')
