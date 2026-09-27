import { sql } from 'drizzle-orm'
import {
  pgTable,
  check,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  bigint,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { admin_users } from '../admin/rbac'
const at = () =>
  timestamp({ withTimezone: true, mode: 'string' }).notNull().defaultNow()
export const gw_upstreams = pgTable(
  'gw_upstreams',
  {
    api_key_hint: text(),
    key_fingerprint: text(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .defaultNow()
      .$onUpdate(() => sql`clock_timestamp()`),
    last_used_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_checked_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_success_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_error_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_latency_ms: integer(),
    proxy_secret: text(),
    proxy_hint: text(),
    request_timeout_seconds: integer().notNull().default(120),
    extra_headers: jsonb()
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    note: text(),
    scope: text().notNull().default('platform'),
    owner_user_id: integer().references(() => admin_users.id),
    model_prefix: text().notNull().default(''),
    priority: integer().notNull().default(100),
    supported_models: jsonb().$type<string[]>().notNull().default([]),
    default_model: text().notNull().default(''),
    provider: text().notNull().default('openai-compatible'),
    probe_token: text(),
    probe_expires_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_probe_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_probe_status: text(),
    last_probe_latency_ms: integer(),
    weight: integer().notNull().default(1),
    concurrency_limit: integer().notNull().default(10),
    health_status: text().notNull().default('unknown'),
    consecutive_failures: integer().notNull().default(0),
    cooldown_until: timestamp({ withTimezone: true, mode: 'string' }),
    health_observed_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_error: text(),
    id: serial().primaryKey(),
    name: text().notNull(),
    protocol: text().notNull(),
    base_url: text().notNull(),
    secret: text().notNull(),
    enabled: boolean().notNull().default(true),
    created_at: at(),
  },
  (t) => [
    check(
      'gw_upstreams_timeout_check',
      sql`${t.request_timeout_seconds} BETWEEN 5 AND 300`,
    ),
    index('gw_upstreams_owner_scope_idx').on(t.owner_user_id, t.scope),
    check(
      'gw_upstreams_scope_owner_check',
      sql`(${t.scope} = 'platform' AND ${t.owner_user_id} IS NULL AND ${t.model_prefix} = '') OR (${t.scope} = 'personal' AND ${t.owner_user_id} IS NOT NULL AND length(trim(${t.model_prefix})) > 0)`,
    ),
  ],
)
export const gw_routes = pgTable(
  'gw_routes',
  {
    description: text(),
    upstream_base: text(),
    id: serial().primaryKey(),
    model: text().notNull(),
    upstream_id: integer()
      .notNull()
      .references(() => gw_upstreams.id),
    upstream_model: text().notNull(),
    vision_model: text(),
    priority: integer().notNull().default(100),
    enabled: boolean().notNull().default(true),
    created_at: at(),
  },
  (t) => [index('gw_routes_model_idx').on(t.model)],
)
export const gw_public_routes = pgTable('gw_public_routes', {
  updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
  id: serial().primaryKey(),
  model: text().notNull().unique(),
  upstream_id: integer().references(() => gw_upstreams.id),
  upstream_model: text(),
  vision_model: text(),
  description: text(),
  upstream_base: text(),
  fallback_enabled: boolean().notNull().default(false),
  enabled: boolean().notNull().default(true),
  created_at: at(),
})
// Immutable source snapshots retain legacy IDs for rollback and historical lookup.
export const gw_route_migrations = pgTable('gw_route_migrations', {
  id: uuid().primaryKey().defaultRandom(),
  model: text().notNull(),
  version: text().notNull(),
  actor_id: integer().notNull(),
  source_routes: jsonb().$type<(typeof gw_routes.$inferSelect)[]>().notNull(),
  public_route: jsonb().$type<typeof gw_public_routes.$inferSelect>().notNull(),
  created_at: at(),
  rolled_back_at: timestamp({ withTimezone: true, mode: 'string' }),
  rolled_back_by: integer(),
})
export const gw_keys = pgTable(
  'gw_keys',
  {
    quota_group: uuid().notNull().defaultRandom(),
    rotated_from_id: integer().references((): AnyPgColumn => gw_keys.id),
    id: serial().primaryKey(),
    owner_id: integer()
      .notNull()
      .references(() => admin_users.id),
    note: text(),
    revoked_at: timestamp({ withTimezone: true, mode: 'string' }),
    last_used_at: timestamp({ withTimezone: true, mode: 'string' }),
    name: text().notNull(),
    kind: text().notNull().default('personal'),
    digest: text().notNull().unique(),
    prefix: text().notNull(),
    scopes: jsonb().$type<string[]>().notNull().default(['chat', 'profile']),
    models: jsonb().$type<string[]>().notNull(),
    daily_limit: bigint({ mode: 'number' }).notNull().default(0),
    concurrency_limit: integer().notNull().default(10),
    rpm_limit: integer().notNull().default(60),
    revoked: boolean().notNull().default(false),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }),
    created_at: at(),
  },
  (t) => [index('gw_keys_quota_group_idx').on(t.quota_group)],
)
export type ExecutionSnapshot = {
  route_kind?: 'public' | 'explicit' | 'personal' | 'environment' | 'pool'
  provider?: string
  route_name?: string
  route_id: number | null
  upstream_id: number | null
  upstream_name: string
  upstream_model: string
  upstream_protocol: string
}
export const gw_requests = pgTable(
  'gw_requests',
  {
    id: text().primaryKey(),
    key_id: integer()
      .notNull()
      .references(() => gw_keys.id),
    model: text().notNull(),
    protocol: text().notNull(),
    status: text().notNull().default('reserved'),
    reserved_tokens: bigint({ mode: 'number' }).notNull(),
    input_tokens: bigint({ mode: 'number' }).notNull().default(0),
    output_tokens: bigint({ mode: 'number' }).notNull().default(0),
    usage_source: text().notNull().default('estimated'),
    cache_read_tokens: bigint({ mode: 'number' }),
    cache_miss_tokens: bigint({ mode: 'number' }),
    cache_miss_source: text(),
    cache_write_tokens: bigint({ mode: 'number' }),
    cache_write_5m_tokens: bigint({ mode: 'number' }),
    cache_write_1h_tokens: bigint({ mode: 'number' }),
    reasoning_tokens: bigint({ mode: 'number' }),
    upstream_protocol: text(),
    raw_usage: jsonb().$type<Record<string, unknown>>(),
    execution: jsonb().$type<ExecutionSnapshot>(),
    request_context:
      jsonb().$type<
        import('../../../modules/gateway/request-context').RequestContext
      >(),
    error: text(),
    http_status: integer(),
    duration_ms: integer(),
    first_byte_ms: integer(),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    created_at: at(),
  },
  (t) => [
    index('gw_requests_key_time_idx').on(t.key_id, t.created_at),
    index('gw_requests_status_expiry_idx').on(t.status, t.expires_at),
    index('gw_requests_created_at_idx').on(t.created_at),
  ],
)
export const gw_attempts = pgTable(
  'gw_attempts',
  {
    id: serial().primaryKey(),
    request_id: text()
      .notNull()
      .references(() => gw_requests.id),
    upstream_id: integer().references(() => gw_upstreams.id, {
      onDelete: 'set null',
    }),
    execution: jsonb().$type<ExecutionSnapshot>(),
    status: integer(),
    error: text(),
    duration_ms: integer().notNull(),
    created_at: at(),
  },
  (t) => [index('gw_attempts_request_idx').on(t.request_id)],
)
export const gw_devices = pgTable('gw_devices', {
  id: serial().primaryKey(),
  device_hash: text().notNull().unique(),
  user_code: text().notNull().unique(),
  owner_id: integer().references(() => admin_users.id),
  status: text().notNull().default('pending'),
  expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  created_at: at(),
})

export const gw_upstream_leases = pgTable(
  'gw_upstream_leases',
  {
    request_id: text()
      .primaryKey()
      .references(() => gw_requests.id, { onDelete: 'cascade' }),
    upstream_id: integer()
      .notNull()
      .references(() => gw_upstreams.id, { onDelete: 'cascade' }),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [
    index('gw_upstream_leases_account_expiry_idx').on(
      t.upstream_id,
      t.expires_at,
    ),
  ],
)

export const gw_session_bindings = pgTable(
  'gw_session_bindings',
  {
    id: serial().notNull().unique(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    scope: text().primaryKey(),
    owner_id: integer()
      .notNull()
      .references(() => admin_users.id, { onDelete: 'cascade' }),
    model: text().notNull(),
    upstream_id: integer()
      .notNull()
      .references(() => gw_upstreams.id, { onDelete: 'cascade' }),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (t) => [index('gw_session_bindings_expiry_idx').on(t.expires_at)],
)

export const gw_user_limits = pgTable('gw_user_limits', {
  quota_updated_at: timestamp({ withTimezone: true, mode: 'string' }),
  owner_id: integer()
    .primaryKey()
    .references(() => admin_users.id, { onDelete: 'cascade' }),
  daily_limit: bigint({ mode: 'number' }),
  concurrency_limit: integer().notNull().default(0),
  rpm_limit: integer().notNull().default(0),
})

export const gw_device_rate_limits = pgTable(
  'gw_device_rate_limits',
  {
    identity: text().primaryKey(),
    started_at: at(),
    count: integer().notNull().default(1),
  },
  (t) => [index('gw_device_rate_limits_started_idx').on(t.started_at)],
)

export const gw_model_profiles = pgTable(
  'gw_model_profiles',
  {
    id: serial().primaryKey(),
    model_name: text().notNull().unique(),
    context_window_override: integer(),
    max_output_tokens_override: integer(),
    catalog_context_window: integer(),
    catalog_max_output_tokens: integer(),
    catalog_source: text(),
    catalog_synced_at: timestamp({ withTimezone: true, mode: 'string' }),
    enabled: boolean().notNull().default(true),
    note: text(),
    created_at: at(),
    updated_at: at().$onUpdate(() => sql`clock_timestamp()`),
  },
  (t) => [
    check(
      'gw_model_profile_token_limits',
      sql`
  (${t.context_window_override} IS NULL OR ${t.context_window_override} BETWEEN 1 AND 1000000) AND
  (${t.max_output_tokens_override} IS NULL OR ${t.max_output_tokens_override} BETWEEN 1 AND 1000000) AND
  (${t.catalog_context_window} IS NULL OR ${t.catalog_context_window} BETWEEN 1 AND 1000000) AND
  (${t.catalog_max_output_tokens} IS NULL OR ${t.catalog_max_output_tokens} BETWEEN 1 AND 1000000)`,
    ),
  ],
)

export const gw_cache_tests = pgTable('gw_cache_tests', {
  id: serial().primaryKey(),
  user_id: integer().notNull().references(() => admin_users.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  model: text().notNull(),
  prompt: text().notNull(),
  rounds: integer().notNull(),
  max_tokens: integer().notNull(),
  status: text().notNull(),
  summary: jsonb().$type<Record<string, unknown>>().notNull(),
  results: jsonb().$type<Record<string, unknown>[]>().notNull(),
  error_summary: text(),
  created_at: at(),
}, t => [index('gw_cache_tests_owner_time_idx').on(t.user_id, t.created_at)])

export type SearchSettingsOverrides = {
  provider?: string
  api_key?: string
  proxy_url?: string
  timeout_seconds?: number
}
export const gw_search_settings = pgTable('gw_search_settings', {
  id: integer().primaryKey(),
  config: jsonb().$type<SearchSettingsOverrides>().notNull().default({}),
  updated_at: at(),
}, t => [check('gw_search_settings_singleton',sql`${t.id}=1`)])

export const gw_legacy_imports = pgTable('gw_legacy_imports', {
  checksum: text().primaryKey(),
  counts: jsonb().$type<Record<string, number>>().notNull(),
  id_map: jsonb().$type<Record<string, unknown>>().notNull(),
  created_at: at(),
})
