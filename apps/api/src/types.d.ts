import type { GatewayRequestLease } from './modules/gateway/request-lifecycle'
import type { AppConfig } from './config'
import type { Db } from './db/client'
import type { AdminUserWithRoles } from './db/schema'
import type { GatewayRuntime } from './modules/gateway/runtime'

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig
    db: Db
    gatewayRuntime: GatewayRuntime
  }
  interface FastifyRequest {
    gatewayLease?: GatewayRequestLease
    /** Per-request cache for getCurrentAdminUser(); undefined = not yet queried */
    currentAdminUser?: AdminUserWithRoles | null
  }
}

/** Fields stored in the session */
declare module '@fastify/secure-session' {
  interface SessionData {
    user_id: number
    credential_version: string
    logged_in: boolean
    username: string
    csrf_token: string
  }
}
