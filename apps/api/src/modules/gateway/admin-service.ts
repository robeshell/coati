import { z } from 'zod'
import type { GatewayService } from './service'
import { GatewayError } from './schema'
import { listLegacyAccounts } from './legacy-account-list'
import { listLegacyRoutes } from './legacy-route-list'
import { saveLegacyRoute, deleteLegacyRoute } from './legacy-route-write'
import { listAdminUsage } from './usage-admin'
import { adminUsageAnalytics, personalUsageAnalytics } from './usage-analytics'
import { listQuotas, updateQuota } from './quotas'

/** Management use cases. HTTP handlers keep authentication and response serialization. */
export class GatewayAdminService {
  constructor(private readonly gateway: GatewayService) {}
  accounts(query: unknown, owner?: number) { return listLegacyAccounts(this.gateway.repo, query, owner) }
  deleteAccount(id: number, owner?: number) { return this.gateway.repo.deleteAccount(id, owner) }
  copyAccount(id: number) { return this.gateway.repo.copyPlatformAccount(id) }
  deletePersonalChannel(owner: number, id: number) { return this.gateway.repo.deletePersonalChannel(owner, id) }
  legacyRoutes(query: unknown) { return listLegacyRoutes(this.gateway.repo, query) }
  saveLegacyRoute(body: unknown, id?: number) { return saveLegacyRoute(this.gateway.repo, body, this.gateway.options.allowPrivate, id) }
  deleteLegacyRoute(id: number) { return deleteLegacyRoute(this.gateway.repo, id) }
  publicRoutes() { return this.gateway.repo.publicRoutes() }
  deletePublicRoute(id: number) { return this.gateway.repo.deletePublicRoute(id) }
  routes() { return this.gateway.repo.routes() }
  usage(query: unknown) { return listAdminUsage(this.gateway.repo, query) }
  analytics(query: unknown) { return adminUsageAnalytics(this.gateway.repo, query) }
  personalAnalytics(owner: number, query: unknown) { return personalUsageAnalytics(this.gateway.repo, owner, query) }
  quotas(query: unknown) { return listQuotas(this.gateway.repo, query) }
  updateQuota(owner: number, body: unknown) { return updateQuota(this.gateway.repo, owner, body) }
  async revokeKey(id: number, owner: number) {
    const row = await this.gateway.repo.revoke(id, owner)
    if (!row) throw new GatewayError(404, '令牌不存在')
    return row
  }
  async disable(resource: 'upstreams' | 'routes', id: number) {
    const row = await this.gateway.repo.disable(resource, id)
    if (!row) throw new GatewayError(404, '资源不存在')
    return { success: true }
  }
  requests(page: unknown) {
    return this.gateway.repo.listRequests(z.coerce.number().int().min(1).max(100000).parse(page || 1))
  }
  async request(id: unknown) {
    const row = await this.gateway.repo.requestById(z.string().uuid().parse(id))
    if (!row) throw new GatewayError(404, '请求不存在')
    return row
  }
  attempts(id: unknown) { return this.gateway.repo.attempts(z.string().uuid().parse(id)) }
  overview() { return this.gateway.repo.summary() }
}
