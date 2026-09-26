import { createServer } from 'node:http'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { GatewayTransport } from '../src/modules/gateway/transport'
import { upstreamTimeout } from '../src/modules/gateway/upstream-failure'
import { upstreamSchema } from '../src/modules/gateway/schema'

const transport = new GatewayTransport(true)
const closed = new Set<string>()
const server = createServer((request, response) => {
  request.resume()
  const url = new URL(request.url!, 'http://fixture')
  response.on('close', () => closed.add(url.pathname))
  if (url.pathname.startsWith('/headers')) {
    const timer = setTimeout(() => response.end('ok'), 300)
    response.on('close', () => clearTimeout(timer))
    return
  }
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.write('a')
  if (url.pathname === '/active') {
    let count = 0
    const timer = setInterval(() => {
      response.write('b')
      if (++count === 8) response.end('z')
    }, 40)
    response.on('close', () => clearInterval(timer))
  }
})
let base: string
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await transport.close()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

async function timeoutFailure(task: Promise<unknown>) {
  const error = await task.then(
    () => null,
    (error) => error,
  )
  expect(error).not.toBeNull()
  expect(upstreamTimeout(error)).toBe(true)
}

test('account header timeout closes the socket and does not affect another account on the same origin', async () => {
  const short = transport.send(
    base + '/headers-short',
    {},
    {},
    AbortSignal.timeout(3000),
    80,
  )
  const long = transport.send(
    base + '/headers-long',
    {},
    {},
    AbortSignal.timeout(3000),
    1000,
  )
  await timeoutFailure(short)
  expect(await (await long).text()).toBe('ok')
  await expect.poll(() => closed.has('/headers-short')).toBe(true)
})

test('account body inactivity timeout aborts an already started ordinary response', async () => {
  const response = await transport.send(
    base + '/stalled',
    {},
    {},
    AbortSignal.timeout(3000),
    100,
  )
  await timeoutFailure(response.text())
  await expect.poll(() => closed.has('/stalled')).toBe(true)
})

test('account timeout is inactivity rather than total response duration', async () => {
  const response = await transport.send(
    base + '/active',
    {},
    {},
    AbortSignal.timeout(3000),
    150,
  )
  expect(await response.text()).toBe('abbbbbbbbz')
})

test('discovery uses the same account inactivity limit', async () => {
  const response = await transport.discover(
    base + '/discovery',
    {},
    AbortSignal.timeout(3000),
    100,
  )
  await timeoutFailure(response.text())
  await expect.poll(() => closed.has('/discovery')).toBe(true)
})

test('parent cancellation remains effective after receiving response headers', async () => {
  const controller = new AbortController()
  const response = await transport.send(
    base + '/cancelled',
    {},
    {},
    controller.signal,
    1000,
  )
  const body = response.text()
  controller.abort()
  await expect(body).rejects.toThrow()
  await expect.poll(() => closed.has('/cancelled')).toBe(true)
})

test.each([4, 301, 5.5, null, '120'])(
  'account timeout rejects invalid configuration %s',
  (value) => {
    expect(
      upstreamSchema.shape.request_timeout_seconds.safeParse(value).success,
    ).toBe(false)
  },
)
test.each([5, 120, 300, undefined])(
  'account timeout accepts valid configuration %s',
  (value) => {
    expect(
      upstreamSchema.shape.request_timeout_seconds.safeParse(value).success,
    ).toBe(true)
  },
)
