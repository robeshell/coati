import { utcNowIso } from '@/common/serialize'
import type { Candidate, PublicRoute } from './pool-route'

export type EnvironmentFallback = { key: string; base: string; model: string }
export function environmentFallback(env: NodeJS.ProcessEnv = process.env): EnvironmentFallback | undefined {
  const key = (env.AGENT_LLM_KEY || env.AI_API_KEY || '').trim()
  const base = (env.AGENT_LLM_BASE || env.AI_API_BASE || '').trim().replace(/\/+$/, '')
  const model = (env.AGENT_LLM_MODEL || env.AI_MODEL || '').trim()
  return key && base && model ? { key, base, model } : undefined
}

/** ID zero is an in-memory selection sentinel, never a database account or foreign key. */
export function environmentCandidate(config: EnvironmentFallback, requested: string, secret: string, route?: PublicRoute): Candidate {
  const now = utcNowIso() + 'Z'
  return {
    route: {
      id: route?.id ?? 0, model: requested, upstream_id: 0, upstream_model: config.model,
      vision_model: null, priority: 1000, enabled: true, created_at: now,
      description: null, upstream_base: null, environment_fallback: true,
      ...(route ? { public_route: true, bound_upstream_id: route.upstream_id } : {}),
    },
    upstream: {
      id: 0, name: 'env-fallback', protocol: 'openai', provider: 'openai-compatible',
      base_url: config.base, secret, default_model: config.model, supported_models: [config.model],
      enabled: true, scope: 'platform', owner_user_id: null, model_prefix: '', priority: 0,
      weight: 1, concurrency_limit: 0, request_timeout_seconds: 120, extra_headers: {},
      created_at: now, updated_at: now, health_status: 'unknown', consecutive_failures: 0,
      api_key_hint: null, key_fingerprint: null, last_used_at: null, last_checked_at: null,
      last_success_at: null, last_error_at: null, last_latency_ms: null, proxy_secret: null,
      proxy_hint: null, note: null, probe_token: null, probe_expires_at: null, last_probe_at: null,
      last_probe_status: null, last_probe_latency_ms: null, cooldown_until: null,
      health_observed_at: null, last_error: null,
    },
  }
}
