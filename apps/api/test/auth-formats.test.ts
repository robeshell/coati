import Fastify from 'fastify'
import secureSession from '@fastify/secure-session'
import { deriveSessionKey } from '@/app'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb } from '@/db/client'
import { admin_users, sessions } from '@/db/schema'
import { generatePasswordHash, checkPasswordHash, isPasswordHash } from '@/common/password'
import { buildTestApp, TEST_DATABASE_URL, testConfig } from './helpers'
import { bodyDifferences } from '../scripts/lib/openapi-body-sync'
import { gatewayAdminBody } from '@/modules/gateway/admin-body'

const oldApp = Fastify()
const handle = createDb(TEST_DATABASE_URL)
let app: Awaited<ReturnType<typeof buildTestApp>>, userId: number, hash: string
beforeAll(async () => {
  await oldApp.register(secureSession, { key: deriveSessionKey(testConfig().secretKey), cookieName: 'coati_session' })
  await oldApp.ready()
  hash = await generatePasswordHash('format-fixture-pass', 1000)
  const [user] = await handle.db.insert(admin_users).values({ username: 'cookie_format_fixture', password_hash: hash }).returning()
  userId = user!.id
  app = await buildTestApp()
})
afterAll(async () => {
  await handle.db.delete(admin_users).where(eq(admin_users.id, userId))
  await app.close()
  await oldApp.close()
  await handle.pool.end()
})
const cookieV1 = () => oldApp.encodeSecureSession(oldApp.createSecureSession({ logged_in: true, user_id: userId, csrf_token: 'format-csrf-fixture', credential_version: createHash('sha256').update(hash).digest('hex') }))
test('pre-upgrade PBKDF2 credentials still verify and are recognized by incremental seed', async () => {
  expect(isPasswordHash(hash)).toBe(true)
  expect(await checkPasswordHash(hash, 'format-fixture-pass')).toBe(true)
  expect(await checkPasswordHash(hash, 'wrong')).toBe(false)
})
test('cookie credentials resolve to server sessions and cannot recreate a revoked session', async () => {
  const cookie = cookieV1()
  const response = await app.inject({ url: '/api/admin/me', cookies: { coati_session: cookie } })
  expect(response.statusCode, response.body).toBe(200)
  const rows = await handle.db.select().from(sessions).where(eq(sessions.user_id, userId))
  expect(rows).toHaveLength(1)
  await handle.db.update(sessions).set({ revoked_at: '2026-01-01 00:00:00' }).where(eq(sessions.id, rows[0]!.id))
  expect((await app.inject({ url: '/api/admin/me', cookies: { coati_session: cookie } })).statusCode).toBe(401)
})
test('changed passwords invalidate a pre-upgrade cookie before it can be promoted', async () => {
  const cookie = cookieV1()
  await handle.db.update(admin_users).set({ password_hash: await generatePasswordHash('replacement', 1000) }).where(eq(admin_users.id, userId))
  expect((await app.inject({ url: '/api/admin/me', cookies: { coati_session: cookie } })).statusCode).toBe(401)
})
test('the empty provider value is a real enum member for disabling search', () => {
  const body = gatewayAdminBody('PUT', '/api/admin/gateway/web-search')!
  const differences = bodyDifferences({ schema: body.route.config.body, mode: 'create' }, { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { provider: { type: 'string', enum: ['', 'tavily'] } }, required: ['provider'] } } } } })
  expect(differences?.filter(d => d.field === 'provider')).toEqual([])
})
