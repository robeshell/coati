import { createServer } from 'node:http'
import { expect, test } from 'vitest'
import {
  GatewayTransport,
  permittedResolution,
} from '../src/modules/gateway/transport'

test('only administrator hostnames may resolve to Fake-IP; personal and literal/private targets stay blocked', () => {
  for (const address of ['198.18.0.165', '198.19.1.2', '2001:2::a2']) {
    expect(permittedResolution('provider.example', address, true)).toBe(true)
    expect(permittedResolution('provider.example', address, false)).toBe(false)
    expect(permittedResolution(address, address, true)).toBe(false)
  }
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ])
    expect(permittedResolution('provider.example', address, true)).toBe(false)
  expect(permittedResolution('provider.example', '8.8.8.8', false)).toBe(true)
})

test('admin proxy receives hostname without local target DNS; personal channel cannot reuse that trust', async () => {
  const targets: string[] = []
  const proxy = createServer()
  proxy.on('connect', (request, socket) => {
    targets.push(request.url!)
    socket.end(
      'HTTP/1.1 502 Fixture Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    )
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  const transport = new GatewayTransport(false, url)
  try {
    await expect(
      transport.discover(
        'https://must-resolve-at-proxy.invalid/models',
        {},
        AbortSignal.timeout(3000),
        3000,
        null,
        true,
      ),
    ).rejects.toThrow()
    expect(targets.length).toBeGreaterThan(0)
    expect(
      targets.every((target) => target === 'must-resolve-at-proxy.invalid:443'),
    ).toBe(true)
    const count = targets.length
    await expect(
      transport.discover(
        'https://must-resolve-at-proxy.invalid/models',
        {},
        AbortSignal.timeout(3000),
        3000,
        url,
        false,
      ),
    ).rejects.toThrow('Private proxy')
    await expect(
      transport.discover(
        'https://127.0.0.1/models',
        {},
        AbortSignal.timeout(3000),
        3000,
        null,
        true,
      ),
    ).rejects.toThrow()
    expect(targets).toHaveLength(count)
  } finally {
    await transport.close()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
  }
})
