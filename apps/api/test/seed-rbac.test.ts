/**
 * scripts/seed-rbac.ts: full rebuild and incremental sync of menus, the super admin role and the admin account
 *
 * - Full/incremental modes are verified on a separate temporary database (coati_seed_*), leaving the shared test DB's RBAC data untouched
 * - Incremental mode is additionally run twice in a row on TEST_DATABASE_URL (a clone of the live DB) to confirm it is idempotent and doesn't change existing IDs
 */

import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MENUS_DATA, seedRbac } from '../scripts/seed-rbac'
import { checkPasswordHash } from '../src/common/password'
import { runMigrations } from '../src/db/migrate'
import { TEST_DATABASE_URL } from './helpers'

const TEMP_DB = 'coati_seed_rbac'
const quiet = () => {}

function urlForDatabase(name: string): string {
  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}
const TEMP_URL = urlForDatabase(TEMP_DB)

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: urlForDatabase('postgres') })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

async function query<T extends pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<T>(sql, params)).rows
  } finally {
    await client.end()
  }
}

/** Snapshot of all RBAC tables except password_hash / created_at (includes menus.updated_at, used to detect whether any write happened) */
async function snapshot(url: string) {
  const [menus, roles, roleMenus, userRoles, users, seq] = await Promise.all([
    query(url, 'SELECT id, name, code, icon, path, component, parent_id, sort_order, is_visible, is_active, menu_type, description, updated_at::text FROM menus ORDER BY id'),
    query(url, 'SELECT id, name, code, description FROM roles ORDER BY id'),
    query(url, 'SELECT role_id, menu_id FROM role_menus ORDER BY 1, 2'),
    query(url, 'SELECT user_id, role_id FROM user_roles ORDER BY 1, 2'),
    query(url, 'SELECT id, username FROM admin_users ORDER BY id'),
    query(url, "SELECT last_value::int AS last_value, is_called FROM menus_id_seq"),
  ])
  return { menus, roles, roleMenus, userRoles, users, seq: seq[0] }
}

beforeAll(async () => {
  await admin(`DROP DATABASE IF EXISTS ${TEMP_DB} WITH (FORCE)`)
  await admin(`CREATE DATABASE ${TEMP_DB}`)
  await runMigrations(TEMP_URL, quiet)
})

afterAll(async () => {
  await admin(`DROP DATABASE IF EXISTS ${TEMP_DB} WITH (FORCE)`)
})

// Menu count / max ID are derived from MENUS_DATA: they change with every new feature module menu, so the test only checks the sync logic itself
const MENU_COUNT = MENUS_DATA.length
const NEXT_MENU_ID = Math.max(...MENUS_DATA.map((m) => m.id)) + 1
/** Sanity floor for the retained system and gateway permissions. */
const LEGACY_MENU_COUNT = 40

describe('MENUS_DATA', () => {
  it('包含网关与系统菜单；ID/编码唯一、父节点先于子节点、历史 ID 不变', () => {
    expect(MENU_COUNT).toBeGreaterThanOrEqual(LEGACY_MENU_COUNT)
    const ids = MENUS_DATA.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(MENUS_DATA.map((m) => m.code)).size).toBe(ids.length)
    // Legacy IDs must not change
    for (const [id, code] of [
      [32, 'system_scheduled_tasks'],
      [100002, 'system_notifications'],
      [100003, 'system_announcements'],
      [1000, 'gateway_overview'],
      [1003, 'gateway_keys'],
    ] as const) {
      expect(MENUS_DATA.find((m) => m.id === id)?.code).toBe(code)
    }
    const seen = new Set<number>()
    for (const menu of MENUS_DATA) {
      if (menu.parent_id !== null) expect(seen.has(menu.parent_id)).toBe(true)
      seen.add(menu.id)
      expect(menu.is_visible).toBe(menu.menu_type === 'menu')
    }
  })
})

describe('全量重建（空库）', () => {
  it('写入全部菜单 + super_admin + admin，序列状态正确', async () => {
    const output:string[]=[]
    const result = await seedRbac({ databaseUrl: TEMP_URL, adminPassword: 'ck_test_r8_pw', log:line=>output.push(line) })
    expect(output.join('\n')).not.toContain('ck_test_r8_pw')
    expect(result).toEqual({ menusAdded: MENU_COUNT, menusUpdated: 0, superAdminMenuCount: MENU_COUNT, adminCreated: true })

    const snap = await snapshot(TEMP_URL)
    expect(snap.menus.map((m) => m.id)).toEqual(MENUS_DATA.map((m) => m.id).sort((a, b) => a - b))
    const byId = new Map(snap.menus.map((m) => [m.id as number, m]))
    for (const menu of MENUS_DATA) {
      const row = byId.get(menu.id)!
      for (const key of ['name', 'code', 'icon', 'path', 'component', 'parent_id', 'sort_order', 'menu_type', 'is_visible', 'is_active'] as const) {
        expect(row[key], `${menu.code}.${key}`).toEqual(menu[key])
      }
      expect(row.description).toBeNull()
    }
    // menus_id_seq = max(id)+1 with is_called=false; roles / admin_users each consumed the sequence once
    expect(snap.seq).toEqual({ last_value: NEXT_MENU_ID, is_called: false })
    expect(snap.roles).toEqual([{ id: 1, name: '超级管理员', code: 'super_admin', description: '拥有所有权限的超级管理员' }])
    expect(snap.users).toEqual([{ id: 1, username: 'admin' }])
    expect(snap.userRoles).toEqual([{ user_id: 1, role_id: 1 }])
    expect(snap.roleMenus).toHaveLength(MENU_COUNT)

    const [user] = await query<{ password_hash: string }>(TEMP_URL, "SELECT password_hash FROM admin_users WHERE username = 'admin'")
    expect(user!.password_hash).toMatch(/^pbkdf2:sha256:1000000\$[A-Za-z0-9]{16}\$[0-9a-f]{64}$/)
    expect(await checkPasswordHash(user!.password_hash, 'ck_test_r8_pw')).toBe(true)
  })

  it('再次全量：清空后重建（自定义角色与用户被删除，角色/用户走新序列号）', async () => {
    await query(TEMP_URL, "INSERT INTO roles (name, code, created_at) VALUES ('临时', 'ck_test_r8_role', now())")
    await query(TEMP_URL, "INSERT INTO admin_users (username, password_hash, created_at) VALUES ('ck_test_r8_user', 'x', now())")
    await seedRbac({ databaseUrl: TEMP_URL, adminPassword: 'ck_test_r8_pw', log: quiet })
    const snap = await snapshot(TEMP_URL)
    expect(snap.roles.map((r) => r.code)).toEqual(['super_admin'])
    expect(snap.users.map((u) => u.username)).toEqual(['admin'])
    expect(snap.roles[0]!.id).toBe(3)
    expect(snap.users[0]!.id).toBe(3)
    expect(snap.menus).toHaveLength(MENU_COUNT)
    expect(snap.seq).toEqual({ last_value: NEXT_MENU_ID, is_called: false })
  })
})

describe('增量同步', () => {
  it('无变化时连跑两次：不发 UPDATE（updated_at 不变），结果完全一致', async () => {
    const before = await snapshot(TEMP_URL)
    const first = await seedRbac({ databaseUrl: TEMP_URL, adminPassword: 'other', incremental: true, log: quiet })
    const second = await seedRbac({ databaseUrl: TEMP_URL, adminPassword: 'other', incremental: true, log: quiet })
    expect(first).toEqual({ menusAdded: 0, menusUpdated: MENU_COUNT, superAdminMenuCount: MENU_COUNT, adminCreated: false })
    expect(second).toEqual(first)
    expect(await snapshot(TEMP_URL)).toEqual(before)
  })

  it('按 code 更新且保留 ID，固定 ID 冲突时分配新 ID，保留自定义角色和菜单', async () => {
    await query(TEMP_URL, `
      UPDATE menus SET name='旧名',sort_order=42 WHERE code='system_users';
      DELETE FROM menus WHERE code='gateway_routes_delete';
      INSERT INTO menus (id,name,code,sort_order,menu_type,is_visible,is_active,created_at,updated_at)
        VALUES (10023,'占位','ck_test_r8_occupier',1,'menu',true,true,now(),now());
      INSERT INTO roles(name,code,created_at) VALUES ('自定义','ck_test_r8_custom',now());
    `)
    const result=await seedRbac({databaseUrl:TEMP_URL,adminPassword:'other',incremental:true,log:quiet})
    expect(result.menusAdded).toBe(1)
    const rows=await query(TEMP_URL,'SELECT id,code,name,sort_order FROM menus')
    expect(rows.find(r=>r.code==='system_users')).toMatchObject({id:21,name:'用户管理',sort_order:1})
    expect(rows.find(r=>r.code==='gateway_routes_delete')?.id).toBe(NEXT_MENU_ID)
    expect(rows.find(r=>r.code==='ck_test_r8_occupier')?.id).toBe(10023)
    expect(await query(TEMP_URL,"SELECT id FROM roles WHERE code='ck_test_r8_custom'")).toHaveLength(1)
    const after=await snapshot(TEMP_URL)
    await seedRbac({databaseUrl:TEMP_URL,adminPassword:'other',incremental:true,log:quiet})
    expect(await snapshot(TEMP_URL)).toEqual(after)
  })

  it('测试库（现库克隆）上连跑两次：已有菜单 ID 不变，第二次零写入', async () => {
    const before = await query<{ id: number; code: string }>(TEST_DATABASE_URL, 'SELECT id, code FROM menus ORDER BY id')
    await seedRbac({ databaseUrl: TEST_DATABASE_URL, adminPassword: 'admin123', incremental: true, log: quiet })
    const afterFirst = await snapshot(TEST_DATABASE_URL)
    const idByCode = new Map(afterFirst.menus.map((m) => [m.code as string, m.id as number]))
    for (const { id, code } of before) expect(idByCode.get(code)).toBe(id)
    for (const menu of MENUS_DATA) expect(idByCode.has(menu.code)).toBe(true)

    await seedRbac({ databaseUrl: TEST_DATABASE_URL, adminPassword: 'admin123', incremental: true, log: quiet })
    expect(await snapshot(TEST_DATABASE_URL)).toEqual(afterFirst)
  })
})
