import { afterAll, beforeAll, expect, test } from 'vitest'
import Fastify from 'fastify'
import { GatewayTransport } from '../src/modules/gateway/transport'
import { discoverModels } from '../src/modules/gateway/discovery'
const server = Fastify()
const transport = new GatewayTransport(true)
let base: string
let redirected = 0
beforeAll(async () => {
  server.get('/models', async (_, reply) => reply.code(404).send({}))
  server.get('/v1/models', async () => ({
    models: { data: ['b', { name: 'a' }] },
  }))
  server.get('/redirect/models', async (_, reply) => reply.redirect('/target'))
  server.get('/target', async () => {
    redirected++
    return { data: [{ id: 'leak' }] }
  })
  server.get('/huge/models', async () => 'x'.repeat(1024 * 1024 + 1))
  server.get('/slow/models', async () => {
    await new Promise((resolve) => setTimeout(resolve, 80))
    return { data: [{ id: 'slow' }] }
  })
  await server.listen({ host: '127.0.0.1', port: 0 })
  base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`
})
afterAll(async () => {
  await transport.close()
  await server.close()
})
test('model discovery falls back to v1 and normalizes legacy lists', async () => {
  expect(
    await discoverModels(transport, base, 'fixture', AbortSignal.timeout(1000)),
  ).toEqual({ models: ['a', 'b'], model_discovery_supported: true })
})
test('redirects cannot forward credentials to another endpoint', async () => {
  await expect(
    discoverModels(
      transport,
      base + '/redirect',
      'fixture',
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('HTTP 302')
  expect(redirected).toBe(0)
})
test('discovery enforces a bounded response', async () => {
  await expect(
    discoverModels(
      transport,
      base + '/huge',
      'fixture',
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('大小限制')
})
test('discovery obeys cancellation and rejects private addresses by default', async () => {
  await expect(
    discoverModels(
      transport,
      base + '/slow',
      'fixture',
      AbortSignal.timeout(10),
    ),
  ).rejects.toThrow()
  const publicTransport = new GatewayTransport()
  try {
    await expect(
      discoverModels(
        publicTransport,
        base,
        'fixture',
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow('公网 HTTPS')
  } finally {
    await publicTransport.close()
  }
})
