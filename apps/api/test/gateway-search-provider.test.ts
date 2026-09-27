import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { GatewayTransport } from '../src/modules/gateway/transport'
import { TavilySearchProvider } from '../src/modules/gateway/search-provider'
let mock: FastifyInstance, provider: TavilySearchProvider
const transport = new GatewayTransport(true),
  signal = () => AbortSignal.timeout(3000)
let calls: Array<{ path: string; body: unknown }> = [],
  status = 200,
  response: unknown = {}
beforeAll(async () => {
  mock = Fastify()
  mock.post('/:path', async (req, reply) => {
    calls.push({ path: req.url, body: req.body })
    expect(req.headers.authorization).toBe('Bearer isolated-fixture-key')
    return reply.code(status).send(response)
  })
  const baseUrl = await mock.listen({ host: '127.0.0.1', port: 0 })
  provider = new TavilySearchProvider(transport, {
    apiKey: 'isolated-fixture-key',
    baseUrl,
  })
})
beforeEach(() => {
  calls = []
  status = 200
  response = {}
})
afterAll(async () => {
  await transport.close()
  await mock.close()
})
test('search emits the Python provider contract, deduplicates and enforces domain boundaries', async () => {
  response = {
    results: [
      {
        url: 'https://docs.example.com/a',
        title: ' A ',
        content: 'answer',
        published_date: '2026-09-26',
      },
      { url: 'https://docs.example.com/a', title: 'duplicate' },
      { url: 'https://blocked.example.com/b' },
      { url: 'https://evil-example.com/c' },
      { url: 'javascript:alert(1)' },
    ],
  }
  expect(
    await provider.search(
      {
        query: 'query',
        limit: 5,
        allowed_domains: ['example.com'],
        blocked_domains: ['blocked.example.com'],
      },
      signal(),
    ),
  ).toEqual([
    {
      url: 'https://docs.example.com/a',
      title: 'A',
      snippet: 'answer',
      publishedAt: '2026-09-26',
    },
  ])
  expect(calls).toEqual([
    {
      path: '/search',
      body: {
        query: 'query',
        max_results: 5,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
        include_domains: ['example.com'],
        exclude_domains: ['blocked.example.com'],
      },
    },
  ])
})
test('fetch delegates URL in provider payload, bounds text and rejects restricted inputs and results', async () => {
  response = {
    results: [
      {
        url: 'https://example.com/a',
        title: 'Page',
        raw_content: 'abcdefghij',
      },
    ],
  }
  expect(
    await provider.fetch(
      { url: 'https://example.com/a', max_characters: 5 },
      signal(),
    ),
  ).toMatchObject({ text: 'abcde', truncated: true })
  expect(calls).toEqual([
    {
      path: '/extract',
      body: {
        urls: 'https://example.com/a',
        format: 'markdown',
        extract_depth: 'basic',
      },
    },
  ])
  for (const url of [
    'http://127.0.0.1/a',
    'http://169.254.169.254/',
    'http://localhost./',
    'file:///etc/passwd',
    'https://user:secret@example.com',
  ])
    await expect(provider.fetch({ url }, signal())).rejects.toMatchObject({
      status: 422,
    })
  expect(calls).toHaveLength(1)
  response = {
    results: [{ url: 'https://blocked.example/a', raw_content: 'blocked' }],
  }
  await expect(
    provider.fetch(
      { url: 'https://example.com/a', allowed_domains: ['example.com'] },
      signal(),
    ),
  ).rejects.toMatchObject({ status: 422 })
})
test('provider failures are bounded and sanitized; pre-cancellation performs no HTTP call', async () => {
  await expect(
    provider.search({ query: 'query' }, AbortSignal.abort()),
  ).rejects.toMatchObject({ status: 499 })
  expect(calls).toHaveLength(0)
  status = 401
  response = { error: 'isolated-fixture-key' }
  await expect(
    provider.search({ query: 'query' }, signal()),
  ).rejects.toMatchObject({ status: 502, code: 'search_auth_failed' })
  status = 429
  await expect(
    provider.search({ query: 'query' }, signal()),
  ).rejects.toMatchObject({ status: 429 })
  status = 200
  response = '<html>invalid</html>'
  await expect(
    provider.search({ query: 'query' }, signal()),
  ).rejects.toMatchObject({ code: 'search_invalid_response' })
})

test('path filters keep segment boundaries and reject redirected extraction outside the path', async () => {
  response = {results:[{url:'https://docs.example.com/guide/a'},{url:'https://example.com/guides/a'},
    {url:'https://example.com/guide/private/a'}]}
  const result=await provider.search({query:'fixture',allowed_domains:['https://www.example.com/guide/'],blocked_domains:['example.com/guide/private']},signal())
  expect(result.map(item=>item.url)).toEqual(['https://docs.example.com/guide/a'])
  expect(calls[0]!.body).toMatchObject({include_domains:['example.com']})
  expect(calls[0]!.body).not.toHaveProperty('exclude_domains')
  response={results:[{url:'https://example.com/elsewhere',raw_content:'denied'}]}
  await expect(provider.fetch({url:'https://example.com/guide/a',allowed_domains:['example.com/guide']},signal())).rejects.toMatchObject({code:'fetch_url_not_allowed'})
})
