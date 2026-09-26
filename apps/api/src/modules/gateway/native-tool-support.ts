import { createHash } from 'node:crypto'
import type { gw_upstreams } from '@/db/schema/gateway'

type Upstream = typeof gw_upstreams.$inferSelect
const registries = new WeakMap<object, Map<string, boolean>>()
type Capability = 'web-search' | 'web-fetch'
function fingerprint(upstream: Upstream, capability: Capability) {
  // Configuration changes invalidate observations; health timestamps do not.
  return createHash('sha256').update(JSON.stringify([
    capability, upstream.id, upstream.protocol, upstream.base_url, upstream.secret,
    upstream.extra_headers, upstream.proxy_secret,
  ])).digest('hex')
}
/** Process-local observations, never a durable promise about provider capability. */
export function nativeToolSupport(database: object, upstream: Upstream, capability: Capability = 'web-search'): boolean | undefined {
  return registries.get(database)?.get(fingerprint(upstream, capability))
}
export function recordNativeToolSupport(database: object, upstream: Upstream, executes: boolean, capability: Capability = 'web-search') {
  let registry = registries.get(database)
  if (!registry) registries.set(database, registry = new Map())
  const key = fingerprint(upstream, capability)
  registry.delete(key)
  registry.set(key, executes)
  if (registry.size > 10000) registry.delete(registry.keys().next().value!)
}
