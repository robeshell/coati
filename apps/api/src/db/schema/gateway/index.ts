import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  bigint,
} from 'drizzle-orm/pg-core'
import { admin_users } from '../admin/rbac'
const at = () =>
  timestamp({ withTimezone: true, mode: 'string' }).notNull().defaultNow()
export const gw_upstreams = pgTable('gw_upstreams', {
  id: serial().primaryKey(),
  name: text().notNull(),
  protocol: text().notNull(),
  base_url: text().notNull(),
  secret: text().notNull(),
  enabled: boolean().notNull().default(true),
  created_at: at(),
})
export const gw_routes = pgTable(
  'gw_routes',
  {
    id: serial().primaryKey(),
    model: text().notNull(),
    upstream_id: integer()
      .notNull()
      .references(() => gw_upstreams.id),
    upstream_model: text().notNull(),
    priority: integer().notNull().default(100),
    enabled: boolean().notNull().default(true),
    created_at: at(),
  },
  (t) => [index('gw_routes_model_idx').on(t.model)],
)
export const gw_keys = pgTable('gw_keys', {
  id: serial().primaryKey(),
  owner_id: integer()
    .notNull()
    .references(() => admin_users.id),
  name: text().notNull(),
  kind: text().notNull().default('personal'),
  digest: text().notNull().unique(),
  prefix: text().notNull(),
  models: jsonb().$type<string[]>().notNull(),
  daily_limit: bigint({ mode: 'number' }).notNull().default(0),
  concurrency_limit: integer().notNull().default(10),
  rpm_limit: integer().notNull().default(60),
  revoked: boolean().notNull().default(false),
  expires_at: timestamp({ withTimezone: true, mode: 'string' }),
  created_at: at(),
})
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
    error: text(),
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
export const gw_attempts = pgTable('gw_attempts', {
  id: serial().primaryKey(),
  request_id: text()
    .notNull()
    .references(() => gw_requests.id),
  upstream_id: integer()
    .notNull()
    .references(() => gw_upstreams.id),
  status: integer(),
  error: text(),
  duration_ms: integer().notNull(),
  created_at: at(),
}, t => [index('gw_attempts_request_idx').on(t.request_id)])
export const gw_devices = pgTable('gw_devices', {
  id: serial().primaryKey(),
  device_hash: text().notNull().unique(),
  user_code: text().notNull().unique(),
  owner_id: integer().references(() => admin_users.id),
  status: text().notNull().default('pending'),
  expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  created_at: at(),
})
