/** Isolated empty-database bootstrap: concurrent initialization, advisory locking and idempotence. */

import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADVISORY_LOCK_KEY, runSetupOnce } from '../scripts/setup-once'
import { MENUS_DATA } from '../scripts/seed-rbac'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { TEST_DATABASE_URL } from './helpers'

const EMPTY_DB = 'coati_seed_setup'
const quiet = () => {}

function urlForDatabase(name: string): string {
  const url = new URL(TEST_DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
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

const adminSql = (sql: string) => query(urlForDatabase('postgres'), sql)

async function rbacSnapshot(url: string) {
  return {
    menus: await query(url, 'SELECT id, code, name, parent_id, sort_order, updated_at::text FROM menus ORDER BY id'),
    roles: await query(url, 'SELECT id, code FROM roles ORDER BY id'),
    roleMenus: await query(url, 'SELECT role_id, menu_id FROM role_menus ORDER BY 1, 2'),
    users: await query(url, 'SELECT id, username, password_hash FROM admin_users ORDER BY id'),
    userRoles: await query(url, 'SELECT user_id, role_id FROM user_roles ORDER BY 1, 2'),
    migrations: await query(url, 'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id'),
  }
}

beforeAll(async () => {
  for (const db of [EMPTY_DB]) {
    await adminSql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
    await adminSql(`CREATE DATABASE ${db}`)
  }
})

afterAll(async () => {
  for (const db of [EMPTY_DB]) await adminSql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
})

const DRIZZLE_DIR = resolve(__dirname, '../drizzle')
/** Current number of migrations in the repo (grows as features are added) */
const MIGRATION_COUNT = (JSON.parse(readFileSync(join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')) as { entries: unknown[] }).entries.length

describe('setup-once', () => {
  const url = urlForDatabase(EMPTY_DB)

  it('空库：两个实例并发执行，advisory lock 串行化，结果与单次执行一致', async () => {
    const events: string[] = []
    const logger = (tag: string) => (msg: string) => {
      if (msg.startsWith('[setup]')) events.push(`${tag} ${msg}`)
    }
    // Hold the lock first, and confirm both instances are waiting on it and neither has started migrating
    const holder = new pg.Client({ connectionString: url })
    await holder.connect()
    await holder.query(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`)
    const runs = Promise.all([
      runSetupOnce({ databaseUrl: url, adminPassword: 'ck_test_r8_pw', log: logger('A') }),
      runSetupOnce({ databaseUrl: url, adminPassword: 'ck_test_r8_pw', log: logger('B') }),
    ])
    await new Promise((r) => setTimeout(r, 300))
    expect(events).toEqual([])
    const waiting = await query<{ n: number }>(
      url,
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${ADVISORY_LOCK_KEY} AND NOT granted`,
    )
    expect(waiting[0]!.n).toBe(2)
    await holder.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`)
    await holder.end()
    await runs

    // The two runs don't interleave: one instance runs to completion (through incremental RBAC seeding) before the other gets the lock
    const first = events[0]!.slice(0, 1)
    const second = first === 'A' ? 'B' : 'A'
    const secondAcquired = events.indexOf(`${second} [setup] 已获取初始化锁（并发安全）`)
    const firstReleased = `${first} [setup] 初始化完成，已释放锁`
    expect(events.slice(0, secondAcquired).filter((e) => e !== firstReleased)).toEqual([
      `${first} [setup] 已获取初始化锁（并发安全）`,
      `${first} [setup] 运行数据库迁移...`,
      `${first} [setup] 数据库迁移完成`,
      `${first} [setup] 同步 RBAC 菜单与权限...`,
    ])
    expect(events.filter((e) => e.startsWith(second))).toHaveLength(5)

    const snap = await rbacSnapshot(url)
    expect(snap.menus).toHaveLength(MENUS_DATA.length)
    expect(snap.roles).toEqual([{ id: 1, code: 'super_admin' }])
    expect(snap.users.map((u) => u.username)).toEqual(['admin'])
    expect(snap.roleMenus).toHaveLength(MENUS_DATA.length)
    expect(snap.migrations).toHaveLength(MIGRATION_COUNT)
    const locks = await query<{ n: number }>(url, `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${ADVISORY_LOCK_KEY}`)
    expect(locks[0]!.n).toBe(0)
  })

  it('再次执行幂等：增量同步不删用户/自定义角色，数据与 updated_at 均不变', async () => {
    await query(url, "INSERT INTO roles (name, code, created_at) VALUES ('自定义', 'ck_test_r8_role', now())")
    await query(url, "INSERT INTO admin_users (username, password_hash, created_at) VALUES ('ck_test_r8_user', 'x', now())")
    const before = await rbacSnapshot(url)
    await runSetupOnce({ databaseUrl: url, adminPassword: 'changed', log: quiet })
    expect(await rbacSnapshot(url)).toEqual(before)
  })

})
