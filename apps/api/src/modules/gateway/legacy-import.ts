import { accountHeadersSchema } from './account-headers'
import { object } from './protocol/compat-helpers'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import { MENUS_DATA } from '../../../scripts/seed-rbac'
import { CredentialVault } from './crypto'
import {
  decryptLegacySecret,
  inspectLegacy,
  type LegacyArchive,
} from './legacy-archive'
export class LegacyPermissionError extends Error {}
type Row = Record<string, unknown>
const targets = [
  'admin_users',
  'roles',
  'menus',
  'user_roles',
  'role_menus',
  'gw_upstreams',
  'gw_public_routes',
  'gw_model_profiles',
  'gw_keys',
  'gw_user_limits',
  'gw_requests',
  'gw_cache_tests',
] as const
const prefixes: Record<string, string> = {
  agent_device_confirm_action: 'gateway_device_confirm_action',
  agent_device_confirm: 'gateway_device_confirm',
  agent_llm_keys: 'gateway_upstreams',
  agent_routes: 'gateway_routes',
  agent_tokens: 'gateway_keys',
  agent_pat: 'gateway_keys',
  agent_usage_quota_edit: 'gateway_requests_quota_edit',
  agent_usage: 'gateway_requests',
  agent_my_usage: 'gateway_my_usage',
  agent_ops_dashboard: 'gateway_overview',
  agent_my_channels: 'gateway_my_channels',
  agent_model_profiles: 'gateway_model_profiles',
  agent_cache_test: 'gateway_cache_tests',
  agent_websearch: 'gateway_websearch',
}
const protocol = (value: unknown) =>
  ({
    'openai-chat': 'openai',
    'openai-responses': 'responses',
    'anthropic-messages': 'anthropic',
  })[String(value)] ?? String(value || 'openai')
const parse = (raw: unknown, fallback: unknown) =>
  typeof raw === 'string' ? JSON.parse(raw) : (raw ?? fallback)
const stamp = (value: unknown) =>
  typeof value === 'string'
    ? /(?:Z|[+-]\d\d:\d\d)$/.test(value)
      ? value
      : value + 'Z'
    : undefined
function menuCode(code: string) {
  for (const prefix of Object.keys(prefixes).sort(
    (a, b) => b.length - a.length,
  ))
    if (code === prefix || code.startsWith(prefix + '_'))
      return prefixes[prefix] + code.slice(prefix.length)
  return code
}
export function planLegacyImport(
  archive: LegacyArchive,
  sourceKey: string,
  targetKey: string,
  permissionMap: Record<string, string | null> = {},
) {
  const report = inspectLegacy(archive)
  if (report.blockers.length)
    throw new Error('Source archive contains unresolved blockers')
  const tables: Record<string, Row[]> = Object.fromEntries(
    targets.map((name) => [name, []]),
  )
  const source = archive.tables,
    vault = new CredentialVault(targetKey),
    menuIds: Record<string, number | null> = {}
  const byCode = new Map(MENUS_DATA.map((row) => [row.code, row.id]))
  for (const row of source.menus!) {
    const code = String(row.code),
      mapped = Object.hasOwn(permissionMap, code)
        ? permissionMap[code]
        : menuCode(code)
    menuIds[String(row.id)] =
      mapped === null ? null : (byCode.get(mapped!) ?? null)
  }
  const roleIds = new Set(source.roles!.map((row) => row.id)),
    userIds = new Set(source.admin_users!.map((row) => row.id))
  const supers = new Set(
    source
      .roles!.filter((row) => row.code === 'super_admin')
      .map((row) => row.id),
  )
  for (const row of source.admin_users!)
    tables.admin_users!.push({
      id: row.id,
      username: row.username,
      password_hash: row.password_hash,
      created_at: stamp(row.created_at),
    })
  for (const row of source.roles!)
    tables.roles!.push({
      id: row.id,
      name: row.name,
      code: row.code,
      description: row.description,
      created_at: stamp(row.created_at),
    })
  for (const row of MENUS_DATA) tables.menus!.push({ ...row, parent_id: null })
  for (const row of source.user_roles!) {
    if (!userIds.has(row.user_id) || !roleIds.has(row.role_id))
      throw new Error('Invalid user role reference')
    tables.user_roles!.push({ user_id: row.user_id, role_id: row.role_id })
  }
  const granted = new Set<string>()
  const grant = (role: unknown, menu: number) => {
    const code = `${role}:${menu}`
    if (!granted.has(code)) {
      granted.add(code)
      tables.role_menus!.push({ role_id: role, menu_id: menu })
    }
  }
  for (const row of source.role_menus!) {
    if (!roleIds.has(row.role_id)) throw new Error('Invalid role reference')
    if (supers.has(row.role_id)) continue
    const original = source.menus!.find((menu) => menu.id === row.menu_id)
    if (!original) throw new Error('Invalid menu reference')
    const mapped = menuIds[String(row.menu_id)]
    if (mapped == null) {
      if (permissionMap[String(original.code)] !== null)
        throw new LegacyPermissionError(`Unmapped permission: ${/^[a-z0-9_]{1,100}$/.test(String(original.code)) ? String(original.code) : '[invalid code]'}`)
    } else grant(row.role_id, mapped)
  }
  for (const role of supers) for (const menu of MENUS_DATA) grant(role, menu.id)
  for (const row of source.agent_llm_credential!) {
    const parsedModels = parse(row.models_json, [])
    if (!Array.isArray(parsedModels) || parsedModels.some(model => typeof model !== 'string'))
      throw new Error('Invalid legacy account models')
    const models = [...new Set(parsedModels as string[])]
    const headers = accountHeadersSchema.safeParse(parse(row.extra_headers_json, {}))
    if (!headers.success) throw new Error('Invalid legacy account headers')
    if (!['platform','personal'].includes(String(row.scope ?? 'platform')) ||
        (row.scope === 'personal' && !userIds.has(row.owner_user_id)))
      throw new Error('Invalid legacy account owner or scope')
    if (row.default_model && !models.includes(String(row.default_model)))
      models.unshift(String(row.default_model))
    tables.gw_upstreams!.push({
      id: row.id,
      name: row.name,
      protocol: protocol(row.upstream_protocol),
      base_url: row.base_url,
      provider: row.provider ?? 'openai-compatible',
      secret: vault.encrypt(
        decryptLegacySecret(String(row.api_key), sourceKey),
      ),
      proxy_secret: row.proxy_url
        ? vault.encrypt(decryptLegacySecret(String(row.proxy_url), sourceKey))
        : null,
      api_key_hint: row.api_key_hint,
      key_fingerprint: row.key_fingerprint,
      supported_models: models,
      default_model: row.default_model ?? '',
      priority: row.priority ?? 100,
      weight: row.weight ?? 100,
      request_timeout_seconds: row.request_timeout_seconds ?? 120,
      enabled: row.enabled !== false,
      note: row.note,
      scope: row.scope ?? 'platform',
      owner_user_id: row.owner_user_id ?? null,
      model_prefix: row.model_prefix ?? '',
      extra_headers: headers.data,
      created_at: stamp(row.created_at),
      updated_at: stamp(row.updated_at),
    })
  }
  for (const row of source.agent_route_config!)
    tables.gw_public_routes!.push({
      id: row.id,
      model: row.model_name,
      upstream_id: row.credential_id,
      upstream_model: row.upstream_model,
      vision_model: row.vision_model,
      description: row.description,
      upstream_base: row.upstream_base,
      fallback_enabled: row.fallback_enabled ?? false,
      enabled: row.enabled !== false,
      created_at: stamp(row.created_at),
      updated_at: stamp(row.updated_at),
    })
  for (const row of source.agent_model_profile!)
    tables.gw_model_profiles!.push({
      id: row.id,
      model_name: row.model_name,
      context_window_override: row.context_window_override ?? null,
      max_output_tokens_override: row.max_output_tokens_override ?? null,
      catalog_source: row.litellm_model_name
        ? 'python:' + String(row.litellm_model_name)
        : 'python',
      catalog_context_window: row.litellm_context_window ?? row.context_window,
      catalog_max_output_tokens:
        row.litellm_max_output_tokens ?? row.max_output_tokens,
      catalog_synced_at: stamp(row.litellm_synced_at),
      enabled: row.enabled !== false,
      note: row.note,
      created_at: stamp(row.created_at),
      updated_at: stamp(row.updated_at),
    })
  const patIds = new Map<number, number>(),
    historyKeys = new Map<unknown, number>()
  let nextId =
    source.agent_pat!.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  for (const row of source.agent_pat!) {
    if (!/^[a-f0-9]{64}$/.test(String(row.token_hash)))
      throw new Error('Unsupported legacy token digest')
    const scopes = parse(row.scopes_json, []) as string[]
    if (
      !Array.isArray(scopes) ||
      scopes.some((scope) => !['chat', 'profile'].includes(scope))
    )
      throw new Error('Unsupported legacy token scope')
    patIds.set(Number(row.id), Number(row.user_id))
    tables.gw_keys!.push({
      id: row.id,
      owner_id: row.user_id,
      name: row.name,
      kind: row.token_type ?? 'personal',
      digest: row.token_hash,
      prefix: row.token_prefix,
      scopes,
      models: ['*'],
      revoked: Boolean(row.revoked_at),
      revoked_at: stamp(row.revoked_at),
      expires_at: stamp(row.expires_at),
      created_at: stamp(row.created_at),
      note: row.note,
    })
  }
  for (const row of source.agent_user_quota!)
    tables.gw_user_limits!.push({
      owner_id: row.user_id,
      daily_limit: row.daily_token_quota,
      quota_updated_at: stamp(row.updated_at),
    })
  for (const row of source.agent_usage_event!) {
    let key =
      row.pat_id != null &&
      patIds.get(Number(row.pat_id)) === Number(row.user_id)
        ? Number(row.pat_id)
        : historyKeys.get(row.user_id)
    if (!key) {
      key = nextId++
      historyKeys.set(row.user_id, key)
      tables.gw_keys!.push({
        id: key,
        owner_id: row.user_id,
        name: 'Imported historical usage',
        kind: 'personal',
        digest: createHash('sha256').update(randomBytes(32)).digest('hex'),
        prefix: 'legacy-history',
        scopes: [],
        models: [],
        revoked: true,
      })
    }
    tables.gw_requests!.push({
      id: row.request_id,
      key_id: key,
      model: row.model ?? 'unknown',
      protocol: protocol(row.inbound_protocol),
      status:
        row.status === 'reserved' ? 'interrupted' : (row.status ?? 'unknown'),
      reserved_tokens: 0,
      input_tokens: row.prompt_tokens ?? 0,
      output_tokens: row.completion_tokens ?? 0,
      usage_source: 'estimated',
      cache_read_tokens: row.cache_read_tokens ?? null,
      cache_write_tokens: row.cache_write_tokens ?? null,
      cache_miss_tokens: row.cache_miss_tokens ?? null,
      http_status: row.http_status ?? null,
      error: row.error_summary,
      duration_ms: row.latency_ms,
      expires_at: stamp(row.created_at) ?? archive.created_at,
      created_at: stamp(row.created_at),
      raw_usage: {
        legacy_id: row.id,
        legacy_total_tokens: row.total_tokens,
        legacy_credential_id: row.credential_id,
        legacy_route_id: row.route_id,
        legacy_parent_request_id: row.parent_request_id,
        legacy_attempt_count: row.attempt_count,
        legacy_source: row.source,
      },
      request_context: {
        session_id: row.session_id,
        client_request_id: row.client_request_id,
        parent_request_id: row.parent_request_id,
        step_index: row.step_index,
        retry_index: row.retry_index,
        context_tokens_estimate: row.context_tokens_estimate ?? 0,
        context_bytes: row.context_bytes ?? 0,
        message_count: row.message_count ?? 0,
        tool_count: row.tool_count ?? 0,
        image_count: row.image_count ?? 0,
        tool_result_bytes: row.tool_result_bytes ?? 0,
        largest_message_bytes: row.largest_message_bytes ?? 0,
      },
    })
  }
  for (const row of source.agent_cache_test!) {
    const summary = object(parse(row.summary_json, {}))
    const rounds = parse(row.rounds_json, [])
    const results = (Array.isArray(rounds) ? rounds : []).map(raw => {
      const round = object(raw)
      return {...round, status: round.status,
        input_tokens: round.prompt_tokens ?? null, output_tokens: round.completion_tokens ?? null,
        upstream_id: round.credential_id ?? null, upstream_name: round.credential_name ?? null,
        cache_status: round.cache_read_tokens != null && round.cache_miss_tokens != null ? 'complete' :
          [round.cache_read_tokens,round.cache_write_tokens,round.cache_miss_tokens].some(value => value != null) ? 'partial' : 'unreported',
        cache_miss_source: round.cache_ratio_source === 'derived' ? 'derived' : null,
        legacy: raw,
      }
    })
    tables.gw_cache_tests!.push({
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      model: row.model,
      prompt: row.prompt,
      rounds: row.rounds,
      max_tokens: row.max_tokens,
      status: row.status,
      summary: {...summary,
        completed_rounds: summary.rounds_ok ?? results.filter(round=>round.status==='ok').length,
        attempted_rounds: summary.rounds_total ?? results.length,
        hit_ratio: summary.overall_hit_ratio ?? null,
        legacy: summary,
      },
      results,
      error_summary: row.error_summary,
      created_at: stamp(row.created_at),
    })
  }
  return {
    checksum: createHash('sha256')
      .update(JSON.stringify(archive))
      .digest('hex'),
    tables,
    counts: Object.fromEntries(
      targets.map((name) => [name, tables[name]!.length]),
    ),
    id_map: { menus: menuIds, history_keys: Object.fromEntries(historyKeys) },
  }
}
export async function importLegacy(
  pool: Pool,
  plan: ReturnType<typeof planLegacyImport>,
  apply = false,
) {
  const connection = await pool.connect()
  try {
    await connection.query('begin')
    await connection.query("set local lock_timeout='5s'")
    await connection.query('select pg_advisory_xact_lock(1129271636)')
    const existing = await connection.query(
      'select checksum from gw_legacy_imports where checksum=$1',
      [plan.checksum],
    )
    if (existing.rowCount) {
      await connection.query('rollback')
      return { applied: false, already_imported: true, counts: plan.counts }
    }
    await connection.query(
      `lock table ${targets.map((name) => '"' + name + '"').join(',')} in exclusive mode`,
    )
    for (const name of targets)
      if ((await connection.query(`select 1 from "${name}" limit 1`)).rowCount)
        throw new Error(
          'Import requires an empty migrated Node database, before RBAC bootstrap',
        )
    for (const name of targets)
      for (const raw of plan.tables[name]!) {
        const entries = Object.entries(raw).filter(
          ([, value]) => value !== undefined,
        )
        // Keys originate only from the fixed plan builder above.
        await connection.query(
          `insert into "${name}" (${entries.map(([key]) => '"' + key + '"').join(',')}) values (${entries.map((_, i) => '$' + (i + 1)).join(',')})`,
          entries.map(([, value]) =>
            value !== null && typeof value === 'object'
              ? JSON.stringify(value)
              : value,
          ),
        )
      }
    for (const row of MENUS_DATA)
      if (row.parent_id != null)
        await connection.query('update menus set parent_id=$1 where id=$2', [
          row.parent_id,
          row.id,
        ])
    if (apply) {
      for (const name of [
        'admin_users',
        'roles',
        'menus',
        'gw_upstreams',
        'gw_public_routes',
        'gw_model_profiles',
        'gw_keys',
        'gw_cache_tests',
      ])
        await connection.query(
          `select setval(pg_get_serial_sequence('${name}','id'),coalesce((select max(id) from "${name}"),0)+1,false)`,
        )
      await connection.query(
        'insert into gw_legacy_imports(checksum,counts,id_map) values($1,$2,$3)',
        [
          plan.checksum,
          JSON.stringify(plan.counts),
          JSON.stringify(plan.id_map),
        ],
      )
    }
    await connection.query(apply ? 'commit' : 'rollback')
    return {
      applied: apply,
      already_imported: false,
      counts: plan.counts,
      id_map: plan.id_map,
    }
  } catch (error) {
    await connection.query('rollback')
    throw error
  } finally {
    connection.release()
  }
}
