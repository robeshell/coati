import type {
  gw_public_routes,
  gw_routes,
  gw_upstreams,
} from '@/db/schema/gateway'
import { supportsModel } from './account-models'
export type PublicRoute = typeof gw_public_routes.$inferSelect
export type Account = typeof gw_upstreams.$inferSelect
export type ResolvedRoute = typeof gw_routes.$inferSelect & {
  capability?: import('./capability-route').SearchCapability
  automatic_pool?: boolean
  environment_fallback?: boolean
  personal_owner?: number
  public_route?: boolean
  bound_upstream_id?: number | null
}
export type Candidate = { route: ResolvedRoute; upstream: Account }
// A public route describes one alias, not one candidate account.
export function poolRoute(
  route: PublicRoute,
  account: Account,
  needsVision = false,
): ResolvedRoute | null {
  if (
    !route.enabled ||
    !account.enabled ||
    account.scope !== 'platform' ||
    account.owner_user_id !== null
  )
    return null
  const primary = route.upstream_id === account.id
  if (route.upstream_id !== null && !primary && !route.fallback_enabled)
    return null
  const target = needsVision
    ? route.vision_model
    : route.upstream_model || route.model
  if (!target || !supportsModel(account, target)) return null
  return {
    ...route,
    upstream_id: account.id,
    upstream_model: route.upstream_model || route.model,
    priority: primary ? -1 : 1000 - account.priority,
    upstream_base: primary ? route.upstream_base : null,
    public_route: true,
    bound_upstream_id: route.upstream_id,
  }
}

/** Direct model names resolve through the platform pool without persisting a route. */
export function automaticRoute(account: Account, model: string): ResolvedRoute | null {
  if (!account.enabled || account.scope !== 'platform' || account.owner_user_id !== null || !supportsModel(account, model)) return null
  return { id: account.id, upstream_id: account.id, model, upstream_model: model,
    vision_model: null, priority: 1000 - account.priority, enabled: true,
    description: null, upstream_base: null, created_at: account.created_at, automatic_pool: true }
}
