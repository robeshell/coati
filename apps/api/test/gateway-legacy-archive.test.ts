import { test, expect, afterAll } from 'vitest'
import pg from 'pg'
import { TEST_DATABASE_URL } from './helpers'
import {
  legacyTables,
  exportLegacy,
  sealLegacy,
  openLegacy,
  inspectLegacy,
  decryptLegacySecret,
} from '../src/modules/gateway/legacy-archive'
const pool = new pg.Pool({
  connectionString: TEST_DATABASE_URL,
  max: 1,
  options: '-c search_path=legacy_archive_fixture',
})
afterAll(async () => {
  await pool.query('drop schema if exists legacy_archive_fixture cascade')
  await pool.end()
})
test('consistent allowlisted snapshot encrypts all rows and reports migration blockers without leaking secrets', async () => {
  await pool.query('create schema legacy_archive_fixture')
  for (const name of legacyTables)
    await pool.query(
      `create table "${name}" (id integer,user_id integer,password_hash text,api_key text,scope text,owner_user_id integer)`,
    )
  await pool.query(
    "insert into admin_users(id,password_hash) values(1,'pbkdf2:sha256:1000$salt$abcd')",
  )
  await pool.query('insert into agent_pat(id,user_id) values(2,1)')
  await pool.query(
    "insert into agent_llm_credential(id,api_key,scope,owner_user_id) values(3,'fixture-plaintext','personal',9)",
  )
  const snapshot = await exportLegacy(pool),
    key = 'fixture-archive-key-32-characters-long'
  const encrypted = sealLegacy(snapshot, key)
  expect(encrypted).not.toContain('fixture-plaintext')
  expect(openLegacy(encrypted, key)).toEqual(snapshot)
  expect(() => openLegacy(encrypted, 'wrong')).toThrow('Invalid archive')
  const report = inspectLegacy(snapshot)
  expect(report.counts.admin_users).toBe(1)
  expect(report.blockers).toHaveLength(2)
  expect(JSON.stringify(report)).not.toContain('fixture-plaintext')
  expect(report.import_ready).toBe(false)
  expect(
    (await pool.query('select count(*) from admin_users')).rows[0].count,
  ).toBe('1')
})
test('Python cryptography Fernet fixture decrypts exactly and rejects tampering/wrong keys/plaintext', () => {
  const fixture =
    'enc:v1:gAAAAABqtzxMArbRZcY-OcMQgyBVAXhZksUB6peZ0Z3jJUiLqH5f62ZjXOpiK5DNN2228FDaWqqKruWTIsQqj55bDyNT-oO5CcHLDSsIFfX0u7JFe0SrGiM='
  expect(decryptLegacySecret(fixture, 'fixture-legacy-key')).toBe(
    'fixture-upstream-secret',
  )
  expect(() => decryptLegacySecret(fixture, 'wrong')).toThrow(
    'Unable to decrypt',
  )
  expect(() =>
    decryptLegacySecret(
      fixture.slice(0, -8) + 'AAAAAAAA',
      'fixture-legacy-key',
    ),
  ).toThrow()
  expect(() => decryptLegacySecret('plaintext', 'fixture-legacy-key')).toThrow()
})
