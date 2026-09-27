/**
 * RBAC seed data: menus, the super admin role, the admin account and their permission links
 *
 * Usage:
 *   pnpm seed:rbac                    # full rebuild: truncate user_roles / role_menus / admin_users / roles / menus, then rewrite
 *   pnpm seed:rbac -- --incremental   # incremental sync: upsert menus by code + refresh super admin permissions, deletes nothing
 *
 * The menu tree (MENUS_DATA) is the single source of truth: add new menu/button permission entries here, then run `--incremental`.
 * IDs are fixed (including the legacy 31/33/34/35/36/37/100002/100003) and must not be changed.
 *
 * Key behaviors:
 * - Menus are matched by code: existing ones only get their 9 fields updated (id unchanged); missing ones are inserted with the fixed id, falling back to the sequence if that id is taken
 * - No UPDATE is issued when field values are unchanged, so updated_at stays as is
 * - After inserting, only the menus sequence is synced: setval(pg_get_serial_sequence('menus','id'), max(id)+1, false)
 * - The super admin role (super_admin) is granted all menus; the admin account is created only if missing (password from ADMIN_PASSWORD, pbkdf2:sha256 format)
 * - Commit boundaries: truncate / menus / roles / account each run in their own transaction
 */

import { parseArgs } from 'node:util'
import pg from 'pg'
import { generatePasswordHash } from '../src/common/password'
import { loadConfig, loadEnvFiles, type AppEnv } from '../src/config'

export interface MenuSeed {
  id: number
  name: string
  code: string
  icon: string | null
  path: string | null
  component: string | null
  parent_id: number | null
  sort_order: number
  menu_type: 'menu' | 'button'
  is_visible: boolean
  is_active: boolean
}

// prettier-ignore
export const MENUS_DATA: readonly MenuSeed[] = [
  { id: 2, name: "系统管理", code: "system", icon: "IconSetting", path: null, component: null, parent_id: null, sort_order: 99, menu_type: "menu", is_visible: true, is_active: true },
  { id: 21, name: "用户管理", code: "system_users", icon: "IconUser", path: "/system/users", component: "admin/users", parent_id: 2, sort_order: 1, menu_type: "menu", is_visible: true, is_active: true },
  { id: 22, name: "角色权限", code: "system_roles", icon: "IconIdCard", path: "/system/roles", component: "admin/roles", parent_id: 2, sort_order: 2, menu_type: "menu", is_visible: true, is_active: true },
  { id: 23, name: "菜单管理", code: "system_menus", icon: "IconApps", path: "/system/menus", component: "admin/menus", parent_id: 2, sort_order: 3, menu_type: "menu", is_visible: true, is_active: true },
  { id: 24, name: "日志管理", code: "system_logs", icon: "IconFile", path: "/system/logs", component: "admin/logs", parent_id: 2, sort_order: 4, menu_type: "menu", is_visible: true, is_active: true },
  { id: 25, name: "数据字典", code: "system_dicts", icon: "IconList", path: "/system/dicts", component: "admin/dicts", parent_id: 2, sort_order: 5, menu_type: "menu", is_visible: true, is_active: true },
  { id: 32, name: "定时任务", code: "system_scheduled_tasks", icon: "IconSetting", path: "/system/scheduled-tasks", component: "admin/scheduled_tasks", parent_id: 2, sort_order: 6, menu_type: "menu", is_visible: true, is_active: true },
  { id: 100002, name: "消息通知", code: "system_notifications", icon: "IconBell", path: "/system/notifications", component: "admin/notifications", parent_id: 2, sort_order: 33, menu_type: "menu", is_visible: true, is_active: true },
  { id: 100003, name: "公告管理", code: "system_announcements", icon: "IconSend", path: "/system/announcements", component: "admin/announcement_page", parent_id: 2, sort_order: 34, menu_type: "menu", is_visible: true, is_active: true },
  { id: 211, name: "新增用户", code: "system_users_add", icon: null, path: null, component: null, parent_id: 21, sort_order: 1, menu_type: "button", is_visible: false, is_active: true },
  { id: 212, name: "编辑用户", code: "system_users_edit", icon: null, path: null, component: null, parent_id: 21, sort_order: 2, menu_type: "button", is_visible: false, is_active: true },
  { id: 213, name: "删除用户", code: "system_users_delete", icon: null, path: null, component: null, parent_id: 21, sort_order: 3, menu_type: "button", is_visible: false, is_active: true },
  { id: 214, name: "导出用户", code: "system_users_export", icon: null, path: null, component: null, parent_id: 21, sort_order: 4, menu_type: "button", is_visible: false, is_active: true },
  { id: 215, name: "导入用户", code: "system_users_import", icon: null, path: null, component: null, parent_id: 21, sort_order: 5, menu_type: "button", is_visible: false, is_active: true },
  { id: 221, name: "新增角色", code: "system_roles_add", icon: null, path: null, component: null, parent_id: 22, sort_order: 1, menu_type: "button", is_visible: false, is_active: true },
  { id: 222, name: "编辑角色", code: "system_roles_edit", icon: null, path: null, component: null, parent_id: 22, sort_order: 2, menu_type: "button", is_visible: false, is_active: true },
  { id: 223, name: "删除角色", code: "system_roles_delete", icon: null, path: null, component: null, parent_id: 22, sort_order: 3, menu_type: "button", is_visible: false, is_active: true },
  { id: 224, name: "导出角色", code: "system_roles_export", icon: null, path: null, component: null, parent_id: 22, sort_order: 4, menu_type: "button", is_visible: false, is_active: true },
  { id: 225, name: "导入角色", code: "system_roles_import", icon: null, path: null, component: null, parent_id: 22, sort_order: 5, menu_type: "button", is_visible: false, is_active: true },
  { id: 231, name: "新增菜单", code: "system_menus_add", icon: null, path: null, component: null, parent_id: 23, sort_order: 1, menu_type: "button", is_visible: false, is_active: true },
  { id: 232, name: "编辑菜单", code: "system_menus_edit", icon: null, path: null, component: null, parent_id: 23, sort_order: 2, menu_type: "button", is_visible: false, is_active: true },
  { id: 233, name: "删除菜单", code: "system_menus_delete", icon: null, path: null, component: null, parent_id: 23, sort_order: 3, menu_type: "button", is_visible: false, is_active: true },
  { id: 234, name: "导出菜单", code: "system_menus_export", icon: null, path: null, component: null, parent_id: 23, sort_order: 4, menu_type: "button", is_visible: false, is_active: true },
  { id: 235, name: "导入菜单", code: "system_menus_import", icon: null, path: null, component: null, parent_id: 23, sort_order: 5, menu_type: "button", is_visible: false, is_active: true },
  { id: 241, name: "查看日志", code: "system_logs_view", icon: null, path: null, component: null, parent_id: 24, sort_order: 1, menu_type: "button", is_visible: false, is_active: true },
  { id: 242, name: "导出日志", code: "system_logs_export", icon: null, path: null, component: null, parent_id: 24, sort_order: 2, menu_type: "button", is_visible: false, is_active: true },
  { id: 243, name: "导入日志", code: "system_logs_import", icon: null, path: null, component: null, parent_id: 24, sort_order: 3, menu_type: "button", is_visible: false, is_active: true },
  { id: 251, name: "新增字典", code: "system_dicts_add", icon: null, path: null, component: null, parent_id: 25, sort_order: 1, menu_type: "button", is_visible: false, is_active: true },
  { id: 252, name: "编辑字典", code: "system_dicts_edit", icon: null, path: null, component: null, parent_id: 25, sort_order: 2, menu_type: "button", is_visible: false, is_active: true },
  { id: 253, name: "删除字典", code: "system_dicts_delete", icon: null, path: null, component: null, parent_id: 25, sort_order: 3, menu_type: "button", is_visible: false, is_active: true },
  { id: 254, name: "导出字典", code: "system_dicts_export", icon: null, path: null, component: null, parent_id: 25, sort_order: 4, menu_type: "button", is_visible: false, is_active: true },
  { id: 255, name: "导入字典", code: "system_dicts_import", icon: null, path: null, component: null, parent_id: 25, sort_order: 5, menu_type: "button", is_visible: false, is_active: true },
  {id: 1000, name: "网关总览", code: "gateway_overview", icon: "IconHome", path: "/dashboard", component: "gateway/overview", parent_id: null, sort_order: 1, menu_type: "menu", is_visible: true, is_active: true},
  {id: 1001, name: "模型服务", code: "gateway_upstreams", icon: "IconServer", path: "/gateway/upstreams", component: "gateway/upstreams", parent_id: null, sort_order: 2, menu_type: "menu", is_visible: true, is_active: true},
  {id: 1010, name: "我的用量", code: "gateway_my_usage", icon: "IconFile", path: null, component: null, parent_id: null, sort_order: 11, menu_type: "menu", is_visible: false, is_active: true},
  {id: 10014, name: "测试模型服务", code: "gateway_upstreams_test", icon: null, path: null, component: null, parent_id: 1001, sort_order: 4, menu_type: "button", is_visible: false, is_active: true},
  {id: 10011, name: "新增模型服务", code: "gateway_upstreams_add", icon: null, path: null, component: null, parent_id: 1001, sort_order: 1, menu_type: "button", is_visible: false, is_active: true},
  {id: 10012, name: "编辑模型服务", code: "gateway_upstreams_edit", icon: null, path: null, component: null, parent_id: 1001, sort_order: 2, menu_type: "button", is_visible: false, is_active: true},
  {id: 10013, name: "停用模型服务", code: "gateway_upstreams_delete", icon: null, path: null, component: null, parent_id: 1001, sort_order: 3, menu_type: "button", is_visible: false, is_active: true},
  {id: 1002, name: "模型与路由", code: "gateway_routes", icon: "IconBranch", path: "/gateway/routes", component: "gateway/routes", parent_id: null, sort_order: 3, menu_type: "menu", is_visible: true, is_active: true},
  {id: 10021, name: "新增模型路由", code: "gateway_routes_add", icon: null, path: null, component: null, parent_id: 1002, sort_order: 1, menu_type: "button", is_visible: false, is_active: true},
  {id: 10022, name: "编辑模型路由", code: "gateway_routes_edit", icon: null, path: null, component: null, parent_id: 1002, sort_order: 2, menu_type: "button", is_visible: false, is_active: true},
  {id: 10023, name: "停用模型路由", code: "gateway_routes_delete", icon: null, path: null, component: null, parent_id: 1002, sort_order: 3, menu_type: "button", is_visible: false, is_active: true},
  {id: 1003, name: "访问与授权", code: "gateway_keys", icon: "IconKey", path: "/gateway/keys", component: "gateway/keys", parent_id: null, sort_order: 4, menu_type: "menu", is_visible: true, is_active: true},
  {id: 10031, name: "创建访问密钥", code: "gateway_keys_add", icon: null, path: null, component: null, parent_id: 1003, sort_order: 1, menu_type: "button", is_visible: false, is_active: true},
  {id: 10032, name: "编辑访问密钥", code: "gateway_keys_edit", icon: null, path: null, component: null, parent_id: 1003, sort_order: 2, menu_type: "button", is_visible: false, is_active: true},
  {id: 10033, name: "吊销访问密钥", code: "gateway_keys_delete", icon: null, path: null, component: null, parent_id: 1003, sort_order: 3, menu_type: "button", is_visible: false, is_active: true},
  {id: 1009, name: "设备登录确认", code: "gateway_device_confirm", icon: "IconKey", path: null, component: null, parent_id: null, sort_order: 10, menu_type: "menu", is_visible: false, is_active: true},
  {id: 10035, name: "确认设备登录", code: "gateway_device_confirm_action", icon: null, path: null, component: null, parent_id: 1009, sort_order: 5, menu_type: "button", is_visible: false, is_active: true},
  {id: 10034, name: "轮换访问密钥", code: "gateway_keys_rotate", icon: null, path: null, component: null, parent_id: 1003, sort_order: 4, menu_type: "button", is_visible: false, is_active: true},
  {id: 1004, name: "请求日志", code: "gateway_requests", icon: "IconFile", path: "/gateway/requests", component: "gateway/requests", parent_id: null, sort_order: 5, menu_type: "menu", is_visible: true, is_active: true},
  {id: 10041, name: "导出个人用量", code: "gateway_my_usage_export", icon: null, path: null, component: null, parent_id: 1010, sort_order: 1, menu_type: "button", is_visible: false, is_active: true},
  {id: 10042, name: "编辑用户配额", code: "gateway_requests_quota_edit", icon: null, path: null, component: null, parent_id: 1004, sort_order: 2, menu_type: "button", is_visible: false, is_active: true},
  {id: 1008, name: "网页搜索", code: "gateway_websearch", icon: "IconSearch", path: "/gateway/web-search", component: "gateway/web-search", parent_id: null, sort_order: 9, menu_type: "menu", is_visible: true, is_active: true},
  {id: 10081, name: "配置网页搜索", code: "gateway_websearch_edit", icon: null, path: null, component: null, parent_id: 1008, sort_order: 1, menu_type: "button", is_visible: false, is_active: true},
  {id: 1007, name: "缓存验证", code: "gateway_cache_tests", icon: "IconServer", path: "/gateway/cache-tests", component: "gateway/cache-tests", parent_id: null, sort_order: 8, menu_type: "menu", is_visible: true, is_active: true},
  {id: 10071, name: "运行缓存验证", code: "gateway_cache_tests_run", icon: null, path: null, component: null, parent_id: 1007, sort_order: 1, menu_type: "button", is_visible: false, is_active: true},
  {id: 10072, name: "删除缓存验证", code: "gateway_cache_tests_delete", icon: null, path: null, component: null, parent_id: 1007, sort_order: 2, menu_type: "button", is_visible: false, is_active: true},
  {id: 1006, name: "模型能力", code: "gateway_model_profiles", icon: "IconServer", path: "/gateway/model-profiles", component: "gateway/model-profiles", parent_id: null, sort_order: 7, menu_type: "menu", is_visible: true, is_active: true},
  ...['add','edit','delete'].map((action,index)=>({id:10061+index,name:['新增模型能力','编辑模型能力','删除模型能力'][index]!,code:`gateway_model_profiles_${action}`,icon:null,path:null,component:null,parent_id:1006,sort_order:index+1,menu_type:'button' as const,is_visible:false,is_active:true})),
  {id: 1005, name: "模型渠道", code: "gateway_my_channels", icon: "IconServer", path: "/gateway/my-channels", component: "gateway/my-channels", parent_id: null, sort_order: 6, menu_type: "menu", is_visible: true, is_active: true},
  {id: 10051, name: "新增个人渠道", code: "gateway_my_channels_add", icon: null, path: null, component: null, parent_id: 1005, sort_order: 1, menu_type: "button", is_visible: false, is_active: true},
  {id: 10052, name: "编辑个人渠道", code: "gateway_my_channels_edit", icon: null, path: null, component: null, parent_id: 1005, sort_order: 2, menu_type: "button", is_visible: false, is_active: true},
  {id: 10053, name: "删除个人渠道", code: "gateway_my_channels_delete", icon: null, path: null, component: null, parent_id: 1005, sort_order: 3, menu_type: "button", is_visible: false, is_active: true},

  {id: 10054, name: "测试个人渠道", code: "gateway_my_channels_test", icon: null, path: null, component: null, parent_id: 1005, sort_order: 4, menu_type: "button", is_visible: false, is_active: true},

]

/** Retired experimental page menus: data is kept but they are hidden from navigation */
export const RETIRED_MENU_CODES = [
  'component_center_templates',
  'component_center_scenarios',
] as const

const MENU_UPDATE_FIELDS = [
  'name',
  'icon',
  'path',
  'component',
  'parent_id',
  'sort_order',
  'menu_type',
  'is_visible',
  'is_active',
] as const

const UTC_NOW = "timezone('utc', now())"

type Queryable = pg.ClientBase

interface MenuRow {
  id: number
  code: string
  name: string
  icon: string | null
  path: string | null
  component: string | null
  parent_id: number | null
  sort_order: number | null
  menu_type: string | null
  is_visible: boolean | null
  is_active: boolean | null
}

export interface SeedRbacOptions {
  databaseUrl: string
  /** Initial password for the default admin (the CLI reads ADMIN_PASSWORD from app config; dev/test falls back to admin123) */
  adminPassword: string
  /** true: upsert only, never delete (--incremental) */
  incremental?: boolean
  log?: (msg: string) => void
}

export interface SeedRbacResult {
  menusAdded: number
  menusUpdated: number
  superAdminMenuCount: number
  adminCreated: boolean
}

async function inTransaction<T>(
  client: Queryable,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN')
  try {
    const result = await fn()
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

async function findMenuByCode(
  client: Queryable,
  code: string,
): Promise<MenuRow | undefined> {
  const { rows } = await client.query<MenuRow>(
    'SELECT * FROM menus WHERE code = $1 LIMIT 1',
    [code],
  )
  return rows[0]
}

async function clearRbacData(
  client: Queryable,
  log: (msg: string) => void,
): Promise<void> {
  log('清空现有RBAC数据...')
  try {
    await inTransaction(client, async () => {
      await client.query('DELETE FROM user_roles')
      log('  清空用户-角色关联')
      await client.query('DELETE FROM role_menus')
      log('  清空角色-菜单关联')
      await client.query('DELETE FROM admin_users')
      log('  清空管理员账号')
      await client.query('DELETE FROM roles')
      log('  清空角色')
      await client.query('DELETE FROM menus')
      log('  清空菜单')
    })
    log('数据清空完成\n')
  } catch (err) {
    log(`  清空失败: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

/** Migrate the old menu code data_management to component_center, avoiding duplicate menus after the rename */
async function migrateComponentCenterMenuCode(
  client: Queryable,
  log: (msg: string) => void,
): Promise<void> {
  const legacy = await findMenuByCode(client, 'data_management')
  const current = await findMenuByCode(client, 'component_center')
  if (!legacy) return

  if (current && current.id !== legacy.id) {
    // Move any submenus attached under the new-code menu back to the old menu to keep the hierarchy stable
    await client.query(
      `UPDATE menus SET parent_id = $1, updated_at = ${UTC_NOW} WHERE parent_id = $2`,
      [legacy.id, current.id],
    )
    // Migrate role-menu links so permissions are not lost when the duplicate menu is deleted
    await client.query(
      `INSERT INTO role_menus (role_id, menu_id)
       SELECT DISTINCT rm.role_id, $1::int
       FROM role_menus rm
       WHERE rm.menu_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM role_menus x WHERE x.role_id = rm.role_id AND x.menu_id = $1::int
       )`,
      [legacy.id, current.id],
    )
    await client.query('DELETE FROM role_menus WHERE menu_id = $1', [
      current.id,
    ])
    // First rename the duplicate record to a temporary code to avoid a unique-key conflict, then delete it
    await client.query(
      `UPDATE menus SET code = $1, updated_at = ${UTC_NOW} WHERE id = $2`,
      [`component_center_legacy_${current.id}`, current.id],
    )
    await client.query('DELETE FROM menus WHERE id = $1', [current.id])
    log('  已合并重复菜单: [data_management] + [component_center]')
  }

  await client.query(
    `UPDATE menus SET code = $1, name = $2, updated_at = ${UTC_NOW} WHERE id = $3`,
    ['component_center', '组件示例中心', legacy.id],
  )
  log('  菜单编码迁移: [data_management] -> [component_center]')
}

/** Migrate the old query_management menu/button codes to list_page, avoiding duplicate menus */
async function migrateListPageMenuCodes(
  client: Queryable,
  log: (msg: string) => void,
): Promise<void> {
  const codeMappings: Array<[string, string]> = [
    ['system_query_management', 'system_list_page'],
    ['system_query_management_add', 'system_list_page_add'],
    ['system_query_management_edit', 'system_list_page_edit'],
    ['system_query_management_delete', 'system_list_page_delete'],
  ]

  for (const [oldCode, newCode] of codeMappings) {
    const legacy = await findMenuByCode(client, oldCode)
    const current = await findMenuByCode(client, newCode)
    if (!legacy) continue

    if (current && current.id !== legacy.id) {
      await client.query(
        `UPDATE menus SET parent_id = $1, updated_at = ${UTC_NOW} WHERE parent_id = $2`,
        [current.id, legacy.id],
      )
      await client.query(
        `INSERT INTO role_menus (role_id, menu_id)
         SELECT DISTINCT rm.role_id, $1::int
         FROM role_menus rm
         WHERE rm.menu_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM role_menus x WHERE x.role_id = rm.role_id AND x.menu_id = $1::int
         )`,
        [current.id, legacy.id],
      )
      await client.query('DELETE FROM role_menus WHERE menu_id = $1', [
        legacy.id,
      ])
      await client.query(
        `UPDATE menus SET code = $1, updated_at = ${UTC_NOW} WHERE id = $2`,
        [`legacy_${oldCode}_${legacy.id}`, legacy.id],
      )
      await client.query('DELETE FROM menus WHERE id = $1', [legacy.id])
      log(`  已合并重复菜单编码: [${oldCode}] + [${newCode}]`)
      continue
    }

    await client.query(
      `UPDATE menus SET code = $1, updated_at = ${UTC_NOW} WHERE id = $2`,
      [newCode, legacy.id],
    )
    log(`  菜单编码迁移: [${oldCode}] -> [${newCode}]`)
  }
}

/** Sync a PostgreSQL table's primary-key sequence to the current max id (table name is an internal constant, not user input) */
async function syncIdSequence(
  client: Queryable,
  tableName: 'menus',
  log: (msg: string) => void,
): Promise<void> {
  await client.query(
    `SELECT setval(
       pg_get_serial_sequence('${tableName}', 'id'),
       COALESCE((SELECT MAX(id) FROM ${tableName}), 0) + 1,
       false
     )`,
  )
  log(`  已同步序列: ${tableName}.id`)
}

async function initMenus(
  client: Queryable,
  log: (msg: string) => void,
): Promise<{ added: number; updated: number }> {
  let added = 0
  let updated = 0

  await inTransaction(client, async () => {
    await migrateComponentCenterMenuCode(client, log)
    await migrateListPageMenuCodes(client, log)

    log('初始化菜单数据...')
    const { rows: idRows } = await client.query<{ id: number }>(
      'SELECT id FROM menus',
    )
    const existingIds = new Set(idRows.map((r) => r.id))

    const resolvedIds = new Map<number, number>()
    for (const definition of MENUS_DATA) {
      // Existing installations may retain a different ID for a canonical code.
      // Resolve children against the actual parent, not the seed's preferred ID.
      const parentId = definition.parent_id === null ? null : resolvedIds.get(definition.parent_id)
      if (parentId === undefined) throw new Error(`Missing seeded parent for ${definition.code}`)
      const menu = { ...definition, parent_id: parentId }
      const existing = await findMenuByCode(client, menu.code)
      if (existing) {
        resolvedIds.set(definition.id, existing.id)
        const changed = MENU_UPDATE_FIELDS.some(
          (field) => existing[field] !== menu[field],
        )
        if (changed) {
          await client.query(
            `UPDATE menus SET name = $1, icon = $2, path = $3, component = $4, parent_id = $5,
               sort_order = $6, menu_type = $7, is_visible = $8, is_active = $9, updated_at = ${UTC_NOW}
             WHERE id = $10`,
            [
              menu.name,
              menu.icon,
              menu.path,
              menu.component,
              menu.parent_id,
              menu.sort_order,
              menu.menu_type,
              menu.is_visible,
              menu.is_active,
              existing.id,
            ],
          )
        }
        updated += 1
        log(`  更新菜单: [${menu.code}] ${menu.name}`)
        continue
      }

      // If the fixed id is already taken by another menu (legacy data), don't force it; use the sequence instead
      const useFixedId = !existingIds.has(menu.id)
      const values = [
        menu.name,
        menu.code,
        menu.icon,
        menu.path,
        menu.component,
        menu.parent_id,
        menu.sort_order,
        menu.menu_type,
        menu.is_visible,
        menu.is_active,
      ]
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO menus (${useFixedId ? 'id, ' : ''}name, code, icon, path, component, parent_id,
           sort_order, menu_type, is_visible, is_active, created_at, updated_at)
         VALUES (${useFixedId ? '$11, ' : ''}$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${UTC_NOW}, ${UTC_NOW})
         RETURNING id`,
        useFixedId ? [...values, menu.id] : values,
      )
      const newId = rows[0]!.id
      resolvedIds.set(definition.id, newId)
      added += 1
      existingIds.add(newId)
      log(`  创建菜单: [${menu.code}] ${menu.name} (ID: ${newId})`)
    }

    for (const code of RETIRED_MENU_CODES) {
      const retired = await findMenuByCode(client, code)
      if (retired && (retired.is_active || retired.is_visible)) {
        await client.query(
          `UPDATE menus SET is_active = false, is_visible = false, updated_at = ${UTC_NOW} WHERE id = $1`,
          [retired.id],
        )
        updated += 1
        log(`  下线菜单: [${code}]`)
      }
    }
  })

  if (added > 0 || updated > 0) {
    log(`菜单同步完成，新增 ${added} 项，更新 ${updated} 项\n`)
  } else {
    log('菜单无变更\n')
  }

  // Works around the sequence not advancing after explicitly inserting fixed ids
  await syncIdSequence(client, 'menus', log)
  return { added, updated }
}

/** Refresh super admin permissions (grant all menus); returns the role id and menu count */
async function refreshSuperAdminPermissions(
  client: Queryable,
  log: (msg: string) => void,
): Promise<{ roleId: number; menuCount: number }> {
  log('刷新超级管理员权限...')
  return inTransaction(client, async () => {
    const { rows } = await client.query<{ id: number }>(
      "SELECT id FROM roles WHERE code = 'super_admin' LIMIT 1",
    )
    let roleId = rows[0]?.id
    if (roleId === undefined) {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO roles (name, code, description, created_at) VALUES ($1, $2, $3, ${UTC_NOW}) RETURNING id`,
        ['超级管理员', 'super_admin', '拥有所有权限的超级管理员'],
      )
      roleId = inserted.rows[0]!.id
      log('  创建角色: 超级管理员')
    }

    // admin_role.menus = all_menus: set the linked set to all menus (FKs guarantee no links point to deleted menus, so only missing ones need adding)
    await client.query(
      `INSERT INTO role_menus (role_id, menu_id) SELECT $1::int, id FROM menus ON CONFLICT DO NOTHING`,
      [roleId],
    )
    const { rows: countRows } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM menus',
    )
    const menuCount = countRows[0]?.n ?? 0
    log(`  超级管理员刷新为 ${menuCount} 个菜单权限`)
    return { roleId, menuCount }
  })
}

async function initAdminUser(
  client: Queryable,
  roleId: number,
  adminPassword: string,
  log: (msg: string) => void,
): Promise<boolean> {
  log('初始化管理员账号...')
  let created = false
  await inTransaction(client, async () => {
    const { rows } = await client.query<{ id: number }>(
      "SELECT id FROM admin_users WHERE username = 'admin' LIMIT 1",
    )
    let userId = rows[0]?.id
    if (userId === undefined) {
      const passwordHash = await generatePasswordHash(adminPassword)
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO admin_users (username, password_hash, created_at) VALUES ($1, $2, ${UTC_NOW}) RETURNING id`,
        ['admin', passwordHash],
      )
      userId = inserted.rows[0]!.id
      created = true
      log('  创建用户: admin')
    } else {
      log('  用户已存在: admin')
    }

    const assigned = await client.query(
      'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, roleId],
    )
    if (assigned.rowCount) log('  分配角色: 超级管理员')
  })
  log('管理员账号初始化完成\n')
  return created
}

/** Reusable entry point (called by setup-once); throws on failure and lets the caller choose the exit code */
export async function seedRbac(
  options: SeedRbacOptions,
): Promise<SeedRbacResult> {
  const log = options.log ?? console.log
  const incremental = options.incremental ?? false
  const client = new pg.Client({ connectionString: options.databaseUrl })
  await client.connect()
  try {
    log('='.repeat(60))
    log('RBAC系统同步')
    log(`${'='.repeat(60)}\n`)

    let menus: { added: number; updated: number }
    let role: { roleId: number; menuCount: number }
    if (incremental) {
      log('模式: 增量同步\n')
      menus = await initMenus(client, log)
      role = await refreshSuperAdminPermissions(client, log)
    } else {
      log('模式: 全量重建\n')
      await clearRbacData(client, log)
      menus = await initMenus(client, log)
      log('初始化角色...')
      role = await refreshSuperAdminPermissions(client, log)
      log('角色初始化完成\n')
    }
    const adminCreated = await initAdminUser(
      client,
      role.roleId,
      options.adminPassword,
      log,
    )

    log('='.repeat(60))
    log('同步完成！')
    log('='.repeat(60))
    log('\n登录信息：')
    log('  用户名: admin')
    log('  密码: 使用部署时设置的 ADMIN_PASSWORD（不会写入日志）')

    return {
      menusAdded: menus.added,
      menusUpdated: menus.updated,
      superAdminMenuCount: role.menuCount,
      adminCreated,
    }
  } finally {
    await client.end()
  }
}

// Detect direct execution by script file name: this file is bundled into the same output by setup-once, so import.meta.url is unreliable
const isMain = /[\\/]seed-rbac\.(?:ts|js|mjs)$/.test(process.argv[1] ?? '')
if (isMain) {
  let incremental = false
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2).filter((arg) => arg !== '--'),
      options: { incremental: { type: 'boolean', default: false } },
    })
    incremental = values.incremental
  } catch (err) {
    // Exit code 2 for argument errors
    console.error('usage: seed-rbac [--incremental]')
    console.error(
      `seed-rbac: error: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(2)
  }
  const env = (process.env.NODE_ENV ?? 'development') as AppEnv
  loadEnvFiles(env)
  const config = loadConfig()
  seedRbac({
    databaseUrl: config.databaseUrl,
    adminPassword: config.adminPassword,
    incremental,
  }).catch((err: unknown) => {
    console.error(
      `\n初始化失败: ${err instanceof Error ? err.message : String(err)}`,
    )
    if (err instanceof Error && err.stack) console.error(err.stack)
    process.exit(1)
  })
}
