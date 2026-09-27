/**
 * Container-concurrency-safe initialization: DB migrations + RBAC sync
 *
 * When multiple replicas start at once, a PostgreSQL advisory lock ensures only one instance runs the init;
 * the others wait on the lock; once the first finishes, each waiting instance acquires the lock, runs (idempotently) and releases it.
 *
 * Usage: the Docker entrypoint runs `node dist/setup-once.js` before starting the web process (dev: `pnpm setup-once`).
 *
 * RBAC sync uses incremental mode (--incremental): only menus and permissions are synced; admin_users / roles / menus are not cleared,
 * so container restarts don't delete existing users, custom roles or notifications.
 */

import pg from 'pg'
import { loadConfig, loadEnvFiles, type AppEnv } from '../src/config'
import { runMigrations } from '../src/db/migrate'
import { seedRbac } from './seed-rbac'

/** "CKIT" */
export const ADVISORY_LOCK_KEY = 0x434b4954

export interface SetupOnceOptions {
  databaseUrl: string
  adminPassword: string
  log?: (msg: string) => void
}

export async function runSetupOnce(options: SetupOnceOptions): Promise<void> {
  const log = options.log ?? console.log
  // A session-level advisory lock must be held on a dedicated connection, not via the pool
  const lockClient = new pg.Client({ connectionString: options.databaseUrl })
  await lockClient.connect()
  try {
    await lockClient.query(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`)
    log('[setup] 已获取初始化锁（并发安全）')

    log('[setup] 运行数据库迁移...')
    await runMigrations(options.databaseUrl, log)
    log('[setup] 数据库迁移完成')

    log('[setup] 同步 RBAC 菜单与权限...')
    await seedRbac({
      databaseUrl: options.databaseUrl,
      adminPassword: options.adminPassword,
      incremental: true,
      log,
    })


  } finally {
    // Closing the connection releases the session-level lock; unlock explicitly first, ignoring errors if the connection is already gone
    await lockClient.query(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`).catch(() => {})
    await lockClient.end().catch(() => {})
    log('[setup] 初始化完成，已释放锁')
  }
}

// Decide whether this is a direct run by the script filename (tsx running source or node running dist/setup-once.js)
const isMain = /[\\/]setup-once\.(?:ts|js|mjs)$/.test(process.argv[1] ?? '')
if (isMain) {
  const env = (process.env.NODE_ENV ?? 'development') as AppEnv
  loadEnvFiles(env)
  const config = loadConfig()
  runSetupOnce({
    databaseUrl: config.databaseUrl,
    adminPassword: config.adminPassword,
  }).catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
