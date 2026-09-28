import type { FastifyInstance } from 'fastify'
import { registerAdminRoutes } from './modules/admin/router'
import { registerComponentCenterRoutes } from './modules/component-center/router'
import { registerGatewayAdmin } from './modules/gateway/routes'
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerAdminRoutes(app)
  await registerGatewayAdmin(app)
  await registerComponentCenterRoutes(app)
}
