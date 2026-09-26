import { safePayload } from '../src/common/request-meta'
import { createServer, request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { GatewayTransport } from '../src/modules/gateway/transport'
import {
  proxyHint,
  proxySecrets,
  proxyUrlSchema,
} from '../src/modules/gateway/account-proxy'

const transport = new GatewayTransport(true)
const connections = new Set<Socket>()
const tunnels: { path: string; auth?: string }[] = []
const targetHeaders: Record<string, unknown>[] = []
const target = createServer((request, response) => {
  request.resume()
  targetHeaders.push(request.headers)
  if (request.url === '/stall') {
    response.writeHead(200)
    response.write('partial')
  } else if (request.url === '/redirect') {
    response.writeHead(302, { location: '/target' })
    response.end()
  } else response.end('through proxy')
})
const proxy = createServer()
let refused = false
let stalled = false
const proxyClients = new Set<Socket>()
proxy.on('connection', (socket) => {
  proxyClients.add(socket)
  socket.on('close', () => proxyClients.delete(socket))
})
proxy.on('request', (request, response) => {
  tunnels.push({
    path: request.url!,
    auth: request.headers['proxy-authorization'],
  })
  if (refused) {
    response.writeHead(407)
    response.end()
    return
  }
  const headers = { ...request.headers }
  delete headers['proxy-authorization']
  const outgoing = httpRequest(
    request.url!,
    { method: request.method, headers, agent: false },
    (incoming) => {
      response.writeHead(incoming.statusCode!, incoming.headers)
      incoming.pipe(response)
    },
  )
  outgoing.on('socket', (socket) => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
  })
  outgoing.on('error', () => response.destroy())
  response.on('close', () => outgoing.destroy())
  request.pipe(outgoing)
})
proxy.on('connect', (request, downstream, head) => {
  tunnels.push({
    path: request.url!,
    auth: request.headers['proxy-authorization'],
  })
  if (stalled) {
    downstream.on('end', () => downstream.destroy())
    downstream.resume()
    return
  }
  if (refused) {
    downstream.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n',
    )
    return
  }
  const address = new URL('http://' + request.url)
  const upstream = connect(
    Number(address.port),
    address.hostname.replace(/^\[|\]$/g, ''),
  )
  connections.add(upstream)
  upstream.once('connect', () => {
    downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    upstream.pipe(downstream)
    downstream.pipe(upstream)
  })
  upstream.on('error', () => downstream.destroy())
  downstream.on('error', () => upstream.destroy())
  downstream.on('close', () => upstream.destroy())
  upstream.on('close', () => {
    downstream.destroy()
    connections.delete(upstream)
  })
})
let base: string, proxyUrl: string
beforeAll(async () => {
  await new Promise<void>((resolve) => target.listen(0, '::', resolve))
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  base = `http://localhost:${(target.address() as { port: number }).port}`
  proxyUrl = `http://fixture-user:fixture-pass@127.0.0.1:${(proxy.address() as { port: number }).port}`
})
beforeEach(() => {
  tunnels.length = 0
  targetHeaders.length = 0
  refused = false
  stalled = false
})
afterAll(async () => {
  await transport.close()
  for (const socket of connections) socket.destroy()
  await Promise.all(
    [target, proxy].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  )
})

test('HTTP proxy forwards a pinned absolute URI while preserving target host and separating credentials', async () => {
  const response = await transport.send(
    base,
    {},
    { authorization: 'Bearer upstream-fixture' },
    AbortSignal.timeout(3000),
    1000,
    proxyUrl,
  )
  expect(await response.text()).toBe('through proxy')
  expect(tunnels).toHaveLength(1)
  expect(tunnels[0]!.path).not.toContain('localhost')
  expect(tunnels[0]!.path).toMatch(/^http:\/\//)
  expect(tunnels[0]!.auth).toBe(
    'Basic ' + Buffer.from('fixture-user:fixture-pass').toString('base64'),
  )
  expect(targetHeaders[0]!.host).toBe(new URL(base).host)
  expect(targetHeaders[0]!.authorization).toBe('Bearer upstream-fixture')
  expect(targetHeaders[0]!['proxy-authorization']).toBeUndefined()
})

test('proxy credentials are isolated across concurrent requests to the same target', async () => {
  const second = proxyUrl.replace(
    'fixture-user:fixture-pass',
    'second-user:second-pass',
  )
  await Promise.all(
    [proxyUrl, second].map(async (url) => {
      const response = await transport.discover(
        base,
        {},
        AbortSignal.timeout(3000),
        1000,
        url,
      )
      expect(await response.text()).toBe('through proxy')
    }),
  )
  expect(new Set(tunnels.map((item) => item.auth))).toEqual(
    new Set(
      ['fixture-user:fixture-pass', 'second-user:second-pass'].map(
        (value) => 'Basic ' + Buffer.from(value).toString('base64'),
      ),
    ),
  )
})

test('proxy refusal never falls back to a direct connection', async () => {
  refused = true
  await expect(
    transport.send(base, {}, {}, AbortSignal.timeout(3000), 1000, proxyUrl),
  ).rejects.toThrow()
  expect(targetHeaders).toHaveLength(0)
})

test('proxy response cancellation closes its tunnel', async () => {
  const response = await transport.send(
    base + '/stall',
    {},
    {},
    AbortSignal.timeout(3000),
    1000,
    proxyUrl,
  )
  await response.body!.cancel()
  await expect.poll(() => connections.size).toBe(0)
})

test('proxy response body timeout closes its tunnel', async () => {
  const response = await transport.send(
    base + '/stall',
    {},
    {},
    AbortSignal.timeout(3000),
    1000,
    proxyUrl,
  )
  await expect(response.text()).rejects.toThrow()
  await expect.poll(() => connections.size).toBe(0)
})

test('proxy requests do not follow redirects', async () => {
  const response = await transport.discover(
    base + '/redirect',
    {},
    AbortSignal.timeout(3000),
    1000,
    proxyUrl,
  )
  expect(response.status).toBe(302)
  await response.body!.cancel()
  expect(targetHeaders).toHaveLength(1)
})

test('default network policy rejects private targets or proxy endpoints before proxy I/O', async () => {
  const guarded = new GatewayTransport()
  try {
    await expect(
      guarded.send(
        'https://localhost./v1',
        {},
        {},
        AbortSignal.timeout(3000),
        1000,
        'http://localhost.:80',
      ),
    ).rejects.toThrow('Private')
    await expect(
      guarded.send(
        'https://example.com/v1',
        {},
        {},
        AbortSignal.timeout(3000),
        1000,
        proxyUrl,
      ),
    ).rejects.toThrow('Private')
    expect(tunnels).toHaveLength(0)
  } finally {
    await guarded.close()
  }
})

test.each([
  'socks5://host:1080',
  'http://host:0',
  'http://host:99999',
  'http://host/#fragment',
  'http://user:%ZZ@host',
  'http://host\r\n',
])('rejects unsafe proxy value %s', (value) => {
  expect(proxyUrlSchema.safeParse(value).success).toBe(false)
})

test('proxy hint and redaction values never require returning authentication to callers', () => {
  expect(proxyHint('http://user:p%40ss@host:8080')).toBe('http://host:8080')
  expect(proxySecrets('http://user:p%40ss@host:8080')).toContain('p@ss')
  expect(proxyUrlSchema.parse(null)).toBeNull()
  expect(proxyUrlSchema.parse('')).toBeNull()
})

test('proxy CONNECT handshake timeout closes the pending proxy socket', async () => {
  await expect.poll(() => proxyClients.size).toBe(0)
  stalled = true
  await expect(
    transport.send(
      base.replace('http:', 'https:'),
      {},
      {},
      AbortSignal.timeout(3000),
      100,
      proxyUrl,
    ),
  ).rejects.toThrow()
  await expect.poll(() => proxyClients.size).toBe(0)
  expect(targetHeaders).toHaveLength(0)
})

test('proxy values are masked recursively before operation audit serialization', () => {
  expect(
    JSON.parse(
      safePayload({
        proxy_url: proxyUrl,
        nested: {
          PROXY_SECRET: 'ciphertext',
          'Proxy-Authorization': 'Basic abc',
        },
      })!,
    ),
  ).toEqual({
    proxy_url: '***',
    nested: { PROXY_SECRET: '***', 'Proxy-Authorization': '***' },
  })
})
