import { LegacyPermissionError } from '../src/modules/gateway/legacy-import'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { openLegacy } from '../src/modules/gateway/legacy-archive'
import {
  planLegacyImport,
  importLegacy,
} from '../src/modules/gateway/legacy-import'
const [file, ...args] = process.argv.slice(2)
if (!file || args.some((arg) => !['--apply', '--offline'].includes(arg)))
  throw new Error('Usage: legacy-import ARCHIVE [--apply --offline]')
if (args.includes('--apply') && !args.includes('--offline'))
  throw new Error('Stop all target processes and use --apply --offline')
const {
  LEGACY_ARCHIVE_KEY,
  LEGACY_SOURCE_ENCRYPTION_KEY,
  LEGACY_TARGET_ENCRYPTION_KEY,
  LEGACY_TARGET_DATABASE_URL,
  LEGACY_PERMISSION_MAP_FILE,
} = process.env
if (
  !LEGACY_ARCHIVE_KEY ||
  !LEGACY_SOURCE_ENCRYPTION_KEY ||
  !LEGACY_TARGET_ENCRYPTION_KEY ||
  !LEGACY_TARGET_DATABASE_URL
)
  throw new Error(
    'Explicit archive/source/target keys and target database URL are required',
  )
const pool = new pg.Pool({
  connectionString: LEGACY_TARGET_DATABASE_URL,
  max: 1,
})
try {
  const map = LEGACY_PERMISSION_MAP_FILE
    ? JSON.parse(await readFile(LEGACY_PERMISSION_MAP_FILE, 'utf8'))
    : {}
  const archive = openLegacy(await readFile(file, 'utf8'), LEGACY_ARCHIVE_KEY)
  const plan = planLegacyImport(
    archive,
    LEGACY_SOURCE_ENCRYPTION_KEY,
    LEGACY_TARGET_ENCRYPTION_KEY,
    map,
  )
  console.log(
    JSON.stringify(await importLegacy(pool, plan, args.includes('--apply'))),
  )
} catch (error) {
  if(error instanceof LegacyPermissionError)console.error(error.message)
  console.error(
    'Import failed and table changes were rolled back. Check the archive preflight, explicit permission mapping, source key, and an empty migrated target. No credential values are printed.',
  )
  process.exitCode = 1
} finally {
  await pool.end()
}
