import { createHash } from 'node:crypto'
/**
 * Authentication and authorization
 *
 * Permission checks in routes must always be imported from here; never define a custom hasPermission inside a module.
 */

import { eq, inArray, type SQL } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import type { Executor } from '@/db/client'
import { admin_users, type AdminUserWithRoles } from '@/db/schema'
import { userHasMenuCode } from './rbac'

const LOGIN_PAGE = '/admin/login'

function isApiRequest(request: FastifyRequest): boolean {
  return request.url.startsWith('/api/')
}

/** Login-required preHandler */
export const loginRequired: preHandlerAsyncHookHandler = async (request, reply) => {
  if (!request.session.get('logged_in') || !(await getCurrentAdminUser(request))) {
    if (isApiRequest(request)) {
      return reply.status(401).send({ error: '未授权访问', redirect: LOGIN_PAGE })
    }
    return reply.redirect(LOGIN_PAGE)
  }
}

const WITH_ROLES_MENUS = {
  user_roles: {
    with: {
      role: {
        with: {
          role_menus: { with: { menu: true } },
        },
      },
    },
  },
} as const

type AdminRowWithRelations = NonNullable<Awaited<ReturnType<typeof findAdminRow>>>
async function findAdminRow(db: Executor, where: SQL) {
  return db.query.admin_users.findFirst({ where, with: WITH_ROLES_MENUS })
}

function flattenAdmin(row: AdminRowWithRelations): AdminUserWithRoles {
  const { user_roles: userRoles, ...user } = row
  return {
    ...user,
    roles: userRoles
      .map(({ role }) => {
        const { role_menus: roleMenus, ...rest } = role
        return { ...rest, menus: roleMenus.map((rm) => rm.menu) }
      })
      .sort((a, b) => a.id - b.id),
  }
}

/**
 * Load a user by username, eager-loading roles → menus in a single query
 */
export async function loadAdminWithRoles(db: Executor, username: string): Promise<AdminUserWithRoles | null> {
  const row = await findAdminRow(db, eq(admin_users.username, username))
  return row ? flattenAdmin(row) : null
}

/** Batch-load by id (eager-loading roles → menus); results follow the order of ids, missing ids are skipped */
export async function loadAdminsWithRolesByIds(db: Executor, ids: number[]): Promise<AdminUserWithRoles[]> {
  if (ids.length === 0) return []
  const rows = await db.query.admin_users.findMany({ where: inArray(admin_users.id, ids), with: WITH_ROLES_MENUS })
  const byId = new Map(rows.map((r) => [r.id, flattenAdmin(r)]))
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
}

/** Current logged-in user (cached per request to avoid N+1 in permission checks) */
export async function getCurrentAdminUser(request: FastifyRequest): Promise<AdminUserWithRoles | null> {
  if (request.currentAdminUser !== undefined) return request.currentAdminUser

  const id=request.session.get('user_id')
  const row=Number.isSafeInteger(id) ? await findAdminRow(request.server.db,eq(admin_users.id,id!)) : null
  const user=row?flattenAdmin(row):null
  if(!user || request.session.get('credential_version')!==sessionCredentialVersion(user.password_hash)) {
    request.currentAdminUser=null
    request.session.delete()
    return null
  }
  if (request.session.get('username') !== user.username) request.session.set('username', user.username)
  request.currentAdminUser=user
  return user
}

export async function hasMenuPermission(request: FastifyRequest, menuCode: string): Promise<boolean> {
  const user = await getCurrentAdminUser(request)
  return Boolean(user && userHasMenuCode(user, menuCode))
}

export async function hasAnyMenuPermission(request: FastifyRequest, ...menuCodes: string[]): Promise<boolean> {
  for (const code of menuCodes) {
    if (code && (await hasMenuPermission(request, code))) return true
  }
  return false
}

/** Menu permission preHandler (by menu code) */
export function menuPermissionRequired(menuCode: string): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const api = isApiRequest(request)
    if (!request.session.get('logged_in')) {
      return api ? reply.status(401).send({ error: '未登录' }) : reply.redirect(LOGIN_PAGE)
    }
    if (!request.session.get('username')) {
      return api ? reply.status(401).send({ error: '会话异常' }) : reply.redirect(LOGIN_PAGE)
    }
    const user = await getCurrentAdminUser(request)
    if (!user) {
      return api ? reply.status(401).send({ error: '未登录' }) : reply.redirect(LOGIN_PAGE)
    }
    if (!userHasMenuCode(user, menuCode)) {
      return reply.status(403).send({ error: api ? `缺少权限: ${menuCode}` : '无权限' })
    }
  }
}

/** Stored inside the authenticated encrypted cookie, not a public password hash. */
export const sessionCredentialVersion = (hash: string) => createHash('sha256').update(hash).digest('hex')
