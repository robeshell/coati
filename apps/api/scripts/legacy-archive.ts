import { readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'
import {
  exportLegacy,
  sealLegacy,
  openLegacy,
  inspectLegacy,
} from '../src/modules/gateway/legacy-archive'
const [mode, path, ...extra] = process.argv.slice(2)
if (!['export', 'inspect'].includes(mode ?? '') || !path || extra.length)
  throw new Error('Usage: legacy-archive export|inspect FILE')
const key = process.env.LEGACY_ARCHIVE_KEY
if (!key) throw new Error('LEGACY_ARCHIVE_KEY is required')
try {
  if (mode === 'export') {
    if (!process.env.LEGACY_SOURCE_DATABASE_URL)
      throw new Error('Source database required')
    const pool = new pg.Pool({
      connectionString: process.env.LEGACY_SOURCE_DATABASE_URL,
      max: 1,
    })
    try {
      const archive = await exportLegacy(pool)
      await writeFile(path, sealLegacy(archive, key), {
        flag: 'wx',
        mode: 0o600,
      })
      console.log(JSON.stringify(inspectLegacy(archive)))
    } finally {
      await pool.end()
    }
  } else
    console.log(
      JSON.stringify(
        inspectLegacy(openLegacy(await readFile(path, 'utf8'), key)),
      ),
    )
} catch {
  console.error(
    'Legacy archive operation failed. Check source schema, archive key and output path. No source data was changed; existing files are never overwritten.',
  )
  process.exitCode = 1
}
