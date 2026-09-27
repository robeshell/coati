import { createDb } from '../src/db/client'
import { CredentialVault } from '../src/modules/gateway/crypto'
import { rotateCredentials } from '../src/modules/gateway/credential-rotation'

const args = process.argv.slice(2)
if (args.some((arg) => !['--apply', '--offline'].includes(arg)))
  throw new Error('Usage: rotate-gateway-key [--apply --offline]')
const apply = args.includes('--apply')
if (apply && !args.includes('--offline'))
  throw new Error(
    'Stop all API and worker replicas first, then specify --apply --offline',
  )
const database = process.env.ROTATION_DATABASE_URL
const oldKey = process.env.ROTATION_OLD_KEY,
  newKey = process.env.ROTATION_NEW_KEY
if (!database || !oldKey || !newKey || oldKey === newKey)
  throw new Error(
    'Distinct ROTATION_OLD_KEY/ROTATION_NEW_KEY and explicit ROTATION_DATABASE_URL are required',
  )
const handle = createDb(database)
try {
  const previous = JSON.parse(
    process.env.ROTATION_PREVIOUS_KEYS || '[]',
  ) as string[]
  console.log(
    JSON.stringify(
      await rotateCredentials(
        handle.db,
        new CredentialVault(oldKey, previous),
        new CredentialVault(newKey),
        apply,
      ),
    ),
  )
} catch {
  console.error(
    'Rotation failed; transaction rolled back. Check database availability and source key set. No credential values are printed.',
  )
  process.exitCode = 1
} finally {
  await handle.pool.end()
}
