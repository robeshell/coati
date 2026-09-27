import { afterAll, beforeAll, expect, test } from 'vitest'
import { eq, like } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { GatewayService, gatewayOptions } from '../src/modules/gateway/service'
import type { KeyRow } from '../src/modules/gateway/repository'
import { ModelProfileRepository } from '../src/modules/gateway/model-profile-repository'
import { saveProfile } from '../src/modules/gateway/model-profile'
import {
  gw_routes,
  gw_upstreams,
  gw_model_profiles,
} from '../src/db/schema/gateway'
import {
  buildTestApp,
  openTestDb,
  superAdminSession,
  createFixture,
  cleanupFixture,
  loginSession,
  FIXTURE_USER,
  FIXTURE_PASSWORD,
  type AuthedSession,
} from './helpers'
const db = openTestDb()
let app: FastifyInstance, admin: AuthedSession, ordinary: AuthedSession
const root = '/api/admin/gateway/model-profiles'
const name = 'profile-fixture-main'
beforeAll(async () => {
  app = await buildTestApp()
  const actor = await createFixture(db)
  admin = await superAdminSession(app, db)
  ordinary = await loginSession(
    app,
    FIXTURE_USER,
    FIXTURE_PASSWORD,
    actor.userId,
  )
})
afterAll(async () => {
  await app.close()
  await db.db
    .delete(gw_model_profiles)
    .where(like(gw_model_profiles.model_name, 'profile-fixture-%'))
  await cleanupFixture(db)
  await db.pool.end()
})
test('catalog import preserves manual overrides; clearing restores catalog; disabled-only deletion', async () => {
  const created = await admin.inject({
    method: 'POST',
    url: root,
    payload: { model_name: name, context_window_override: 64000, note: 'keep' },
  })
  expect(created.statusCode).toBe(201)
  const id = created.json().id
  expect(created.json()).toMatchObject({
    context_window: 64000,
    max_output_tokens: 8192,
    source: 'mixed',
  })
  expect(
    (
      await admin.inject({
        method: 'POST',
        url: root,
        payload: { model_name: name },
      })
    ).statusCode,
  ).toBe(409)
  expect(
    (
      await admin.inject({
        method: 'POST',
        url: root + '/sync',
        payload: {
          source: 'verified-docs',
          items: [
            {
              model_name: name,
              context_window: 200000,
              max_output_tokens: 16000,
            },
          ],
        },
      })
    ).statusCode,
  ).toBe(200)
  const list = await admin.inject({
    url: '/api/admin/agent/model-profiles?search=' + name,
  })
  expect(list.json().items[0]).toMatchObject({
    context_window: 64000,
    max_output_tokens: 16000,
    note: 'keep',
    catalog_source: 'verified-docs',
  })
  const cleared = await admin.inject({
    method: 'PUT',
    url: root + '/' + id,
    payload: { context_window_override: null },
  })
  expect(cleared.json()).toMatchObject({
    context_window: 200000,
    max_output_tokens: 16000,
    source: 'catalog',
  })
  expect(
    (await admin.inject({ method: 'DELETE', url: root + '/' + id })).statusCode,
  ).toBe(409)
  await admin.inject({
    method: 'PUT',
    url: root + '/' + id,
    payload: { enabled: false },
  })
  await admin.inject({
    method: 'POST',
    url: root + '/sync',
    payload: {
      items: [
        { model_name: name, context_window: 100000, max_output_tokens: 8000 },
      ],
    },
  })
  expect(
    (await admin.inject({ url: root + '?search=' + name })).json().items[0]
      .enabled,
  ).toBe(false)
  expect(
    (await admin.inject({ method: 'DELETE', url: root + '/' + id })).statusCode,
  ).toBe(200)
})
test('permission, invalid imports, and explicit no-external-sync behavior', async () => {
  expect((await ordinary.inject({ url: root })).statusCode).toBe(403)
  expect(
    (
      await ordinary.inject({
        method: 'POST',
        url: root + '/sync',
        payload: { items: [] },
      })
    ).statusCode,
  ).toBe(403)
  const invalid = await admin.inject({
    method: 'POST',
    url: root + '/sync',
    payload: {
      items: [
        {
          model_name: 'profile-fixture-valid',
          context_window: 1000,
          max_output_tokens: 100,
        },
        {
          model_name: 'profile-fixture-invalid',
          context_window: 0,
          max_output_tokens: 100,
        },
      ],
    },
  })
  expect(invalid.statusCode).toBe(400)
  expect(
    (await admin.inject({ url: root + '?search=profile-fixture-valid' })).json()
      .total,
  ).toBe(0)
  expect(
    (
      await admin.inject({
        method: 'POST',
        url: root + '/sync',
        payload: { force: true },
      })
    ).json(),
  ).toMatchObject({ status: 'disabled', matched_count: 0 })
})

test('model listing uses conservative route targets and personal targets; disabled profiles fall back', async () => {
  const service = new GatewayService(db.db, gatewayOptions(app.config))
  const repo = new ModelProfileRepository(db.db)
  const [platform] = await db.db
    .insert(gw_upstreams)
    .values({
      name: 'profile-fixture-platform',
      protocol: 'openai',
      base_url: 'https://example.invalid/v1',
      secret: 'not-used',
      supported_models: ['profile-fixture-small', 'profile-fixture-large'],
    })
    .returning()
  const [personal] = await db.db
    .insert(gw_upstreams)
    .values({
      name: 'profile-fixture-personal',
      protocol: 'openai',
      base_url: 'https://example.invalid/v1',
      secret: 'not-used',
      scope: 'personal',
      owner_user_id: admin.userId,
      model_prefix: 'profile-fixture-own',
      supported_models: ['profile-fixture-small'],
    })
    .returning()
  try {
    await db.db.insert(gw_routes).values([
      {
        model: 'profile-fixture-alias',
        upstream_id: platform!.id,
        upstream_model: 'profile-fixture-small',
      },
      {
        model: 'profile-fixture-alias',
        upstream_id: platform!.id,
        upstream_model: 'profile-fixture-large',
      },
      {
        model: 'profile-fixture-own/profile-fixture-small',
        upstream_id: platform!.id,
        upstream_model: 'profile-fixture-large',
      },
    ])
    const small = await saveProfile(repo, {
      model_name: 'profile-fixture-small',
      context_window: 32000,
      max_output_tokens: 4000,
    })
    await saveProfile(repo, {
      model_name: 'profile-fixture-large',
      context_window: 200000,
      max_output_tokens: 16000,
    })
    const key = {
      owner_id: admin.userId,
      scopes: ['chat'],
      models: ['*'],
    } as KeyRow
    let result = await service.models(key)
    expect(
      result.data.find((row) => row.id === 'profile-fixture-alias'),
    ).toMatchObject({ context_window: 32000, max_output_tokens: 4000 })
    expect(
      result.data.find(
        (row) => row.id === 'profile-fixture-own/profile-fixture-small',
      ),
    ).toMatchObject({ context_window: 32000, max_output_tokens: 4000 })
    await saveProfile(repo, { enabled: false }, small.id)
    result = await service.models(key)
    expect(
      result.data.find((row) => row.id === 'profile-fixture-alias'),
    ).toMatchObject({ context_window: 128000, max_output_tokens: 8192 })
    await saveProfile(repo, {
      model_name: 'profile-fixture-alias',
      context_window: 50000,
      max_output_tokens: 6000,
    })
    expect(
      (await service.models(key)).data.find(
        (row) => row.id === 'profile-fixture-alias',
      ),
    ).toMatchObject({ context_window: 50000, max_output_tokens: 6000 })
    expect(
      (
        await service.models({ ...key, models: ['profile-fixture-alias'] })
      ).data.map((row) => row.id),
    ).toEqual(['profile-fixture-alias'])
  } finally {
    await db.db.delete(gw_routes).where(eq(gw_routes.upstream_id, platform!.id))
    await db.db.delete(gw_upstreams).where(eq(gw_upstreams.id, personal!.id))
    await db.db.delete(gw_upstreams).where(eq(gw_upstreams.id, platform!.id))
    await service.transport.close()
  }
})
