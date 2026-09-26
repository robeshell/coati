import { beforeAll, afterAll, test, expect } from 'vitest'
import pg from 'pg'
import { createHash } from 'node:crypto'
import { TEST_DATABASE_URL } from './helpers'
import { runMigrations } from '../src/db/migrate'
import {
  legacyTables,
  type LegacyArchive,
} from '../src/modules/gateway/legacy-archive'
import {
  planLegacyImport,
  importLegacy,
} from '../src/modules/gateway/legacy-import'
import { CredentialVault } from '../src/modules/gateway/crypto'
const url = new URL(TEST_DATABASE_URL),
  name = `coati_legacy_import_${process.pid}_${Date.now()}`
const controlUrl = new URL(url)
controlUrl.pathname = '/postgres'
const control = new pg.Pool({ connectionString: controlUrl.href, max: 1 })
let target: pg.Pool
beforeAll(async () => {
  await control.query(`create database "${name}"`)
  url.pathname = '/' + name
  await runMigrations(url.href, () => {})
  target = new pg.Pool({ connectionString: url.href, max: 1 })
})
afterAll(async () => {
  await target?.end()
  await control.query(`drop database if exists "${name}"`)
  await control.end()
})
const fixture = (): LegacyArchive => {
  const tables = Object.fromEntries(
    legacyTables.map((name) => [name, []]),
  ) as LegacyArchive['tables']
  tables.admin_users = [
    {
      id: 1,
      username: 'fixture-user',
      password_hash: 'pbkdf2:sha256:1000$salt$abcd',
      created_at: '2026-01-01T00:00:00',
    },
  ]
  tables.roles = [{ id: 1, name: 'Administrator', code: 'super_admin' }]
  tables.user_roles = [{ user_id: 1, role_id: 1 }]
  tables.agent_llm_credential = [
    {
      id: 3,
      name: 'fixture-account',
      scope: 'platform',
      base_url: 'https://example.com/v1',
      upstream_protocol: 'openai-chat',
      api_key:
        'enc:v1:gAAAAABqtzxMArbRZcY-OcMQgyBVAXhZksUB6peZ0Z3jJUiLqH5f62ZjXOpiK5DNN2228FDaWqqKruWTIsQqj55bDyNT-oO5CcHLDSsIFfX0u7JFe0SrGiM=',
      models_json: '["fixture-model"]',
    },
  ]
  tables.agent_route_config = [
    {
      id: 4,
      model_name: 'fixture',
      credential_id: 3,
      upstream_model: 'fixture-model',
    },
  ]
  tables.agent_model_profile = [
    {
      id: 5,
      model_name: 'fixture-model',
      context_window: 128000,
      max_output_tokens: 8192,
    },
  ]
  tables.agent_pat = [
    {
      id: 6,
      user_id: 1,
      name: 'fixture-token',
      token_hash: createHash('sha256').update('fixture-token').digest('hex'),
      token_prefix: 'fixture',
      scopes_json: '["chat","profile"]',
    },
  ]
  tables.agent_user_quota = [{ user_id: 1, daily_token_quota: 100000 }]
  tables.agent_usage_event = [
    {
      id: 7,
      request_id: 'fixture-history',
      user_id: 1,
      pat_id: 6,
      model: 'fixture',
      inbound_protocol: 'openai-chat',
      prompt_tokens: 12,
      completion_tokens: 3,
      cache_read_tokens: 0,
      cache_write_tokens: null,
      status: 'ok',
      created_at: '2026-01-01T00:00:00',
    },
  ]
  tables.agent_cache_test = [
    {
      id: 8,
      user_id: 1,
      name: 'fixture-cache',
      model: 'fixture',
      prompt: 'fixture prompt',
      rounds: 1,
      max_tokens: 32,
      status: 'ok',
      summary_json: JSON.stringify({rounds_ok:1,rounds_total:1,overall_hit_ratio:0}),
      rounds_json: JSON.stringify([{round:1,status:'ok',credential_id:3,credential_name:'fixture-account',prompt_tokens:12,completion_tokens:3,cache_read_tokens:0,cache_write_tokens:null,cache_miss_tokens:12}]),
    },
  ]
  return {
    format: 'coati-python-v1',
    created_at: '2026-09-26T00:00:00Z',
    tables,
  }
}
test('fresh-database import validates with rollback, reencrypts, preserves IDs/usage, and is idempotent', async () => {
  const plan = planLegacyImport(
    fixture(),
    'fixture-legacy-key',
    'fixture-node-key',
  )
  expect((await importLegacy(target, plan)).applied).toBe(false)
  expect(
    (await target.query('select count(*) from admin_users')).rows[0].count,
  ).toBe('0')
  expect((await importLegacy(target, plan, true)).applied).toBe(true)
  const account = (await target.query('select * from gw_upstreams where id=3'))
    .rows[0]
  expect(new CredentialVault('fixture-node-key').decrypt(account.secret)).toBe(
    'fixture-upstream-secret',
  )
  const usage = (
    await target.query('select * from gw_requests where id=$1', [
      'fixture-history',
    ])
  ).rows[0]
  expect(usage.key_id).toBe(6)
  expect(Number(usage.input_tokens)).toBe(12)
  expect(Number(usage.cache_read_tokens)).toBe(0)
  expect(usage.cache_write_tokens).toBeNull()
  const cache = (await target.query('select summary,results from gw_cache_tests where id=8')).rows[0]
  expect(cache.summary).toMatchObject({completed_rounds:1,hit_ratio:0})
  expect(cache.results[0]).toMatchObject({upstream_name:'fixture-account',cache_read_tokens:0,cache_write_tokens:null,input_tokens:12})
  expect((await importLegacy(target, plan, true)).already_imported).toBe(true)
  const other = fixture()
  other.created_at = '2026-09-27T00:00:00Z'
  await expect(
    importLegacy(
      target,
      planLegacyImport(other, 'fixture-legacy-key', 'fixture-node-key'),
      true,
    ),
  ).rejects.toThrow('empty migrated')
  expect(
    (await target.query('select count(*) from gw_legacy_imports')).rows[0]
      .count,
  ).toBe('1')
})


test('ordinary legacy device roles retain separate page and action grants without PAT creation', () => {
  const archive = fixture()
  archive.tables.roles = [{id:1,name:'Device user',code:'device_user'}]
  archive.tables.menus = [
    {id:54,code:'agent_device_confirm'},
    {id:541,code:'agent_device_confirm_action'},
    {id:56,code:'agent_my_usage'},
    {id:511,code:'agent_llm_keys_test'},
  ]
  archive.tables.role_menus = [{role_id:1,menu_id:54},{role_id:1,menu_id:541},{role_id:1,menu_id:56},{role_id:1,menu_id:511}]
  const plan = planLegacyImport(archive,'fixture-legacy-key','fixture-node-key')
  const granted = plan.tables.role_menus!.map(grant => plan.tables.menus!.find(menu => menu.id===grant.menu_id)?.code)
  expect(granted).toEqual(['gateway_device_confirm','gateway_device_confirm_action','gateway_my_usage','gateway_upstreams_test'])
})
