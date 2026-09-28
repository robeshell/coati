import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const root=new URL('../',import.meta.url)
const menus=readFileSync(new URL('apps/api/scripts/seed-rbac.ts',root),'utf8')
if(!/id: 3,.*code: \"component_center\".*is_active: false/.test(menus))throw new Error('Example center must remain disabled in the gateway menu')
for(const [command,args] of [
  ['pnpm',['--filter','@coati/api','exec','eslint','src/modules/gateway','src/db/schema/gateway']],
  ...(!process.argv.includes('--static') ? [['pnpm',['--filter','@coati/api','test','gateway','migration-chain','setup-once']]] : []),
]){
  const result=spawnSync(command,args,{cwd:root,stdio:'inherit'})
  if(result.status!==0)process.exit(result.status??1)
}
console.log(process.argv.includes('--static') ? 'Gateway static gate passed; runtime checks are separate.' : 'Gateway contract, database schema and bootstrap checks passed. This does not certify production readiness.')
