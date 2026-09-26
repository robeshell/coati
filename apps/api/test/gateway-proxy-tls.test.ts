import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createServer as httpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { GatewayTransport } from '../src/modules/gateway/transport'

// Generate a disposable localhost identity; no private key belongs in the checkout.
const fixtureDir = mkdtempSync(join(tmpdir(), 'coati-proxy-tls-'))
let cert: string
let key: string
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(fixtureDir, 'key.pem'), '-out', join(fixtureDir, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' })
  cert = readFileSync(join(fixtureDir, 'cert.pem'), 'utf8')
  key = readFileSync(join(fixtureDir, 'key.pem'), 'utf8')
} finally {
  rmSync(fixtureDir, { recursive: true, force: true })
}
const priorCAs = getCACertificates('default')
const transport = new GatewayTransport(true)
const wires: { method: string; url: string; auth?: string }[] = []
const hosts: string[] = []
const sockets = new Set<Socket>()
const targetHandler = (request: IncomingMessage, response: ServerResponse) => {
  hosts.push(request.headers.host!)
  expect(request.headers['proxy-authorization']).toBeUndefined()
  request.resume()
  response.end('verified TLS path')
}
const plainTarget = httpServer(targetHandler)
const secureTarget = httpsServer({ key, cert }, targetHandler)
const proxyHandler = (request: IncomingMessage, response: ServerResponse) => {
  wires.push({
    method: request.method!,
    url: request.url!,
    auth: request.headers['proxy-authorization'],
  })
  const headers = { ...request.headers }
  delete headers['proxy-authorization']
  const outgoing = httpRequest(
    request.url!,
    { headers, method: request.method, agent: false },
    (incoming) => {
      response.writeHead(incoming.statusCode!, incoming.headers)
      incoming.pipe(response)
    },
  )
  outgoing.on('error', () => response.destroy())
  response.on('close', () => outgoing.destroy())
  request.pipe(outgoing)
}
const plainProxy = httpServer(proxyHandler)
const secureProxy = httpsServer({ key, cert }, proxyHandler)
for (const server of [plainProxy, secureProxy]) {
  server.on('connect', (request, client, head) => {
    wires.push({
      method: 'CONNECT',
      url: request.url!,
      auth: request.headers['proxy-authorization'],
    })
    const url = new URL('http://' + request.url)
    const remote = connect(
      Number(url.port),
      url.hostname.replace(/^\[|\]$/g, ''),
    )
    sockets.add(remote)
    remote.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) remote.write(head)
      remote.pipe(client)
      client.pipe(remote)
    })
    remote.on('error', () => client.destroy())
    client.on('error', () => remote.destroy())
    client.on('close', () => remote.destroy())
    remote.on('close', () => {
      client.destroy()
      sockets.delete(remote)
    })
  })
}
const all = [plainTarget, secureTarget, plainProxy, secureProxy]
function url(server: typeof plainTarget, secure: boolean, host = 'localhost') {
  return `${secure ? 'https' : 'http'}://${host}:${(server.address() as { port: number }).port}`
}
beforeAll(async () => {
  setDefaultCACertificates([...priorCAs, cert])
  for (const server of all)
    await new Promise<void>((resolve) => server.listen(0, '::', resolve))
})
beforeEach(() => {
  wires.length = 0
  hosts.length = 0
})
afterAll(async () => {
  await transport.close()
  for (const socket of sockets) socket.destroy()
  await Promise.all(
    all.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  )
  setDefaultCACertificates(priorCAs)
})

test.each([
  [false, true],
  [true, false],
  [true, true],
])(
  'proxy TLS=%s target TLS=%s preserves certificate identity with pinned destination',
  async (proxyTls, targetTls) => {
    const destination = url(targetTls ? secureTarget : plainTarget, targetTls)
    const proxy = new URL(url(proxyTls ? secureProxy : plainProxy, proxyTls))
    proxy.username = 'tls-proxy-user'
    proxy.password = 'tls-proxy-password'
    const response = await transport.send(
      destination + '/model?key=value',
      {},
      {},
      AbortSignal.timeout(3000),
      1000,
      proxy.toString(),
    )
    expect(await response.text()).toBe('verified TLS path')
    expect(hosts).toEqual([new URL(destination).host])
    expect(wires).toHaveLength(1)
    expect(wires[0]!.method).toBe(targetTls ? 'CONNECT' : 'POST')
    expect(wires[0]!.url).not.toContain('localhost')
    if (!targetTls) expect(wires[0]!.url).toContain('/model?key=value')
    expect(wires[0]!.auth).toBe(
      'Basic ' +
        Buffer.from('tls-proxy-user:tls-proxy-password').toString('base64'),
    )
  },
)

test('HTTPS proxy certificate hostname mismatch is rejected before target I/O', async () => {
  await expect(
    transport.discover(
      url(plainTarget, false),
      {},
      AbortSignal.timeout(3000),
      1000,
      url(secureProxy, true, '127.0.0.1'),
    ),
  ).rejects.toThrow()
  expect(wires).toHaveLength(0)
  expect(hosts).toHaveLength(0)
})

test('HTTPS target certificate hostname mismatch is rejected inside CONNECT', async () => {
  await expect(
    transport.discover(
      url(secureTarget, true, '127.0.0.1'),
      {},
      AbortSignal.timeout(3000),
      1000,
      url(plainProxy, false),
    ),
  ).rejects.toThrow()
  expect(wires).toHaveLength(1)
  expect(wires[0]!.method).toBe('CONNECT')
  expect(hosts).toHaveLength(0)
})

test.each([false, true])(
  'untrusted certificate is rejected on %s proxy TLS path',
  async (proxyTls) => {
    setDefaultCACertificates(priorCAs)
    try {
      await expect(
        transport.discover(
          url(proxyTls ? plainTarget : secureTarget, !proxyTls),
          {},
          AbortSignal.timeout(3000),
          1000,
          url(proxyTls ? secureProxy : plainProxy, proxyTls),
        ),
      ).rejects.toThrow()
      expect(hosts).toHaveLength(0)
    } finally {
      setDefaultCACertificates([...priorCAs, cert])
    }
  },
)

test('trusted administrator proxy preserves hostname and still verifies target TLS', async () => {
  const destination=url(secureTarget,true)
  const response=await transport.discover(destination+'/models',{},AbortSignal.timeout(3000),1000,url(secureProxy,true),true)
  expect(await response.text()).toBe('verified TLS path')
  expect(wires[0]!.url).toBe(new URL(destination).host)
  expect(hosts).toEqual([new URL(destination).host])
  hosts.length=0
  await expect(transport.discover(url(secureTarget,true,'127.0.0.1')+'/models',{},AbortSignal.timeout(3000),1000,url(secureProxy,true),true)).rejects.toThrow()
  expect(hosts).toHaveLength(0)
})
