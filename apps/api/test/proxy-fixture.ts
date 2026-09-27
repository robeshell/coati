import { createServer, request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
export async function startProxyFixture() {
  const sockets = new Set<Socket>()
  const calls: { target: string; auth: string | undefined }[] = []
  const server = createServer()
  server.on('request', (request, response) => {
    calls.push({
      target: request.url!,
      auth: request.headers['proxy-authorization'],
    })
    const headers = { ...request.headers }
    delete headers['proxy-authorization']
    const remote = httpRequest(
      request.url!,
      { method: request.method, headers, agent: false },
      (incoming) => {
        response.writeHead(incoming.statusCode!, incoming.headers)
        incoming.pipe(response)
      },
    )
    remote.on('error', () => response.destroy())
    response.on('close', () => remote.destroy())
    request.pipe(remote)
  })
  server.on('connect', (request, client, head) => {
    calls.push({
      target: request.url!,
      auth: request.headers['proxy-authorization'],
    })
    const url = new URL('http://' + request.url)
    const remote = connect(
      Number(url.port),
      url.hostname.replace(/^\[|\]$/g, ''),
    )
    sockets.add(remote)
    remote.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) remote.write(head)
      client.pipe(remote)
      remote.pipe(client)
    })
    client.on('error', () => remote.destroy())
    remote.on('error', () => client.destroy())
    client.on('close', () => remote.destroy())
    remote.on('close', () => {
      client.destroy()
      sockets.delete(remote)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://proxy-user:proxy-fixture-password@127.0.0.1:${(server.address() as { port: number }).port}`,
    calls,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
