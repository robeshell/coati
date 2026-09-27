import { utcNowIso } from '@/common/serialize'
import {
  createHash,
  createHmac,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto'
import type { Pool } from 'pg'
import { CredentialVault } from './crypto'
export const legacyTables = [
  'admin_users',
  'roles',
  'menus',
  'user_roles',
  'role_menus',
  'agent_pat',
  'agent_usage_event',
  'agent_user_quota',
  'agent_llm_credential',
  'agent_route_config',
  'agent_model_profile',
  'agent_cache_test',
] as const
export type LegacyArchive = {
  format: 'coati-python-v1'
  created_at: string
  tables: Record<string, Record<string, unknown>[]>
}
const MAX_BYTES = 128 * 1024 * 1024
/** Snapshot is read-only even if the supplied database role has write permissions. */
export async function exportLegacy(pool: Pool): Promise<LegacyArchive> {
  const connection = await pool.connect()
  try {
    await connection.query('begin isolation level repeatable read read only')
    await connection.query("set local statement_timeout='60s'")
    const tables: LegacyArchive['tables'] = {}
    let bytes = 0
    for (const name of legacyTables) {
      // Names are compile-time allowlisted; no caller-controlled SQL identifiers.
      await connection.query(
        `declare legacy_rows no scroll cursor for select row_to_json(t) as payload from "${name}" t`,
      )
      const rows: Record<string, unknown>[] = []
      while (true) {
        const batch = await connection.query<{
          payload: Record<string, unknown>
        }>('fetch 100 from legacy_rows')
        if (!batch.rows.length) break
        for (const { payload } of batch.rows) {
          bytes += Buffer.byteLength(JSON.stringify(payload))
          if (bytes > MAX_BYTES)
            throw new Error(
              'Legacy archive exceeds 128 MiB limit; use a controlled offline migration for larger history',
            )
          rows.push(payload)
        }
      }
      await connection.query('close legacy_rows')
      tables[name] = rows
    }
    await connection.query('commit')
    return {
      format: 'coati-python-v1',
      created_at: utcNowIso(new Date()) + 'Z',
      tables,
    }
  } catch (error) {
    await connection.query('rollback')
    throw error
  } finally {
    connection.release()
  }
}
export function sealLegacy(archive: LegacyArchive, key: string) {
  if (key.length < 32)
    throw new Error('Archive key must contain at least 32 characters')
  return JSON.stringify({
    format: 'coati-encrypted-archive-v1',
    payload: new CredentialVault(key).encrypt(JSON.stringify(archive)),
  })
}
export function openLegacy(raw: string, key: string): LegacyArchive {
  if (Buffer.byteLength(raw) > MAX_BYTES * 2)
    throw new Error('Archive exceeds size limit')
  try {
    const envelope = JSON.parse(raw)
    if (
      envelope.format !== 'coati-encrypted-archive-v1' ||
      typeof envelope.payload !== 'string'
    )
      throw new Error()
    const archive = JSON.parse(
      new CredentialVault(key).decrypt(envelope.payload),
    )
    if (
      archive.format !== 'coati-python-v1' ||
      !archive.tables ||
      typeof archive.tables !== 'object'
    )
      throw new Error()
    if (
      Object.keys(archive.tables).some(
        (name) => !legacyTables.includes(name as (typeof legacyTables)[number]),
      )
    )
      throw new Error()
    for (const name of legacyTables)
      if (
        !Array.isArray(archive.tables[name]) ||
        archive.tables[name].some(
          (row: unknown) =>
            !row || typeof row !== 'object' || Array.isArray(row),
        )
      )
        throw new Error()
    return archive as LegacyArchive
  } catch {
    throw new Error('Invalid archive or archive key')
  }
}
/** Python credential_crypto.py: SHA256 material -> Fernet signing/encryption halves. */
export function decryptLegacySecret(value: string, material: string): string {
  if (!value.startsWith('enc:v1:'))
    throw new Error('Legacy plaintext credential requires explicit handling')
  try {
    if (!material.trim()) throw new Error()
    const token = Buffer.from(value.slice(7), 'base64url'),
      key = createHash('sha256').update(material.trim()).digest()
    if (token.length < 73 || token[0] !== 0x80) throw new Error()
    const signed = token.subarray(0, -32),
      mac = token.subarray(-32)
    if (
      !timingSafeEqual(
        createHmac('sha256', key.subarray(0, 16)).update(signed).digest(),
        mac,
      )
    )
      throw new Error()
    const decipher = createDecipheriv(
      'aes-128-cbc',
      key.subarray(16),
      token.subarray(9, 25),
    )
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat([
        decipher.update(token.subarray(25, -32)),
        decipher.final(),
      ]),
    )
  } catch {
    throw new Error('Unable to decrypt legacy credential')
  }
}
export function inspectLegacy(archive: LegacyArchive) {
  const counts = Object.fromEntries(
    legacyTables.map((name) => [name, archive.tables[name]!.length]),
  )
  const blockers: { table: string; id: unknown; reason: string }[] = []
  const users = new Set(archive.tables.admin_users!.map((row) => row.id))
  for (const row of archive.tables.admin_users!)
    if (
      typeof row.password_hash !== 'string' ||
      !/^pbkdf2:(sha256|sha512|sha1):[1-9][0-9]*\$[^$]+\$[0-9a-f]+$/.test(
        row.password_hash,
      )
    )
      blockers.push({
        table: 'admin_users',
        id: row.id,
        reason: 'Unsupported password hash; reset required',
      })
  for (const table of [
    'agent_pat',
    'agent_usage_event',
    'agent_user_quota',
    'agent_cache_test',
  ])
    for (const row of archive.tables[table]!)
      if (!users.has(row.user_id))
        blockers.push({ table, id: row.id, reason: 'Missing user reference' })
  for (const row of archive.tables.agent_llm_credential!) {
    if (row.scope === 'personal' && !users.has(row.owner_user_id))
      blockers.push({
        table: 'agent_llm_credential',
        id: row.id,
        reason: 'Missing personal owner',
      })
    if (typeof row.api_key !== 'string' || !row.api_key.startsWith('enc:v1:'))
      blockers.push({
        table: 'agent_llm_credential',
        id: row.id,
        reason: 'Credential is not encrypted in legacy format',
      })
  }
  return {
    format: archive.format,
    counts,
    blockers,
    import_ready: false,
    remaining: [
      'Run gateway:legacy-import dry-run against the empty migrated target database',
      'Review unresolved permission mappings and source/target counts',
      'Apply only after reviewing the dry-run report and retaining a source backup',
    ],
  }
}
