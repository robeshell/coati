import { startProxyFixture } from './proxy-fixture'
import * as gatewayServiceModule from '../src/modules/gateway/service'
import {
  reasoningJson,
  interleavedThinking,
  reasoningEvents,
  thought,
  signature,
  answer,
} from './reasoning-fixture'
import { GatewayRepository } from '../src/modules/gateway/repository'
import { parallelFixture, parallelCalls } from './parallel-tool-fixture'
import { GatewayService } from '../src/modules/gateway/service'
import { beforeAll, afterAll, beforeEach, test, expect, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Readable } from 'node:stream'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { sql } from 'drizzle-orm'
import {
  buildTestApp,
  openTestDb,
  superAdminSession,
  type AuthedSession,
} from './helpers'
import type { Protocol } from '../src/modules/gateway/schema'
import { normalizeUsage, mergeUsage } from '../src/modules/gateway/usage'
import { matrix } from '../src/modules/gateway/protocol/matrix'
const db = openTestDb()
let app: FastifyInstance,
  upstream: FastifyInstance,
  session: AuthedSession,
  base: string
let upstreamClosed = false
let gatewayBase = ''
let imageFetches = 0
let upstreamCalls = 0
let generatedSlowChunks = 0
let mode = 'text',
  observed: any,
  observedPath = '',
  observedAuth: any
const paths: Record<Protocol, string> = {
  openai: '/chat/completions',
  anthropic: '/messages',
  responses: '/responses',
}
const defaultUsage = {
  openai: {
    prompt_tokens: 10,
    completion_tokens: 3,
    prompt_tokens_details: { cached_tokens: 2 },
    cache_creation_input_tokens: 1,
  },
  anthropic: {
    input_tokens: 7,
    output_tokens: 3,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
  },
  responses: {
    input_tokens: 10,
    output_tokens: 3,
    input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
  },
}
let usage: Record<Protocol, Record<string, unknown>> = structuredClone(
  defaultUsage,
)
function frames(protocol: Protocol, tools: boolean) {
  const args = '{"city":"上海"}'
  if (protocol === 'openai')
    return [
      {
        id: 's1',
        model: protocol,
        choices: [
          {
            index: 0,
            delta: tools
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call1',
                      type: 'function',
                      function: { name: 'weather', arguments: '{"city":' },
                    },
                  ],
                }
              : { role: 'assistant', content: '你好' },
            finish_reason: null,
          },
        ],
      },
      ...(tools
        ? [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      { index: 0, function: { arguments: '"上海"}' } },
                    ],
                  },
                },
              ],
            },
          ]
        : []),
      {
        choices: [
          { index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' },
        ],
      },
      { choices: [], usage: usage.openai },
      '[DONE]',
    ]
  if (protocol === 'anthropic')
    return [
      {
        type: 'message_start',
        message: {
          id: 's1',
          model: protocol,
          role: 'assistant',
          content: [],
          usage: { ...usage.anthropic, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: tools
          ? { type: 'tool_use', id: 'call1', name: 'weather', input: {} }
          : { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: tools
          ? { type: 'input_json_delta', partial_json: args }
          : { type: 'text_delta', text: '你好' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: tools ? 'tool_use' : 'end_turn' },
        usage: usage.anthropic,
      },
      { type: 'message_stop' },
    ]
  const item = tools
    ? {
        id: 'call1',
        type: 'function_call',
        call_id: 'call1',
        name: 'weather',
        arguments: '',
      }
    : { id: 'msg1', type: 'message', role: 'assistant', content: [] }
  return [
    {
      type: 'response.created',
      response: {
        id: 's1',
        model: protocol,
        status: 'in_progress',
        output: [],
      },
    },
    { type: 'response.output_item.added', output_index: 0, item },
    tools
      ? {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          item_id: 'call1',
          delta: args,
        }
      : {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          item_id: 'msg1',
          delta: '你好',
        },
    {
      type: 'response.completed',
      response: {
        id: 's1',
        model: protocol,
        status: 'completed',
        usage: usage.responses,
        output: tools
          ? [{ ...item, arguments: args }]
          : [{ ...item, content: [{ type: 'output_text', text: '你好' }] }],
      },
    },
  ]
}
function bodyFor(protocol: Protocol, stream: boolean, followup = false) {
  const common = { model: 'public-model', stream, max_tokens: 100 }
  if (protocol === 'openai')
    return {
      ...common,
      messages: [
        { role: 'user', content: 'hello' },
        ...(followup
          ? [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call1',
                    type: 'function',
                    function: { name: 'weather', arguments: '{"city":"上海"}' },
                  },
                ],
                content: '',
              },
              { role: 'tool', tool_call_id: 'call1', content: 'sunny' },
            ]
          : []),
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'weather', parameters: { type: 'object' } },
        },
      ],
    }
  if (protocol === 'anthropic')
    return {
      ...common,
      messages: [
        { role: 'user', content: 'hello' },
        ...(followup
          ? [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'call1',
                    name: 'weather',
                    input: { city: '上海' },
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'call1',
                    content: 'sunny',
                  },
                ],
              },
            ]
          : []),
      ],
      tools: [{ name: 'weather', input_schema: { type: 'object' } }],
    }
  return {
    model: 'public-model',
    stream,
    max_output_tokens: 100,
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ...(followup
        ? [
            {
              type: 'function_call',
              call_id: 'call1',
              name: 'weather',
              arguments: '{"city":"上海"}',
            },
            { type: 'function_call_output', call_id: 'call1', output: 'sunny' },
          ]
        : []),
    ],
    tools: [
      { type: 'function', name: 'weather', parameters: { type: 'object' } },
    ],
  }
}
beforeAll(async () => {
  process.env.GATEWAY_ALLOW_PRIVATE_UPSTREAMS = 'true'
  upstream = Fastify()
  upstream.get('/image.png', async () => {
    imageFetches++
    return 'fixture-image'
  })
  upstream.post('/v1/*', async (request, reply) => {
    const body = request.body as any,
      protocol = body.model as Protocol
    observed = body
    upstreamCalls++
    observedPath = request.url
    observedAuth = request.headers
    if (mode.startsWith('slow-')) {
      const encode = (event: any) =>
        Buffer.from(
          `${event.type ? `event: ${event.type}\n` : ''}data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`,
        )
      const content = 'x'.repeat(32768)
      const delta =
        protocol === 'openai'
          ? { choices: [{ index: 0, delta: { content }, finish_reason: null }] }
          : protocol === 'anthropic'
            ? {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: content },
              }
            : {
                type: 'response.output_text.delta',
                output_index: 0,
                content_index: 0,
                delta: content,
              }
      const initial = frames(protocol, false).slice(
        0,
        protocol === 'openai' ? 1 : 2,
      )
      return reply.type('text/event-stream').send(
        Readable.from(
          (async function* () {
            try {
              for (const event of initial) yield encode(event)
              for (
                let i = 0;
                i <
                (mode === 'slow-resume'
                  ? 4
                  : mode === 'slow-terminal'
                    ? 16
                    : mode === 'slow-oversized'
                      ? 40
                      : 8192);
                i++
              ) {
                generatedSlowChunks++
                yield encode(delta)
              }
              if (
                mode === 'slow-resume' ||
                mode === 'slow-terminal' ||
                mode === 'slow-oversized'
              ) {
                const ending: any[] = frames(protocol, false).slice(
                  protocol === 'openai' ? 1 : 3,
                )
                if (protocol === 'responses')
                  ending[0].response.output[0].content[0].text = content.repeat(
                    mode === 'slow-resume' ? 4 : 16,
                  )
                for (const event of ending) yield encode(event)
              }
            } finally {
              upstreamClosed = true
            }
          })(),
          { objectMode: false, highWaterMark: 65536 },
        ),
      )
    }
    if (mode === 'error')
      return reply.code(503).send({ error: { message: 'fixture failure' } })
    if (mode === 'endless' && !body.stream) {
      return reply.type('application/json').send(
        Readable.from(
          (async function* () {
            try {
              yield '{"id":"pending","output":'
              while (mode === 'endless') {
                await new Promise((resolve) => setTimeout(resolve, 5))
                yield ' '
              }
            } finally {
              upstreamClosed = true
            }
          })(),
        ),
      )
    }
    if (mode === 'truncated' && !body.stream)
      return reply.type('application/json').send('{"id":"partial","usage":')
    if (mode === 'parallel' && !body.stream)
      return parallelFixture(protocol, usage[protocol]).json
    if (mode === 'reasoning' && !body.stream)
      return reasoningJson(protocol, usage[protocol])
    if (mode === 'redacted' && !body.stream)
      return {
        id: 'redacted-1',
        type: 'message',
        model: protocol,
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'opaque-redacted-value' },
          { type: 'text', text: '你好' },
        ],
        stop_reason: 'end_turn',
        usage: usage.anthropic,
      }
    if (mode === 'extension' && !body.stream) {
      const citation = [{ url: 'PRIVATE_EXTENSION' }]
      return protocol === 'openai'
        ? { id: 's1', model: protocol, choices: [{ index: 0, message: { role: 'assistant', content: '你好', annotations: citation }, finish_reason: 'stop' }], usage: usage.openai }
        : protocol === 'anthropic'
          ? { id: 's1', type: 'message', role: 'assistant', model: protocol, content: [{ type: 'text', text: '你好', citations: citation }], stop_reason: 'end_turn', usage: usage.anthropic }
          : { id: 's1', object: 'response', model: protocol, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好', annotations: citation }] }], usage: usage.responses }
    }
    const tools = mode === 'tools'
    if (!body.stream) {
      if (protocol === 'openai')
        return {
          id: 's1',
          model: protocol,
          choices: [
            {
              index: 0,
              message: tools
                ? {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      {
                        id: 'call1',
                        type: 'function',
                        function: {
                          name: 'weather',
                          arguments: '{"city":"上海"}',
                        },
                      },
                    ],
                  }
                : { role: 'assistant', content: '你好' },
              finish_reason: tools ? 'tool_calls' : 'stop',
            },
          ],
          usage: usage.openai,
        }
      if (protocol === 'anthropic')
        return {
          id: 's1',
          type: 'message',
          model: protocol,
          role: 'assistant',
          content: tools
            ? [
                {
                  type: 'tool_use',
                  id: 'call1',
                  name: 'weather',
                  input: { city: '上海' },
                },
              ]
            : [{ type: 'text', text: '你好' }],
          stop_reason: tools ? 'tool_use' : 'end_turn',
          usage: usage.anthropic,
        }
      return (frames(protocol, tools).at(-1) as any).response
    }
    const events = mode.startsWith('thinking-')
      ? interleavedThinking()
      : mode.startsWith('reasoning')
        ? reasoningEvents(protocol, usage[protocol])
        : mode === 'parallel'
          ? parallelFixture(protocol, usage[protocol]).events
          : frames(protocol, tools)
    if (mode === 'redacted') {
      for (const event of events as any[])
        if (typeof event.index === 'number') event.index++
      events.splice(
        1,
        0,
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'redacted_thinking',
            data: 'opaque-redacted-value',
          },
        },
        { type: 'content_block_stop', index: 0 },
      )
    }
    if (mode === 'thinking-invalid')
      events.splice(2, 0, structuredClone(events[1]!))
    if (mode === 'reasoning-late' || mode === 'reasoning-terminal-only') {
      const at = events.findIndex(
        (event: any) =>
          event.type === 'response.output_item.done' &&
          event.item.type === 'reasoning',
      )
      const [completion] = events.splice(at, 1)
      if (mode === 'reasoning-late')
        events.splice(events.length - 1, 0, completion!)
    }
    if (mode === 'reasoning-conflict') {
      const terminal = events.at(-1) as any
      terminal.response = structuredClone(terminal.response)
      terminal.response.output[0].encrypted_content = 'conflicting-opaque-data'
    }
    if (mode === 'length')
      for (const event of events as any[]) {
        if (typeof event === 'string') continue
        if (event.choices?.[0]?.finish_reason)
          event.choices[0].finish_reason = 'length'
        if (event.delta?.stop_reason) event.delta.stop_reason = 'max_tokens'
        if (event.type === 'response.completed') {
          event.type = 'response.incomplete'
          event.response.status = 'incomplete'
          event.response.incomplete_details = { reason: 'max_output_tokens' }
        }
      }
    if (mode === 'extension') {
      const event = (events as any[]).find(event => protocol === 'openai' ? event.choices?.[0]?.delta : protocol === 'anthropic' ? event.content_block : event.type === 'response.output_text.delta')
      if (protocol === 'openai') event.choices[0].delta.annotations = [{ url: 'PRIVATE_EXTENSION' }]
      else if (protocol === 'anthropic') event.content_block.citations = [{ url: 'PRIVATE_EXTENSION' }]
      else events.splice(2, 0, { type: 'response.future.delta', delta: 'PRIVATE_EXTENSION' } as never)
    }
    if (mode === 'truncated') events.pop()
    if (mode === 'endless') events.splice(protocol === 'openai' ? 1 : 3)
    const bytes = Buffer.from(
      events
        .map(
          (event: any) =>
            `${event.type ? `event: ${event.type}\n` : ''}data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`,
        )
        .join(''),
    )
    // Deliberately split every UTF-8 byte, not just event boundaries.
    reply.type('text/event-stream')
    return reply.send(
      Readable.from(
        (async function* () {
          try {
            for (const byte of bytes) yield Buffer.from([byte])
            while (mode === 'endless') {
              await new Promise((resolve) => setTimeout(resolve, 5))
              yield Buffer.from(': heartbeat\n\n')
            }
          } finally {
            upstreamClosed = true
          }
        })(),
      ),
    )
  })
  await upstream.listen({ host: '127.0.0.1', port: 0 })
  base = `http://127.0.0.1:${(upstream.server.address() as any).port}/v1`
  app = await buildTestApp()
  await app.listen({ host: '127.0.0.1', port: 0 })
  gatewayBase = `http://127.0.0.1:${(app.server.address() as any).port}`
  // An interrupted prior run may leave PATs referencing the fixture admin.
  // Clear gateway fixtures before the helper recreates that admin, not only beforeEach.
  await clear()
  session = await superAdminSession(app, db)
})
const clear = () =>
  db.db.execute(
    sql`TRUNCATE gw_attempts,gw_requests,gw_devices,gw_keys,gw_routes,gw_upstreams RESTART IDENTITY CASCADE`,
  )
beforeEach(async () => {
  await clear()
  mode = 'text'
  generatedSlowChunks = 0
  upstreamCalls = 0
  imageFetches = 0
  usage = structuredClone(defaultUsage)
  upstreamClosed = false
})
afterAll(async () => {
  await clear()
  app.server.closeAllConnections()
  await app.close()
  await upstream.close()
  await db.pool.end()
  delete process.env.GATEWAY_ALLOW_PRIVATE_UPSTREAMS
})
async function configure(protocol: Protocol, automatic = false) {
  const u = await session.inject({
    method: 'POST',
    url: '/api/admin/gateway/upstreams',
    payload: {
      name: 'matrix',
      supported_models: [protocol, 'must-not-use-text-model'],
      protocol,
      base_url: base,
      api_key: 'matrix-key',
    },
  })
  expect(u.statusCode).toBe(201)
  const r = await session.inject({
    method: 'POST',
    url: '/api/admin/gateway/routes',
    payload: {
      model: automatic ? 'coati-auto' : 'public-model',
      upstream_id: u.json().id,
      upstream_model: automatic ? 'must-not-use-text-model' : protocol,
      vision_model: automatic ? protocol : null,
    },
  })
  expect(r.statusCode).toBe(201)
  const k = await session.inject({
    method: 'POST',
    url: '/api/admin/gateway/keys',
    payload: {
      name: 'matrix',
      models: [automatic ? 'coati-auto' : 'public-model'],
    },
  })
  expect(k.statusCode).toBe(201)
  return k.json().token as string
}
const invoke = (
  token: string,
  inbound: Protocol,
  stream: boolean,
  followup = false,
  extraHeaders: Record<string, string> = {},
) =>
  app.inject({
    method: 'POST',
    url: '/v1' + paths[inbound],
    headers: { authorization: `Bearer ${token}`, ...extraHeaders },
    payload: bodyFor(inbound, stream, followup),
  })
for (const { inbound, upstream: protocol } of matrix) {
  for (const stream of [false, true])
    for (const tools of [false, true]) {
      test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} ${tools ? 'tool arguments' : 'text'} and accounting`, async () => {
        const token = await configure(protocol)
        mode = tools ? 'tools' : 'text'
        const response = await invoke(token, inbound, stream)
        expect(response.statusCode, response.body).toBe(200)
        expect(response.body).not.toContain('gateway_error')
        expect(response.body).toContain('public-model')
        expect(observedPath).toBe('/v1' + paths[protocol])
        expect(
          observedAuth[
            protocol === 'anthropic' ? 'x-api-key' : 'authorization'
          ],
        ).toBe(protocol === 'anthropic' ? 'matrix-key' : 'Bearer matrix-key')
        expect(
          observed[protocol === 'responses' ? 'input' : 'messages'],
        ).toBeDefined()
        if (tools) {
          expect(response.body).toContain('weather')
          expect(response.body).toContain('上海')
        } else expect(response.body).toContain('你好')
        if (stream)
          expect(response.body).toContain(
            inbound === 'openai'
              ? '[DONE]'
              : inbound === 'anthropic'
                ? 'message_stop'
                : 'response.completed',
          )
        else {
          const json = response.json()
          expect(
            inbound === 'openai'
              ? json.choices
              : inbound === 'anthropic'
                ? json.content
                : json.output,
          ).toBeInstanceOf(Array)
        }
        const outputs = stream
          ? response.body.split('\n\n').flatMap((frame) => {
              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('\n')
              return data && data !== '[DONE]' ? [JSON.parse(data)] : []
            })
          : [response.json()]
        const reported = outputs
          .map(
            (value) =>
              value.usage ?? value.response?.usage ?? value.message?.usage,
          )
          .filter(Boolean)
          .reduce((acc, value) => mergeUsage(acc, value), {})
        expect(normalizeUsage(reported, inbound)).toMatchObject({
          input: 10,
          output: 3,
          cache_read_tokens: 2,
          cache_write_tokens: 1,
        })
        const rows = await db.db.execute(
          sql`SELECT status,input_tokens,output_tokens,usage_source,cache_read_tokens,cache_write_tokens,cache_miss_tokens,cache_miss_source,upstream_protocol,raw_usage FROM gw_requests`,
        )
        expect(rows.rows).toEqual([
          {
            status: 'ok',
            input_tokens: '10',
            output_tokens: '3',
            usage_source: 'upstream',
            cache_read_tokens: '2',
            cache_write_tokens: '1',
            cache_miss_tokens: '7',
            cache_miss_source: 'derived',
            upstream_protocol: protocol,
            raw_usage: usage[protocol],
          },
        ])
      })
    }
  test(`${inbound} -> ${protocol}: tool-result followup stays linked`, async () => {
    const token = await configure(protocol)
    const response = await invoke(token, inbound, false, true)
    expect(response.statusCode, response.body).toBe(200)
    expect(JSON.stringify(observed)).toContain('call1')
    expect(JSON.stringify(observed)).toContain('sunny')
    if (protocol === 'responses')
      expect(
        observed.input.some(
          (x: any) =>
            x.type === 'function_call_output' && x.call_id === 'call1',
        ),
      ).toBe(true)
    else if (protocol === 'openai')
      expect(
        observed.messages.some(
          (x: any) => x.role === 'tool' && x.tool_call_id === 'call1',
        ),
      ).toBe(true)
    else
      expect(
        observed.messages.some(
          (x: any) =>
            Array.isArray(x.content) &&
            x.content.some(
              (c: any) => c.type === 'tool_result' && c.tool_use_id === 'call1',
            ),
        ),
      ).toBe(true)
  })
  test(`${inbound} -> ${protocol}: length-limited generation is a terminal partial response`, async () => {
    const token = await configure(protocol)
    mode = 'length'
    const response = await invoke(token, inbound, true)
    expect(response.body).not.toContain('stream_error')
    expect(response.body).toContain(
      inbound === 'openai'
        ? 'length'
        : inbound === 'anthropic'
          ? 'max_tokens'
          : 'response.incomplete',
    )
    const rows = await db.db.execute(sql`SELECT status FROM gw_requests`)
    expect(rows.rows[0]).toEqual({ status: 'ok' })
  })
  for (const stream of [false, true])
    test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} upstream failure stays an error`, async () => {
      const token = await configure(protocol)
      mode = 'error'
      const response = await invoke(token, inbound, stream)
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({ error: { message: 'fixture failure' } })
      const rows = await db.db.execute(sql`SELECT status FROM gw_requests`)
      expect(rows.rows[0]).toEqual({ status: 'upstream_error' })
    })
  if (inbound !== protocol)
    test(`${inbound} -> ${protocol}: truncated stream never signals success`, async () => {
      const token = await configure(protocol)
      mode = 'truncated'
      const response = await invoke(token, inbound, true)
      expect(response.body).toContain('stream_error')
      expect(response.body).not.toContain(
        inbound === 'openai'
          ? '[DONE]'
          : inbound === 'anthropic'
            ? 'message_stop'
            : 'response.completed',
      )
      const rows = await db.db.execute(sql`SELECT status FROM gw_requests`)
      expect(rows.rows[0]).toEqual({ status: 'stream_error' })
    })
}
test('unsupported conversion parameters fail before reserving quota or calling upstream', async () => {
  const token = await configure('anthropic')
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      ...bodyFor('openai', false),
      response_format: { type: 'json_object' },
    },
  })
  expect(response.statusCode).toBe(400)
  expect(response.json().error.code).toBe('unsupported_feature')
  const rows = await db.db.execute(
    sql`SELECT id,status,reserved_tokens,input_tokens,output_tokens,http_status FROM gw_requests`,
  )
  expect(rows.rows).toEqual([
    {
      id: response.json().request_id,
      status: 'protocol_error',
      reserved_tokens: '0',
      input_tokens: '0',
      output_tokens: '0',
      http_status: 400,
    },
  ])
})

for (const { inbound, upstream: protocol } of matrix.filter(
  (p) => p.inbound !== p.upstream,
)) {
  test(`${inbound} -> ${protocol}: real client disconnect aborts conversion and upstream`, async () => {
    const token = await configure(protocol)
    mode = 'endless'
    const controller = new AbortController()
    const response = await fetch(gatewayBase + '/v1' + paths[inbound], {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(bodyFor(inbound, true)),
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    controller.abort()
    await reader.cancel().catch(() => {})
    await expect
      .poll(
        async () =>
          (await db.db.execute(sql`SELECT status FROM gw_requests`)).rows[0]
            ?.status,
        { timeout: 3000 },
      )
      .toBe('client_error')
    await expect.poll(() => upstreamClosed, { timeout: 3000 }).toBe(true)
  })
  test(`${inbound} -> ${protocol}: failed settlement withholds converted success`, async () => {
    const token = await configure(protocol)
    const service = new GatewayService(db.db, {
      encryptionKey: 'matrix-accounting',
      allowPrivate: true,
      timeoutMs: 5000,
      idleTimeoutMs: 1000,
    })
    await service.repo.saveUpstream(
      {
        name: 'matrix',
        protocol,
        base_url: base,
        secret: service.vault.encrypt('matrix-key'),
      },
      1,
    )
    const persist = vi
      .spyOn(service.repo, 'finish')
      .mockRejectedValue(new Error('accounting unavailable'))
    try {
      const result = await service.execute(
        await service.authenticate(token),
        bodyFor(inbound, true),
        inbound,
        new AbortController().signal,
      )
      let body = ''
      for await (const frame of result.stream!) body += frame
      expect(body).toContain('settlement_failed')
      expect(body).not.toContain(
        inbound === 'openai'
          ? '[DONE]'
          : inbound === 'anthropic'
            ? 'message_stop'
            : 'response.completed',
      )
      const rows = await db.db.execute(sql`SELECT status FROM gw_requests`)
      expect(rows.rows[0]).toEqual({ status: 'reserved' })
    } finally {
      persist.mockRestore()
      await service.transport.close()
    }
  })
}
test('capability filtering precedes the three-attempt limit', async () => {
  const token = await configure('anthropic')
  for (const protocol of ['anthropic', 'anthropic', 'openai']) {
    const u = await session.inject({
      method: 'POST',
      url: '/api/admin/gateway/upstreams',
      payload: {
        name: 'fallback',
        supported_models: [protocol],
        protocol,
        base_url: base,
        api_key: 'matrix-key',
      },
    })
    expect(u.statusCode).toBe(201)
    const r = await session.inject({
      method: 'POST',
      url: '/api/admin/gateway/routes',
      payload: {
        model: 'public-model',
        upstream_id: u.json().id,
        upstream_model: protocol,
      },
    })
    expect(r.statusCode).toBe(201)
  }
  const result = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      ...bodyFor('openai', false),
      response_format: { type: 'json_object' },
    },
  })
  expect(result.statusCode, result.body).toBe(200)
  expect(observed.model).toBe('openai')
})
test('legacy Anthropic path uses the same cross-protocol handler', async () => {
  const token = await configure('openai')
  const result = await app.inject({
    method: 'POST',
    url: '/api/agent/anthropic/v1/messages',
    headers: { 'x-api-key': token },
    payload: bodyFor('anthropic', false),
  })
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json().type).toBe('message')
  expect(result.json().content).toEqual([{ type: 'text', text: '你好' }])
})
test('conversion defaults cannot exceed the output allowance reserved by the gateway', async () => {
  const token = await configure('anthropic')
  const result = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      model: 'public-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_output_tokens: 1,
    },
  })
  expect(result.statusCode).toBe(200)
  expect(observed.max_tokens).toBe(1)
})

for (const { inbound, upstream: protocol } of matrix) {
  for (const stream of [false, true]) {
    for (const profile of ['full', 'zero', 'unknown']) {
      test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} cache usage ${profile}`, async () => {
        const token = await configure(protocol)
        const zero = profile === 'zero'
        if (profile === 'unknown') usage[protocol] = {}
        else {
          const input = zero ? 0 : protocol === 'anthropic' ? 7 : 10
          usage[protocol] = {
            ...(protocol === 'openai'
              ? { prompt_tokens: input, completion_tokens: zero ? 0 : 3 }
              : { input_tokens: input, output_tokens: zero ? 0 : 3 }),
            cache_read_input_tokens: zero ? 0 : 2,
            cache_creation_input_tokens: zero ? 0 : 1,
            cache_creation: {
              ephemeral_5m_input_tokens: zero ? 0 : 1,
              ephemeral_1h_input_tokens: 0,
            },
            reasoning_tokens: zero ? 0 : 1,
          }
        }
        const response = await invoke(token, inbound, stream)
        expect(response.statusCode, response.body).toBe(200)
        const rows = await db.db.execute(sql`SELECT * FROM gw_requests`)
        expect(rows.rows).toHaveLength(1)
        const row = rows.rows[0]!
        expect(row.status).toBe('ok')
        const fields = [
          'cache_read_tokens',
          'cache_write_tokens',
          'cache_miss_tokens',
          'cache_write_5m_tokens',
          'cache_write_1h_tokens',
          'reasoning_tokens',
        ]
        if (profile === 'unknown') {
          for (const field of fields) expect(row[field], field).toBeNull()
          expect(row.cache_miss_source).toBeNull()
          expect(row.usage_source).toBe('estimated')
          const values = stream
            ? response.body.split('\n\n').flatMap((frame) => {
                const data = frame
                  .split('\n')
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trim())
                  .join('\n')
                return data && data !== '[DONE]' ? [JSON.parse(data)] : []
              })
            : [response.json()]
          const reported = values
            .map(
              (value) =>
                value.usage ?? value.response?.usage ?? value.message?.usage,
            )
            .filter(Boolean)
            .reduce((acc, value) => mergeUsage(acc, value), {})
          expect(normalizeUsage(reported, inbound)).toMatchObject({
            input: null,
            output: protocol === 'anthropic' && stream ? 0 : null,
          })
          for (const field of fields)
            expect(
              normalizeUsage(reported, inbound)[
                field as keyof ReturnType<typeof normalizeUsage>
              ],
              field,
            ).toBeNull()
        } else {
          expect(row).toMatchObject({
            input_tokens: zero ? '0' : '10',
            output_tokens: zero ? '0' : '3',
            cache_read_tokens: zero ? '0' : '2',
            cache_write_tokens: zero ? '0' : '1',
            cache_miss_tokens: zero ? '0' : '7',
            cache_write_5m_tokens: zero ? '0' : '1',
            cache_write_1h_tokens: '0',
            reasoning_tokens: zero ? '0' : '1',
            cache_miss_source: 'derived',
            usage_source: 'upstream',
          })
          const values = stream
            ? response.body.split('\n\n').flatMap((frame) => {
                const data = frame
                  .split('\n')
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trim())
                  .join('\n')
                return data && data !== '[DONE]' ? [JSON.parse(data)] : []
              })
            : [response.json()]
          const reported = values
            .map(
              (value) =>
                value.usage ?? value.response?.usage ?? value.message?.usage,
            )
            .filter(Boolean)
            .reduce((acc, value) => mergeUsage(acc, value), {})
          expect(normalizeUsage(reported, inbound)).toMatchObject({
            input: zero ? 0 : 10,
            output: zero ? 0 : 3,
            cache_read_tokens: zero ? 0 : 2,
            cache_write_tokens: zero ? 0 : 1,
            cache_miss_tokens: zero ? 0 : 7,
            cache_write_5m_tokens: zero ? 0 : 1,
            cache_write_1h_tokens: 0,
            reasoning_tokens: zero ? 0 : 1,
          })
        }
      })
    }
  }
}

function wireEvents(body: string) {
  return body.split('\n\n').flatMap((frame) => {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    return data && data !== '[DONE]' ? [JSON.parse(data)] : []
  })
}
function toolFromWire(inbound: Protocol, body: string, stream: boolean) {
  if (!stream) {
    const response = JSON.parse(body)
    if (inbound === 'openai') {
      const call = response.choices[0].message.tool_calls[0]
      return {
        id: call.id,
        name: call.function.name,
        args: JSON.parse(call.function.arguments),
      }
    }
    if (inbound === 'anthropic') {
      const call = response.content.find((x: any) => x.type === 'tool_use')
      return { id: call.id, name: call.name, args: call.input }
    }
    const call = response.output.find((x: any) => x.type === 'function_call')
    return {
      id: call.call_id,
      name: call.name,
      args: JSON.parse(call.arguments),
    }
  }
  const events = wireEvents(body)
  let id = '',
    name = '',
    args = ''
  for (const event of events) {
    if (inbound === 'openai') {
      for (const call of event.choices?.[0]?.delta?.tool_calls ?? []) {
        if (call.id) id = call.id
        if (call.function?.name) name += call.function.name
        args += call.function?.arguments ?? ''
      }
    } else if (inbound === 'anthropic') {
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use'
      ) {
        id = event.content_block.id
        name = event.content_block.name
      }
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'input_json_delta'
      )
        args += event.delta.partial_json
    } else {
      if (
        event.type === 'response.output_item.added' &&
        event.item.type === 'function_call'
      ) {
        id = event.item.call_id
        name = event.item.name
      }
      if (event.type === 'response.function_call_arguments.delta')
        args += event.delta
    }
  }
  return { id, name, args: JSON.parse(args) }
}
for (const { inbound, upstream: protocol } of matrix) {
  for (const stream of [false, true]) {
    test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} actual tool call/result roundtrip`, async () => {
      const token = await configure(protocol)
      mode = 'tools'
      const first = await invoke(token, inbound, stream)
      expect(first.statusCode, first.body).toBe(200)
      const call = toolFromWire(inbound, first.body, stream)
      expect(call).toEqual({
        id: 'call1',
        name: 'weather',
        args: { city: '上海' },
      })
      const payload: any = bodyFor(inbound, stream)
      const result = `sunny in ${call.args.city}`
      if (inbound === 'openai')
        payload.messages.push(
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                },
              },
            ],
          },
          { role: 'tool', tool_call_id: call.id, content: result },
        )
      else if (inbound === 'anthropic')
        payload.messages.push(
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: call.args,
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: call.id, content: result },
            ],
          },
        )
      else
        payload.input.push(
          {
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.args),
          },
          { type: 'function_call_output', call_id: call.id, output: result },
        )
      mode = 'text'
      const second = await app.inject({
        method: 'POST',
        url: '/v1' + paths[inbound],
        headers: { authorization: `Bearer ${token}` },
        payload,
      })
      expect(second.statusCode, second.body).toBe(200)
      expect(second.body).toContain('你好')
      if (protocol === 'openai') {
        const previous = observed.messages.find((x: any) => x.tool_calls)
          ?.tool_calls[0]
        expect(previous.id).toBe(call.id)
        expect(JSON.parse(previous.function.arguments)).toEqual(call.args)
        expect(
          observed.messages.find((x: any) => x.role === 'tool'),
        ).toMatchObject({ tool_call_id: call.id, content: result })
      } else if (protocol === 'anthropic') {
        const blocks = observed.messages.flatMap((x: any) =>
          Array.isArray(x.content) ? x.content : [],
        )
        expect(blocks.find((x: any) => x.type === 'tool_use')).toMatchObject({
          id: call.id,
          name: call.name,
          input: call.args,
        })
        expect(blocks.find((x: any) => x.type === 'tool_result')).toMatchObject(
          { tool_use_id: call.id, content: result },
        )
      } else {
        const previous = observed.input.find(
          (x: any) => x.type === 'function_call',
        )
        expect(previous.call_id).toBe(call.id)
        expect(JSON.parse(previous.arguments)).toEqual(call.args)
        expect(
          observed.input.find((x: any) => x.type === 'function_call_output'),
        ).toMatchObject({ call_id: call.id, output: result })
      }
      const rows = await db.db.execute(
        sql`SELECT status,input_tokens,output_tokens FROM gw_requests`,
      )
      expect(rows.rows).toHaveLength(2)
      for (const row of rows.rows)
        expect(row).toEqual({
          status: 'ok',
          input_tokens: '10',
          output_tokens: '3',
        })
    })
  }
}

function parallelFromWire(protocol: Protocol, body: string, stream: boolean) {
  if (!stream) {
    const value = JSON.parse(body)
    if (protocol === 'openai')
      return value.choices[0].message.tool_calls.map((call: any) => ({
        id: call.id,
        name: call.function.name,
        args: JSON.parse(call.function.arguments),
      }))
    if (protocol === 'anthropic')
      return value.content
        .filter((call: any) => call.type === 'tool_use')
        .map((call: any) => ({
          id: call.id,
          name: call.name,
          args: call.input,
        }))
    return value.output
      .filter((call: any) => call.type === 'function_call')
      .map((call: any) => ({
        id: call.call_id,
        name: call.name,
        args: JSON.parse(call.arguments),
      }))
  }
  const calls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >()
  for (const event of wireEvents(body)) {
    if (protocol === 'openai')
      for (const call of event.choices?.[0]?.delta?.tool_calls ?? []) {
        const state = calls.get(call.index) ?? {
          id: '',
          name: '',
          arguments: '',
        }
        if (call.id) state.id = call.id
        state.name += call.function?.name ?? ''
        state.arguments += call.function?.arguments ?? ''
        calls.set(call.index, state)
      }
    else if (protocol === 'anthropic') {
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use'
      )
        calls.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          arguments: '',
        })
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'input_json_delta'
      )
        calls.get(event.index)!.arguments += event.delta.partial_json
    } else {
      if (
        event.type === 'response.output_item.added' &&
        event.item.type === 'function_call'
      )
        calls.set(event.output_index, {
          id: event.item.call_id,
          name: event.item.name,
          arguments: '',
        })
      if (event.type === 'response.function_call_arguments.delta')
        calls.get(event.output_index)!.arguments += event.delta
    }
  }
  return [...calls.values()].map((call) => ({
    id: call.id,
    name: call.name,
    args: JSON.parse(call.arguments),
  }))
}
for (const { inbound, upstream: protocol } of matrix)
  for (const stream of [false, true]) {
    test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} parallel interleaved tools with reversed results`, async () => {
      const token = await configure(protocol)
      mode = 'parallel'
      const first = await invoke(token, inbound, stream)
      expect(first.statusCode, first.body).toBe(200)
      const calls = parallelFromWire(inbound, first.body, stream).sort(
        (a: any, b: any) => a.id.localeCompare(b.id),
      )
      expect(calls).toEqual(parallelCalls)
      const payload: any = bodyFor(inbound, stream)
      const reversed = [...calls].reverse()
      if (inbound === 'openai')
        payload.messages.push(
          {
            role: 'assistant',
            content: '',
            tool_calls: calls.map((call: any) => ({
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            })),
          },
          ...reversed.map((call) => ({
            role: 'tool',
            tool_call_id: call.id,
            content: call.args.city,
          })),
        )
      else if (inbound === 'anthropic')
        payload.messages.push(
          {
            role: 'assistant',
            content: calls.map((call: any) => ({
              type: 'tool_use',
              id: call.id,
              name: call.name,
              input: call.args,
            })),
          },
          {
            role: 'user',
            content: reversed.map((call) => ({
              type: 'tool_result',
              tool_use_id: call.id,
              content: call.args.city,
            })),
          },
        )
      else
        payload.input.push(
          ...calls.map((call: any) => ({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.args),
          })),
          ...reversed.map((call) => ({
            type: 'function_call_output',
            call_id: call.id,
            output: call.args.city,
          })),
        )
      mode = 'text'
      const second = await app.inject({
        method: 'POST',
        url: '/v1' + paths[inbound],
        headers: { authorization: `Bearer ${token}` },
        payload,
      })
      expect(second.statusCode, second.body).toBe(200)
      const history =
        protocol === 'openai'
          ? observed.messages
              .flatMap((item: any) => item.tool_calls ?? [])
              .map((call: any) => ({
                id: call.id,
                name: call.function.name,
                args: JSON.parse(call.function.arguments),
              }))
          : protocol === 'anthropic'
            ? observed.messages
                .flatMap((item: any) =>
                  Array.isArray(item.content) ? item.content : [],
                )
                .filter((call: any) => call.type === 'tool_use')
                .map((call: any) => ({
                  id: call.id,
                  name: call.name,
                  args: call.input,
                }))
            : observed.input
                .filter((call: any) => call.type === 'function_call')
                .map((call: any) => ({
                  id: call.call_id,
                  name: call.name,
                  args: JSON.parse(call.arguments),
                }))
      expect(
        history.sort((a: any, b: any) => a.id.localeCompare(b.id)),
      ).toEqual(calls)
      const results =
        protocol === 'openai'
          ? observed.messages
              .filter((item: any) => item.role === 'tool')
              .map((item: any) => ({
                id: item.tool_call_id,
                result: item.content,
              }))
          : protocol === 'anthropic'
            ? observed.messages
                .flatMap((item: any) =>
                  Array.isArray(item.content) ? item.content : [],
                )
                .filter((item: any) => item.type === 'tool_result')
                .map((item: any) => ({
                  id: item.tool_use_id,
                  result: item.content,
                }))
            : observed.input
                .filter((item: any) => item.type === 'function_call_output')
                .map((item: any) => ({ id: item.call_id, result: item.output }))
      expect(results).toEqual(
        reversed.map((call) => ({ id: call.id, result: call.args.city })),
      )
      const rows = await db.db.execute(
        sql`SELECT status,input_tokens,output_tokens FROM gw_requests`,
      )
      expect(rows.rows).toHaveLength(2)
      for (const row of rows.rows)
        expect(row).toEqual({
          status: 'ok',
          input_tokens: '10',
          output_tokens: '3',
        })
    })
  }

for (const { inbound, upstream: protocol } of matrix)
  for (const stream of [false, true])
    for (const fault of ['rejected', 'unchanged']) {
      test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} ${fault} settlement failure cannot become unbilled success or failure`, async () => {
        const token = await configure(protocol)
        const persist = vi.spyOn(GatewayRepository.prototype, 'finish')
        if (fault === 'rejected')
          persist.mockRejectedValueOnce(new Error('private database failure'))
        else persist.mockResolvedValueOnce([])
        try {
          const response = await invoke(token, inbound, stream)
          expect(response.body).toContain('settlement_failed')
          expect(response.body).not.toContain('private database failure')
          if (stream) {
            expect(response.statusCode).toBe(200)
            expect(response.body).not.toContain(
              inbound === 'openai'
                ? '[DONE]'
                : inbound === 'anthropic'
                  ? 'message_stop'
                  : 'response.completed',
            )
          } else {
            expect(response.statusCode).toBe(500)
            expect(response.json().error.code).toBe('settlement_failed')
          }
          expect(persist).toHaveBeenCalledTimes(1)
          const rows = await db.db.execute(
            sql`SELECT id,status,input_tokens,output_tokens,reserved_tokens FROM gw_requests`,
          )
          expect(rows.rows).toHaveLength(1)
          expect(rows.rows[0]).toMatchObject({
            status: 'reserved',
            input_tokens: '0',
            output_tokens: '0',
          })
          expect(Number(rows.rows[0]!.reserved_tokens)).toBeGreaterThan(0)
          expect(response.body).toContain(rows.rows[0]!.id)
          expect(
            (
              await db.db.execute(
                sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
              )
            ).rows[0]!.n,
          ).toBe(0)
        } finally {
          persist.mockRestore()
        }
      })
    }

for (const { inbound, upstream: protocol } of matrix)
  for (const stream of [false, true]) {
    test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} truncated response never confirms success`, async () => {
      const token = await configure(protocol)
      const backup = await session.inject({
        method: 'POST',
        url: '/api/admin/gateway/upstreams',
        payload: {
          name: 'backup',
          supported_models: [protocol],
          protocol,
          base_url: base,
          api_key: 'backup-key',
        },
      })
      expect(backup.statusCode).toBe(201)
      expect(
        (
          await session.inject({
            method: 'POST',
            url: '/api/admin/gateway/routes',
            payload: {
              model: 'public-model',
              upstream_id: backup.json().id,
              upstream_model: protocol,
              priority: 999,
            },
          })
        ).statusCode,
      ).toBe(201)
      mode = 'truncated'
      const response = await invoke(token, inbound, stream)
      expect(upstreamCalls).toBe(1)
      if (stream) {
        expect(response.statusCode).toBe(200)
        expect(response.body).toContain('stream_error')
        expect(response.body).not.toContain(
          inbound === 'openai'
            ? '[DONE]'
            : inbound === 'anthropic'
              ? 'message_stop'
              : 'response.completed',
        )
      } else {
        expect(response.statusCode).toBe(502)
        expect(response.json().error).toBeDefined()
      }
      const rows = await db.db.execute(
        sql`SELECT id,status,http_status FROM gw_requests`,
      )
      expect(rows.rows).toHaveLength(1)
      expect(rows.rows[0]).toMatchObject({
        status: stream ? 'stream_error' : 'upstream_error',
        http_status: stream ? 200 : 502,
      })
      expect(response.body).toContain(rows.rows[0]!.id)
      const attempts = await db.db.execute(
        sql`SELECT status,error FROM gw_attempts`,
      )
      expect(attempts.rows).toHaveLength(1)
      expect(attempts.rows[0]!.status).toBe(200)
      expect(attempts.rows[0]!.error).toBeTruthy()
      expect(
        (
          await db.db.execute(
            sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
          )
        ).rows[0]!.n,
      ).toBe(0)
    })
  }

for (const { inbound, upstream: protocol } of matrix)
  for (const stream of [false, true]) {
    test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} live cancellation closes upstream and releases admission`, async () => {
      const token = await configure(protocol)
      mode = 'endless'
      const controller = new AbortController()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const pending = fetch(gatewayBase + '/v1' + paths[inbound], {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(bodyFor(inbound, stream)),
        signal: controller.signal,
      }).then(
        (response) => ({ response, error: null }),
        (error) => ({ response: null, error }),
      )
      try {
        if (stream) {
          const result = await pending
          expect(result.response?.status).toBe(200)
          reader = result.response!.body!.getReader()
          const first = await reader.read()
          expect(first.done).toBe(false)
          expect(new TextDecoder().decode(first.value)).not.toMatch(
            /\[DONE\]|message_stop|response.completed/,
          )
        } else await expect.poll(() => upstreamCalls, { timeout: 3000 }).toBe(1)
        controller.abort()
        if (reader) await reader.cancel().catch(() => {})
        else expect((await pending).error).toBeTruthy()
        await expect
          .poll(
            async () =>
              (await db.db.execute(sql`SELECT status FROM gw_requests`)).rows[0]
                ?.status,
            { timeout: 3000 },
          )
          .toBe('client_error')
        await expect.poll(() => upstreamClosed, { timeout: 3000 }).toBe(true)
        expect(upstreamCalls).toBe(1)
        expect(
          (
            await db.db.execute(
              sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
            )
          ).rows[0]!.n,
        ).toBe(0)
        const requests = await db.db.execute(
          sql`SELECT http_status FROM gw_requests`,
        )
        expect(requests.rows).toEqual([{ http_status: stream ? 200 : null }])
        expect(
          (
            await db.db.execute(
              sql`SELECT count(*)::int AS n FROM gw_requests WHERE status='reserved'`,
            )
          ).rows[0]!.n,
        ).toBe(0)
      } finally {
        controller.abort()
        await reader?.cancel().catch(() => {})
        await pending
      }
    })
  }

for (const { inbound, upstream: protocol } of matrix)
  for (const stream of [false, true])
    for (const variant of ['png', 'auto', 'opaque'] as const) {
      test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} ${variant} URL and base64 images reach upstream without gateway fetch`, async () => {
        const token = await configure(protocol, variant === 'auto')
        const url = base.replace(/\/v1$/, '') + '/image.png'
        const media =
          variant === 'opaque' ? 'application/x-fixture' : 'image/png'
        const data =
          variant === 'opaque'
            ? 'opaque-not-validated-base64'
            : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5p0AAAAASUVORK5CYII='
        const dataUrl = `data:${media};base64,${data}`
        const content =
          inbound === 'anthropic'
            ? [
                { type: 'text', text: 'compare' },
                { type: 'image', source: { type: 'url', url } },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: media, data },
                },
              ]
            : inbound === 'openai'
              ? [
                  { type: 'text', text: 'compare' },
                  { type: 'image_url', image_url: { url } },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ]
              : [
                  { type: 'input_text', text: 'compare' },
                  { type: 'input_image', image_url: url },
                  { type: 'input_image', image_url: dataUrl },
                ]
        const payload: any = bodyFor(inbound, stream)
        if (variant === 'auto') payload.model = 'coati-auto'
        if (inbound === 'responses') payload.input = [{ role: 'user', content }]
        else payload.messages = [{ role: 'user', content }]
        const response = await app.inject({
          method: 'POST',
          url: '/v1' + paths[inbound],
          headers: { authorization: `Bearer ${token}` },
          payload,
        })
        expect(response.statusCode, response.body).toBe(200)
        expect(response.body).toContain('你好')
        const blocks = (
          protocol === 'responses' ? observed.input : observed.messages
        ).flatMap((item: any) =>
          Array.isArray(item.content) ? item.content : [],
        )
        if (protocol === 'anthropic')
          expect(blocks.filter((item: any) => item.type === 'image')).toEqual([
            { type: 'image', source: { type: 'url', url } },
            {
              type: 'image',
              source: { type: 'base64', media_type: media, data },
            },
          ])
        else {
          const images = blocks.filter(
            (item: any) =>
              item.type ===
              (protocol === 'openai' ? 'image_url' : 'input_image'),
          )
          expect(
            images.map((item: any) =>
              typeof item.image_url === 'string'
                ? item.image_url
                : item.image_url.url,
            ),
          ).toEqual([url, dataUrl])
        }
        expect(imageFetches).toBe(0)
        expect(upstreamCalls).toBe(1)
        const rows = await db.db.execute(
          sql`SELECT status,request_context FROM gw_requests`,
        )
        expect(rows.rows[0]).toMatchObject({
          status: 'ok',
          request_context: { image_count: 2, message_count: 1 },
        })
        expect(JSON.stringify(rows.rows)).not.toContain(data)
        expect(JSON.stringify(rows.rows)).not.toContain(url)
      })
    }

// MAX_CONTENT_LENGTH bounds the encoded HTTP body, not decoded image bytes.
for (const inbound of ['openai', 'responses', 'anthropic'] as const)
  for (const stream of [false, true]) {
    test(`${inbound} ${stream ? 'SSE' : 'JSON'} image request respects exact encoded body byte limit`, async () => {
      const token = await configure(inbound)
      const limited = await buildTestApp({ maxContentLength: 2048 })
      try {
        const content =
          inbound === 'anthropic'
            ? [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'opaque',
                  },
                },
              ]
            : [
                {
                  type: inbound === 'responses' ? 'input_image' : 'image_url',
                  image_url:
                    inbound === 'responses'
                      ? 'data:image/png;base64,opaque'
                      : { url: 'data:image/png;base64,opaque' },
                },
              ]
        const payload: any = bodyFor(inbound, stream)
        if (inbound === 'responses') payload.input = [{ role: 'user', content }]
        else payload.messages = [{ role: 'user', content }]
        const json = JSON.stringify(payload)
        const exact = json + ' '.repeat(2048 - Buffer.byteLength(json))
        const request = (body: string) =>
          limited.inject({
            method: 'POST',
            url: '/v1' + paths[inbound],
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            payload: body,
          })
        expect((await request(exact)).statusCode).toBe(200)
        expect(upstreamCalls).toBe(1)
        expect((await request(exact + ' ')).statusCode).toBe(413)
        expect(upstreamCalls).toBe(1)
        expect(imageFetches).toBe(0)
        expect(
          (await db.db.execute(sql`SELECT count(*)::int AS n FROM gw_requests`))
            .rows[0]!.n,
        ).toBe(1)
        expect(
          (
            await db.db.execute(
              sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
            )
          ).rows[0]!.n,
        ).toBe(0)
      } finally {
        await limited.close()
      }
    })
  }

for (const { inbound, upstream: protocol } of matrix) {
  test(`${inbound} -> ${protocol}: JSON reasoning response and replay preserve supported content`, async () => {
    const token = await configure(protocol)
    mode = 'reasoning'
    const policyHeaders: Record<string, string> =
      inbound === 'openai' && protocol !== 'openai'
        ? { 'x-coati-reasoning-policy': 'text-only' }
        : {}
    const first = await invoke(token, inbound, false, false, policyHeaders)
    expect(first.statusCode, first.body).toBe(200)
    const result = first.json()
    expect(result.model).toBe('public-model')
    const followup: any = bodyFor(inbound, false)
    if (inbound === 'openai') {
      expect(result.choices[0].message).toMatchObject({
        content: answer,
        reasoning_content: thought,
      })
      followup.messages = [
        { role: 'user', content: 'question' },
        result.choices[0].message,
        { role: 'user', content: 'continue' },
      ]
    } else if (inbound === 'anthropic') {
      if (protocol === 'openai')
        expect(result.content).toEqual([
          { type: 'text', text: thought },
          { type: 'text', text: answer },
        ])
      else
        expect(result.content).toEqual([
          { type: 'thinking', thinking: thought, signature },
          { type: 'text', text: answer },
        ])
      followup.messages = [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: result.content },
        { role: 'user', content: 'continue' },
      ]
    } else {
      const reasoning = result.output.find(
        (item: any) => item.type === 'reasoning',
      )
      expect(reasoning.summary).toEqual([
        { type: 'summary_text', text: thought },
      ])
      if (protocol !== 'openai')
        expect(reasoning.encrypted_content).toBe(signature)
      else expect(reasoning.encrypted_content).toBeUndefined()
      expect(
        result.output.find((item: any) => item.type === 'message').content[0]
          .text,
      ).toBe(answer)
      followup.input = [
        { role: 'user', content: 'question' },
        ...result.output,
        { role: 'user', content: 'continue' },
      ]
    }
    const second = await app.inject({
      method: 'POST',
      url: '/v1' + paths[inbound],
      headers: { authorization: `Bearer ${token}`, ...policyHeaders },
      payload: followup,
    })
    expect(second.statusCode, second.body).toBe(200)
    if (protocol === 'openai') {
      const messages = observed.messages.filter(
        (message: any) => message.role === 'assistant',
      )
      expect(JSON.stringify(messages)).toContain(thought)
      expect(JSON.stringify(messages)).toContain(answer)
    } else if (protocol === 'anthropic') {
      const blocks = observed.messages
        .filter((message: any) => message.role === 'assistant')
        .flatMap((message: any) => message.content)
      if (inbound === 'openai') {
        expect(blocks).toContainEqual({ type: 'text', text: thought })
        expect(blocks.some((block: any) => block.type === 'thinking')).toBe(
          false,
        )
      } else
        expect(blocks).toContainEqual({
          type: 'thinking',
          thinking: thought,
          signature,
        })
      expect(blocks).toContainEqual({ type: 'text', text: answer })
    } else {
      const reasoning = observed.input.find(
        (item: any) => item.type === 'reasoning',
      )
      expect(reasoning.summary).toEqual([
        { type: 'summary_text', text: thought },
      ])
      // Preserve supported opaque fields when replaying Messages/Responses history.
      if (inbound !== 'openai')
        expect(reasoning.encrypted_content).toBe(signature)
      else expect(reasoning.encrypted_content).toBeUndefined()
    }
    expect(upstreamCalls).toBe(2)
    expect(
      (
        await db.db.execute(
          sql`SELECT count(*)::int AS n FROM gw_requests WHERE status='ok'`,
        )
      ).rows[0]!.n,
    ).toBe(2)
  })
}

for (const { inbound, upstream: protocol } of matrix) {
  test(`${inbound} -> ${protocol}: SSE reasoning fragments and actual replay history`, async () => {
    const token = await configure(protocol)
    mode = 'reasoning'
    const policyHeaders: Record<string, string> =
      inbound === 'openai' && protocol !== 'openai'
        ? { 'x-coati-reasoning-policy': 'text-only' }
        : {}
    const first = await invoke(token, inbound, true, false, policyHeaders)
    expect(first.statusCode, first.body).toBe(200)
    const events = wireEvents(first.body)
    expect(first.body).not.toContain('gateway_error')
    const followup: any = bodyFor(inbound, false)
    if (inbound === 'openai') {
      const deltas = events
        .flatMap((event: any) => event.choices ?? [])
        .map((choice: any) => choice.delta ?? {})
      const message = {
        role: 'assistant',
        content: deltas.map((delta: any) => delta.content ?? '').join(''),
        reasoning_content: deltas
          .map((delta: any) => delta.reasoning_content ?? '')
          .join(''),
      }
      expect(message).toMatchObject({
        content: answer,
        reasoning_content: thought,
      })
      expect(first.body).toContain('data: [DONE]')
      followup.messages = [
        { role: 'user', content: 'question' },
        message,
        { role: 'user', content: 'continue' },
      ]
    } else if (inbound === 'anthropic') {
      const blocks: any[] = []
      for (const event of events) {
        if (event.type === 'content_block_start')
          blocks[event.index] = { ...event.content_block }
        if (event.type === 'content_block_delta') {
          const delta = event.delta
          const field =
            delta.type === 'thinking_delta'
              ? 'thinking'
              : delta.type === 'signature_delta'
                ? 'signature'
                : 'text'
          blocks[event.index][field] =
            (blocks[event.index][field] ?? '') + delta[field]
        }
      }
      if (protocol !== 'openai')
        expect(blocks).toEqual([
          { type: 'thinking', thinking: thought, signature },
          { type: 'text', text: answer },
        ])
      else
        expect(blocks).toEqual([
          { type: 'text', text: thought },
          { type: 'text', text: answer },
        ])
      expect(
        events.filter((event: any) => event.type === 'message_stop'),
      ).toHaveLength(1)
      followup.messages = [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: blocks },
        { role: 'user', content: 'continue' },
      ]
    } else {
      const completed = events.filter(
        (event: any) => event.type === 'response.completed',
      )
      expect(completed).toHaveLength(1)
      const output = completed[0].response.output
      const reasoning = output.find((item: any) => item.type === 'reasoning')
      expect(reasoning.summary).toEqual([
        { type: 'summary_text', text: thought },
      ])
      if (protocol !== 'openai')
        expect(reasoning.encrypted_content).toBe(signature)
      else expect(reasoning.encrypted_content).toBeUndefined()
      expect(
        output.find((item: any) => item.type === 'message').content[0].text,
      ).toBe(answer)
      followup.input = [
        { role: 'user', content: 'question' },
        ...output,
        { role: 'user', content: 'continue' },
      ]
    }
    const second = await app.inject({
      method: 'POST',
      url: '/v1' + paths[inbound],
      headers: { authorization: `Bearer ${token}`, ...policyHeaders },
      payload: followup,
    })
    expect(second.statusCode, second.body).toBe(200)
    const history = JSON.stringify(
      protocol === 'responses' ? observed.input : observed.messages,
    )
    expect(history).toContain(thought)
    expect(history).toContain(answer)
    if (
      (protocol === inbound && protocol !== 'openai') ||
      (protocol !== 'openai' && inbound !== 'openai')
    )
      expect(history).toContain(signature)
    else expect(history).not.toContain(signature)
    expect(upstreamCalls).toBe(2)
    expect(
      (
        await db.db.execute(
          sql`SELECT count(*)::int AS n FROM gw_requests WHERE status='ok'`,
        )
      ).rows[0]!.n,
    ).toBe(2)
  })
}

test('conflicting Responses reasoning completion fails Messages SSE without a successful terminal', async () => {
  const token = await configure('responses')
  mode = 'reasoning-conflict'
  const response = await invoke(token, 'anthropic', true)
  expect(response.statusCode).toBe(200)
  expect(response.body).toContain('stream_error')
  expect(response.body).toContain('上游推理完成数据不一致')
  expect(response.body).not.toContain('event: message_stop')
  expect(response.body).not.toContain('conflicting-opaque-data')
  expect(upstreamCalls).toBe(1)
  expect(
    (await db.db.execute(sql`SELECT status FROM gw_requests`)).rows[0]!.status,
  ).toBe('stream_error')
  expect(
    (
      await db.db.execute(
        sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
      )
    ).rows[0]!.n,
  ).toBe(0)
})

for (const behavior of ['reasoning-late', 'reasoning-terminal-only'])
  test(`Responses to Messages ${behavior} preserves wire block order and settles`, async () => {
    const token = await configure('responses')
    mode = behavior
    const response = await invoke(token, 'anthropic', true)
    expect(response.statusCode, response.body).toBe(200)
    const events = wireEvents(response.body)
    expect(
      events
        .filter((event: any) => event.type === 'content_block_start')
        .map((event: any) => event.content_block.type),
    ).toEqual(['thinking', 'text'])
    expect(
      events
        .filter((event: any) => event.delta?.signature)
        .map((event: any) => event.delta.signature)
        .join(''),
    ).toBe(signature)
    expect(
      events.filter((event: any) => event.type === 'message_stop'),
    ).toHaveLength(1)
    expect(upstreamCalls).toBe(1)
    expect(
      (await db.db.execute(sql`SELECT status FROM gw_requests`)).rows[0]!
        .status,
    ).toBe('ok')
  })

for (const invalid of [false, true])
  test(`Messages interleaved thinking ${invalid ? 'invalid sequence' : 'ordered output'} through actual gateway`, async () => {
    const token = await configure('anthropic')
    mode = invalid ? 'thinking-invalid' : 'thinking-interleaved'
    const response = await invoke(token, 'responses', true)
    expect(response.statusCode, response.body).toBe(200)
    const events = wireEvents(response.body)
    if (invalid) {
      expect(response.body).toContain('上游推理块序列无效')
      expect(
        events.some((event: any) => event.type === 'response.completed'),
      ).toBe(false)
    } else {
      const output = events.find(
        (event: any) => event.type === 'response.completed',
      ).response.output
      expect(output.map((item: any) => item.type)).toEqual([
        'reasoning',
        'reasoning',
        'message',
      ])
      expect(
        output.slice(0, 2).map((item: any) => item.encrypted_content),
      ).toEqual(['sig-a', 'sig-b'])
    }
    expect(upstreamCalls).toBe(1)
    expect(
      (await db.db.execute(sql`SELECT status FROM gw_requests`)).rows[0]!
        .status,
    ).toBe(invalid ? 'stream_error' : 'ok')
    expect(
      (
        await db.db.execute(
          sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
        )
      ).rows[0]!.n,
    ).toBe(0)
  })

for (const protocol of ['openai', 'responses', 'anthropic'] as const)
  for (const stream of [false, true]) {
    test(`Messages redacted request to ${protocol} ${stream ? 'SSE' : 'JSON'} is native or explicit refusal`, async () => {
      const token = await configure(protocol)
      const payload = bodyFor('anthropic', stream) as any
      payload.messages = [
        {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'opaque-redacted-value' },
          ],
        },
        { role: 'user', content: 'continue' },
      ]
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: `Bearer ${token}` },
        payload,
      })
      if (protocol === 'anthropic') {
        expect(response.statusCode, response.body).toBe(200)
        expect(observed.messages[0].content[0]).toEqual(
          payload.messages[0].content[0],
        )
        expect(upstreamCalls).toBe(1)
      } else {
        expect(response.statusCode, response.body).toBe(400)
        expect(response.body).toContain('unsupported_feature')
        expect(response.body).not.toContain('opaque-redacted-value')
        expect(upstreamCalls).toBe(0)
        expect(
          (
            await db.db.execute(
              sql`SELECT status,input_tokens::int AS input_tokens,output_tokens::int AS output_tokens FROM gw_requests`,
            )
          ).rows[0],
        ).toMatchObject({
          status: 'protocol_error',
          input_tokens: 0,
          output_tokens: 0,
        })
      }
    })
    test(`Messages redacted response to ${protocol} ${stream ? 'SSE' : 'JSON'} is preserved or fails without success`, async () => {
      const token = await configure('anthropic')
      mode = 'redacted'
      const response = await invoke(token, protocol, stream)
      if (protocol === 'anthropic') {
        expect(response.statusCode, response.body).toBe(200)
        expect(response.body).toContain('opaque-redacted-value')
      } else {
        expect(response.statusCode, response.body).toBe(stream ? 200 : 502)
        expect(response.body).toContain('redacted_thinking')
        expect(response.body).not.toContain('opaque-redacted-value')
        if (stream) {
          expect(response.body).not.toContain('response.completed')
          expect(response.body).not.toContain('data: [DONE]')
        }
      }
      expect(upstreamCalls).toBe(1)
      expect(
        (await db.db.execute(sql`SELECT status FROM gw_requests`)).rows[0]!
          .status,
      ).toBe(
        protocol === 'anthropic'
          ? 'ok'
          : stream
            ? 'stream_error'
            : 'protocol_error',
      )
      expect(
        (
          await db.db.execute(
            sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
          )
        ).rows[0]!.n,
      ).toBe(0)
    })
  }

for (const source of ['anthropic', 'responses'] as const)
  for (const stream of [false, true])
    for (const lossy of [false, true]) {
      test(`${source} signed response to Chat ${stream ? 'SSE' : 'JSON'} ${lossy ? 'explicit text-only' : 'default preserve'}`, async () => {
        const token = await configure(source)
        mode = 'reasoning'
        const response = await invoke(
          token,
          'openai',
          stream,
          false,
          lossy ? { 'x-coati-reasoning-policy': 'text-only' } : {},
        )
        expect(response.statusCode, response.body).toBe(
          lossy || stream ? 200 : 502,
        )
        if (lossy) expect(response.body).toContain('reasoning_content')
        else {
          expect(response.body).toContain('text-only')
          expect(response.body).not.toContain('data: [DONE]')
        }
        expect(response.body).not.toContain(signature)
        expect(observedAuth['x-coati-reasoning-policy']).toBeUndefined()
        expect(upstreamCalls).toBe(1)
        const row = (
          await db.db.execute(
            sql`SELECT status,request_context FROM gw_requests`,
          )
        ).rows[0]!
        expect(row).toMatchObject({
          status: lossy ? 'ok' : stream ? 'stream_error' : 'protocol_error',
          request_context: {
            reasoning_policy: lossy ? 'text-only' : 'preserve',
          },
        })
      })
      test(`${source} signed history to Chat ${stream ? 'SSE' : 'JSON'} ${lossy ? 'explicit text-only' : 'default preserve'}`, async () => {
        const token = await configure('openai')
        const body: any = bodyFor(source, stream)
        if (source === 'anthropic')
          body.messages = [
            {
              role: 'assistant',
              content: [{ type: 'thinking', thinking: thought, signature }],
            },
            { role: 'user', content: 'continue' },
          ]
        else
          body.input = [
            {
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: thought }],
              encrypted_content: signature,
            },
            { role: 'user', content: 'continue' },
          ]
        const response = await app.inject({
          method: 'POST',
          url: '/v1' + paths[source],
          headers: {
            authorization: `Bearer ${token}`,
            ...(lossy ? { 'x-coati-reasoning-policy': 'text-only' } : {}),
          },
          payload: body,
        })
        expect(response.statusCode, response.body).toBe(lossy ? 200 : 400)
        expect(upstreamCalls).toBe(lossy ? 1 : 0)
        if (lossy) {
          expect(JSON.stringify(observed.messages)).toContain(thought)
          expect(JSON.stringify(observed.messages)).not.toContain(signature)
        } else expect(response.body).toContain('unsupported_feature')
        const row = (
          await db.db.execute(
            sql`SELECT status,request_context FROM gw_requests`,
          )
        ).rows[0]!
        expect(row).toMatchObject({
          status: lossy ? 'ok' : 'protocol_error',
          request_context: {
            reasoning_policy: lossy ? 'text-only' : 'preserve',
          },
        })
      })
    }
test('invalid reasoning policy is rejected before supplier traffic', async () => {
  const token = await configure('openai')
  const response = await invoke(token, 'openai', false, false, {
    'x-coati-reasoning-policy': 'silently-drop',
  })
  expect(response.statusCode).toBe(400)
  expect(upstreamCalls).toBe(0)
})

for (const inbound of ['openai', 'anthropic'] as const)
  for (const protocol of ['openai', 'responses', 'anthropic'] as const)
    for (const stream of [false, true]) {
      test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} explicit stop sequences are preserved or rejected`, async () => {
        const token = await configure(protocol)
        const payload: any = bodyFor(inbound, stream)
        payload[inbound === 'anthropic' ? 'stop_sequences' : 'stop'] = [
          '结束',
          '<END>',
        ]
        const response = await app.inject({
          method: 'POST',
          url: '/v1' + paths[inbound],
          headers: { authorization: `Bearer ${token}`, 'x-coati-compatibility-policy': 'strict' },
          payload,
        })
        if (protocol === 'responses') {
          expect(response.statusCode, response.body).toBe(400)
          expect(response.body).toContain('unsupported_feature')
          expect(upstreamCalls).toBe(0)
          expect(
            (
              await db.db.execute(
                sql`SELECT status,input_tokens::int AS input_tokens,output_tokens::int AS output_tokens FROM gw_requests`,
              )
            ).rows[0],
          ).toMatchObject({
            status: 'protocol_error',
            input_tokens: 0,
            output_tokens: 0,
          })
        } else {
          expect(response.statusCode, response.body).toBe(200)
          expect(
            observed[protocol === 'anthropic' ? 'stop_sequences' : 'stop'],
          ).toEqual(['结束', '<END>'])
          expect(upstreamCalls).toBe(1)
        }
      })
    }

for (const inbound of ['openai', 'responses'] as const)
  for (const protocol of ['openai', 'responses', 'anthropic'] as const)
    for (const stream of [false, true])
      for (const type of ['json_object', 'json_schema']) {
        test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} ${type} format survives or fails explicitly`, async () => {
          const token = await configure(protocol)
          const payload: any = bodyFor(inbound, stream)
          const spec = {
            name: 'answer',
            description: 'fixture schema',
            schema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
            strict: false,
          }
          const chat =
            type === 'json_schema' ? { type, json_schema: spec } : { type }
          const responses =
            type === 'json_schema' ? { type, ...spec } : { type }
          if (inbound === 'openai') payload.response_format = chat
          else payload.text = { format: responses }
          const response = await app.inject({
            method: 'POST',
            url: '/v1' + paths[inbound],
            headers: { authorization: `Bearer ${token}`, 'x-coati-compatibility-policy': 'strict' },
            payload,
          })
          if (protocol === 'anthropic') {
            expect(response.statusCode, response.body).toBe(400)
            expect(response.body).toContain('unsupported_feature')
            expect(upstreamCalls).toBe(0)
          } else {
            expect(response.statusCode, response.body).toBe(200)
            expect(
              protocol === 'openai'
                ? observed.response_format
                : observed.text.format,
            ).toEqual(protocol === 'openai' ? chat : responses)
            expect(upstreamCalls).toBe(1)
          }
        })
      }

for (const { inbound, upstream: protocol } of matrix)
  for (const stream of [false, true])
    for (const parallel of [false, true])
      for (const named of [false, true]) {
        test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} parallel=${parallel} ${named ? 'named' : 'default'} tool selection survives`, async () => {
          const token = await configure(protocol)
          const payload: any = bodyFor(inbound, stream)
          if (inbound === 'anthropic') {
            payload.tools = [
              { name: 'weather', input_schema: { type: 'object' } },
            ]
            payload.tool_choice = {
              type: named ? 'tool' : 'auto',
              ...(named ? { name: 'weather' } : {}),
              disable_parallel_tool_use: !parallel,
            }
          } else {
            payload.tools =
              inbound === 'openai'
                ? [
                    {
                      type: 'function',
                      function: {
                        name: 'weather',
                        parameters: { type: 'object' },
                      },
                    },
                  ]
                : [
                    {
                      type: 'function',
                      name: 'weather',
                      parameters: { type: 'object' },
                    },
                  ]
            payload.parallel_tool_calls = parallel
            if (named)
              payload.tool_choice =
                inbound === 'openai'
                  ? { type: 'function', function: { name: 'weather' } }
                  : { type: 'function', name: 'weather' }
            else delete payload.tool_choice
          }
          const response = await app.inject({
            method: 'POST',
            url: '/v1' + paths[inbound],
            headers: { authorization: `Bearer ${token}`, 'x-coati-compatibility-policy': 'strict' },
            payload,
          })
          expect(response.statusCode, response.body).toBe(200)
          if (protocol === 'anthropic')
            expect(observed.tool_choice).toEqual({
              type: named ? 'tool' : 'auto',
              ...(named ? { name: 'weather' } : {}),
              disable_parallel_tool_use: !parallel,
            })
          else {
            expect(observed.parallel_tool_calls).toBe(parallel)
            if (named)
              expect(observed.tool_choice).toEqual(
                protocol === 'openai'
                  ? { type: 'function', function: { name: 'weather' } }
                  : { type: 'function', name: 'weather' },
              )
          }
          expect(upstreamCalls).toBe(1)
        })
      }

for (const { inbound, upstream: protocol } of matrix)
  for (const stream of [false, true])
    for (const strict of [false, true]) {
      test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} tool strict=${strict} survives`, async () => {
        const token = await configure(protocol)
        const payload: any = bodyFor(inbound, stream)
        const schema = {
          type: 'object',
          properties: { strict: { type: 'boolean' } },
          required: ['strict'],
          additionalProperties: false,
        }
        const fn = {
          name: 'weather',
          strict,
          ...(inbound === 'anthropic'
            ? { input_schema: schema }
            : { parameters: schema }),
        }
        payload.tools = [
          inbound === 'openai'
            ? { type: 'function', function: fn }
            : {
                ...(inbound === 'responses' ? { type: 'function' } : {}),
                ...fn,
              },
        ]
        const response = await app.inject({
          method: 'POST',
          url: '/v1' + paths[inbound],
          headers: { authorization: `Bearer ${token}`, 'x-coati-compatibility-policy': 'strict' },
          payload,
        })
        expect(response.statusCode, response.body).toBe(200)
        const tool =
          protocol === 'openai' ? observed.tools[0].function : observed.tools[0]
        expect(tool.strict).toBe(strict)
        expect(
          protocol === 'anthropic' ? tool.input_schema : tool.parameters,
        ).toEqual(schema)
        expect(upstreamCalls).toBe(1)
      })
    }

for (const { inbound, upstream: protocol } of matrix) {
  test(`${inbound} -> ${protocol}: paused HTTP client backpressures source and cancellation releases lease`, async () => {
    const token = await configure(protocol)
    mode = 'slow-pressure'
    const body = JSON.stringify(bodyFor(inbound, true))
    let response: IncomingMessage | undefined
    const request = httpRequest(gatewayBase + '/v1' + paths[inbound], {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    })
    request.on('error', () => {})
    const received = new Promise<IncomingMessage>((resolve, reject) => {
      request.once('response', resolve)
      request.once('error', reject)
    })
    request.end(body)
    try {
      response = await received
      expect(response.statusCode).toBe(200)
      response.pause()
      await expect
        .poll(() => generatedSlowChunks, { timeout: 3000 })
        .toBeGreaterThan(4)
      // Allow local TCP windows to fill, then require upstream production to stop.
      let previous = -1
      await expect
        .poll(
          () => {
            const current = generatedSlowChunks
            const stable = current === previous
            previous = current
            return stable
          },
          { timeout: 3000, interval: 200 },
        )
        .toBe(true)
      expect(upstreamClosed).toBe(false)
      expect(generatedSlowChunks).toBeLessThan(512)
      const paused = generatedSlowChunks
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(generatedSlowChunks).toBe(paused)
      expect(response.readableLength).toBeLessThanOrEqual(131072)
      response.destroy()
      request.destroy()
      await expect.poll(() => upstreamClosed, { timeout: 3000 }).toBe(true)
      await expect
        .poll(
          async () =>
            (await db.db.execute(sql`SELECT status FROM gw_requests`)).rows[0]
              ?.status,
          { timeout: 3000 },
        )
        .toBe('client_error')
      await expect
        .poll(
          async () =>
            (
              await db.db.execute(
                sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
              )
            ).rows[0]?.n,
          { timeout: 3000 },
        )
        .toBe(0)
      expect(upstreamCalls).toBe(1)
    } finally {
      response?.destroy()
      request.destroy()
    }
  })
}

for (const { inbound, upstream: protocol } of matrix) {
  test(`${inbound} -> ${protocol}: slow reader resumes with intact deltas and settled terminal`, async () => {
    const token = await configure(protocol)
    mode = inbound === 'responses' ? 'slow-terminal' : 'slow-resume'
    const chunks = inbound === 'responses' ? 16 : 4
    const body = JSON.stringify(bodyFor(inbound, true))
    const request = httpRequest(gatewayBase + '/v1' + paths[inbound], {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    })
    request.on('error', () => {})
    const received = new Promise<IncomingMessage>((resolve, reject) => {
      request.once('response', resolve)
      request.once('error', reject)
    })
    request.end(body)
    const response = await received
    try {
      expect(response.statusCode).toBe(200)
      response.pause()
      await new Promise((resolve) => setTimeout(resolve, 100))
      let wire = ''
      for await (const chunk of response) {
        wire += chunk.toString('utf8')
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      const events = wireEvents(wire) as any[]
      expect(wire).not.toContain('stream_error')
      const text = events
        .map((event) =>
          inbound === 'openai'
            ? event.choices?.[0]?.delta?.content || ''
            : inbound === 'anthropic'
              ? event.delta?.text || ''
              : event.type === 'response.output_text.delta'
                ? event.delta
                : '',
        )
        .join('')
      expect(text.replace('你好', '')).toBe('x'.repeat(32768 * chunks))
      expect(wire).toContain(
        inbound === 'openai'
          ? '[DONE]'
          : inbound === 'anthropic'
            ? 'message_stop'
            : 'response.completed',
      )
      await expect
        .poll(
          async () =>
            (await db.db.execute(sql`SELECT status FROM gw_requests`)).rows[0]
              ?.status,
        )
        .toBe('ok')
      await expect
        .poll(
          async () =>
            (
              await db.db.execute(
                sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
              )
            ).rows[0]?.n,
        )
        .toBe(0)
      expect(generatedSlowChunks).toBe(chunks)
      expect(upstreamCalls).toBe(1)
    } finally {
      response.destroy()
      request.destroy()
    }
  })
}

for (const protocol of ['openai', 'anthropic'] as const) {
  test(`${protocol} -> Responses: large repeated content endings retain successful terminal after settlement`, async () => {
    const token = await configure(protocol)
    mode = 'slow-terminal'
    const result = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${token}`, 'x-coati-compatibility-policy': 'strict' },
      payload: bodyFor('responses', true),
    })
    expect(result.statusCode).toBe(200)
    const events = wireEvents(result.body) as any[]
    expect(events.at(-1)).toMatchObject({ type: 'response.completed' })
    expect(events.some((event) => event.type === 'response.completed')).toBe(
      true,
    )
    expect(
      (await db.db.execute(sql`SELECT status FROM gw_requests`)).rows[0]
        ?.status,
    ).toBe('ok')
    expect(
      (
        await db.db.execute(
          sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
        )
      ).rows[0]?.n,
    ).toBe(0)
  })
}

for (const protocol of ['openai', 'anthropic'] as const)
  for (const fault of ['oversized', 'settlement'] as const) {
    test(`${protocol} -> Responses: long terminal ${fault} failure cannot emit completion`, async () => {
      const token = await configure(protocol)
      mode = fault === 'oversized' ? 'slow-oversized' : 'slow-terminal'
      const persist =
        fault === 'settlement'
          ? vi
              .spyOn(GatewayRepository.prototype, 'finish')
              .mockRejectedValue(new Error('accounting unavailable'))
          : undefined
      try {
        const result = await app.inject({
          method: 'POST',
          url: '/v1/responses',
          headers: { authorization: `Bearer ${token}`, 'x-coati-compatibility-policy': 'strict' },
          payload: bodyFor('responses', true),
        })
        const events = wireEvents(result.body) as any[]
        expect(events.at(-1)).toMatchObject({
          type: 'error',
          code: fault === 'settlement' ? 'settlement_failed' : 'stream_error',
        })
        expect(
          events.some((event) => event.type === 'response.completed'),
        ).toBe(false)
        expect(
          (
            await db.db.execute(
              sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
            )
          ).rows[0]?.n,
        ).toBe(0)
        if (fault === 'oversized')
          expect(
            (await db.db.execute(sql`SELECT status FROM gw_requests`)).rows[0]
              ?.status,
          ).toBe('stream_error')
      } finally {
        persist?.mockRestore()
      }
    })
  }

for (const { inbound, upstream: protocol } of matrix)
  for (const reason of ['idle', 'deadline', 'client'] as const) {
    test(`${inbound} -> ${protocol}: paused consumer ${reason} settles without another pull`, async () => {
      const token = await configure(protocol)
      mode = 'endless'
      const service = new GatewayService(db.db, {
        encryptionKey: 'matrix-paused',
        allowPrivate: true,
        timeoutMs: reason === 'deadline' ? 300 : 5000,
        idleTimeoutMs: reason === 'idle' ? 60 : 5000,
      })
      await service.repo.saveUpstream(
        {
          name: 'matrix',
          protocol,
          base_url: base,
          secret: service.vault.encrypt('matrix-key'),
        },
        1,
      )
      const controller = new AbortController()
      const persist = vi.spyOn(service.repo, 'finish')
      let iterator: AsyncGenerator<string> | undefined
      try {
        const result = await service.execute(
          await service.authenticate(token),
          bodyFor(inbound, true),
          inbound,
          controller.signal,
        )
        iterator = result.stream!
        expect((await iterator.next()).done).toBe(false)
        if (reason === 'client') controller.abort()
        await expect
          .poll(
            async () =>
              (await db.db.execute(sql`SELECT status FROM gw_requests`)).rows[0]
                ?.status,
            { timeout: 2000 },
          )
          .toBe(reason === 'client' ? 'client_error' : 'stream_error')
        expect(
          (
            await db.db.execute(
              sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
            )
          ).rows[0]?.n,
        ).toBe(0)
        await expect.poll(() => upstreamClosed, { timeout: 2000 }).toBe(true)
        let remaining = ''
        for await (const chunk of iterator) remaining += chunk
        expect(remaining).not.toMatch(
          /\[DONE\]|message_stop|response.completed/,
        )
        if (reason !== 'client') expect(remaining).toContain('stream_error')
        expect(persist).toHaveBeenCalledTimes(1)
        expect(upstreamCalls).toBe(1)
      } finally {
        controller.abort()
        await iterator?.return(undefined as never)
        persist.mockRestore()
        await service.transport.close()
      }
    })
  }

for (const { inbound, upstream: protocol } of matrix) {
  test(`${inbound} -> ${protocol}: response deadline closes a stalled downstream socket`, async () => {
    const token = await configure(protocol)
    mode = 'slow-pressure'
    const options = gatewayServiceModule.gatewayOptions
    const settings = vi
      .spyOn(gatewayServiceModule, 'gatewayOptions')
      .mockImplementation((config) => ({
        ...options(config),
        timeoutMs: 500,
        idleTimeoutMs: 100,
      }))
    let short: FastifyInstance
    try {
      short = await buildTestApp()
    } finally {
      settings.mockRestore()
    }
    let closed = false
    short.server.on('request', (_request, response) => {
      response.once('close', () => {
        closed = true
      })
    })
    await short.listen({ host: '127.0.0.1', port: 0 })
    const body = JSON.stringify(bodyFor(inbound, true))
    const client = httpRequest(
      `http://127.0.0.1:${(short.server.address() as any).port}/v1${paths[inbound]}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
    )
    client.on('error', () => {})
    const received = new Promise<IncomingMessage>((resolve, reject) => {
      client.once('response', resolve)
      client.once('error', reject)
    })
    let response: IncomingMessage | undefined
    client.end(body)
    try {
      response = await received
      response.on('error', () => {})
      response.pause()
      expect(response.statusCode).toBe(200)
      await expect.poll(() => closed, { timeout: 3000 }).toBe(true)
      await expect.poll(() => upstreamClosed, { timeout: 2000 }).toBe(true)
      expect(
        (await db.db.execute(sql`SELECT status FROM gw_requests`)).rows[0]
          ?.status,
      ).toBe('stream_error')
      expect(
        (
          await db.db.execute(
            sql`SELECT count(*)::int AS n FROM gw_upstream_leases`,
          )
        ).rows[0]?.n,
      ).toBe(0)
      expect(upstreamCalls).toBe(1)
    } finally {
      response?.destroy()
      client.destroy()
      short.server.closeAllConnections()
      await short.close()
    }
  })
}

for (const prefix of ['/v1', '/api/agent/v1', '/api/agent/anthropic/v1']) {
  test(`${prefix}: count_tokens is authenticated local estimation without usage billing`, async () => {
    const token = await configure('openai')
    const payload = {
      model: 'unknown-model-not-required-for-local-estimation',
      messages: [{ role: 'user', content: 'hello' }],
    }
    const result = await app.inject({
      method: 'POST',
      url: prefix + '/messages/count_tokens',
      headers: { authorization: `Bearer ${token}`, 'x-coati-compatibility-policy': 'strict' },
      payload,
    })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toEqual({
      input_tokens: Math.ceil(
        Buffer.byteLength(JSON.stringify({ messages: payload.messages })) / 4,
      ),
    })
    expect(result.headers['x-request-id']).toBeTruthy()
    expect(result.headers['x-agent-request-id']).toBe(
      result.headers['x-request-id'],
    )
    expect(upstreamCalls).toBe(0)
    expect(
      (await db.db.execute(sql`SELECT count(*)::int AS n FROM gw_requests`))
        .rows[0]?.n,
    ).toBe(0)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: prefix + '/messages/count_tokens',
          payload,
        })
      ).statusCode,
    ).toBe(401)
    await db.db.execute(sql`UPDATE gw_keys SET scopes='["profile"]'::jsonb`)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: prefix + '/messages/count_tokens',
          headers: { authorization: `Bearer ${token}`, 'x-coati-compatibility-policy': 'strict' },
          payload,
        })
      ).statusCode,
    ).toBe(403)
  })
}

for (const { inbound, upstream: protocol } of matrix) {
  for (const stream of [false, true]) {
    test(`public automatic pool ${inbound} -> ${protocol} ${stream ? 'SSE' : 'JSON'} retains usage and protocol`, async () => {
      const token = await configure(protocol)
      await db.db.execute(sql`delete from gw_routes`)
      const route = await session.inject({
        method: 'POST',
        url: '/api/admin/gateway/public-routes',
        payload: { model: 'public-model', upstream_model: protocol },
      })
      expect(route.statusCode, route.body).toBe(201)
      const result = await invoke(token, inbound, stream)
      expect(result.statusCode, result.body).toBe(200)
      expect(result.body).toContain('你好')
      expect(observedPath).toBe('/v1' + paths[protocol])
      const row = (await new GatewayRepository(db.db).listRequests()).items[0]!
      expect(row).toMatchObject({
        status: 'ok',
        input_tokens: 10,
        output_tokens: 3,
        cache_read_tokens: 2,
        execution: { route_kind: 'public', upstream_protocol: protocol },
      })
    })
  }
}

const nonportableControls: Record<Protocol, Record<string, unknown>[]> = {
  openai: [
    { logit_bias: { '123': 10 } },
    // A single compound regression covers formerly discarded controls. Native
    // paths must preserve every value, including explicit zero and false.
    { seed: 0, frequency_penalty: 0.5, presence_penalty: -0.5, logprobs: false, top_logprobs: 2, prediction: { type: 'content', content: 'fixture' }, audio: { voice: 'fixture' }, modalities: ['text'] },
  ],
  responses: [
    { previous_response_id: 'fixture-prior-response' },
    { conversation: 'fixture-conversation' },
    { background: true },
    { store: true },
  ],
  anthropic: [{ container: { id: 'fixture-container' } }, { top_k: 20 }],
}
for (const { inbound, upstream: protocol } of matrix) {
  for (const stream of [false, true]) {
    for (const control of nonportableControls[inbound]) {
      test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} nonportable ${Object.keys(control)[0]} is native-preserved or rejected without charge`, async () => {
        const token = await configure(protocol)
        const response = await app.inject({
          method: 'POST',
          url: '/v1' + paths[inbound],
          headers: { authorization: `Bearer ${token}`, 'x-coati-compatibility-policy': 'strict' },
          payload: { ...bodyFor(inbound, stream), ...control },
        })
        const rows = (
          await db.db.execute(
            sql`select status,reserved_tokens,input_tokens,output_tokens from gw_requests`,
          )
        ).rows
        if (inbound === protocol && inbound !== 'responses') {
          expect(response.statusCode, response.body).toBe(200)
          expect(observed).toMatchObject(control)
          expect(upstreamCalls).toBe(1)
          expect(rows).toEqual([
            expect.objectContaining({
              status: 'ok',
              input_tokens: '10',
              output_tokens: '3',
            }),
          ])
        } else {
          expect(response.statusCode, response.body).toBe(400)
          expect(response.json().error.code).toBe('unsupported_feature')
          if (inbound !== 'responses')
            expect(response.body).toContain(Object.keys(control)[0])
          else expect(response.body).toContain('store:false')
          expect(response.body).not.toContain('fixture-prior-response')
          expect(response.body).not.toContain('fixture-conversation')
          expect(response.body).not.toContain('fixture-container')
          expect(upstreamCalls).toBe(0)
          expect(rows).toEqual([
            {
              status: 'protocol_error',
              reserved_tokens: '0',
              input_tokens: '0',
              output_tokens: '0',
            },
          ])
          expect(
            (await db.db.execute(sql`select * from gw_attempts`)).rows,
          ).toHaveLength(0)
        }
        expect(
          (await db.db.execute(sql`select * from gw_upstream_leases`)).rows,
        ).toHaveLength(0)
      })
    }
  }
}

for (const { inbound, upstream: protocol } of matrix) {
  for (const stream of [false, true])
    test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} default stateless controls remain usable`, async () => {
      const token = await configure(protocol)
      const defaults =
        inbound === 'responses'
          ? {
              previous_response_id: null,
              conversation: null,
              background: false,
              store: false,
            }
          : inbound === 'openai'
            ? { n: 1, logit_bias: null }
            : { container: null }
      const response = await app.inject({
        method: 'POST',
        url: '/v1' + paths[inbound],
        headers: { authorization: `Bearer ${token}`, 'x-coati-compatibility-policy': 'strict' },
        payload: { ...bodyFor(inbound, stream), ...defaults },
      })
      expect(response.statusCode, response.body).toBe(200)
      expect(upstreamCalls).toBe(1)
      expect(
        (await db.db.execute(sql`select status from gw_requests`)).rows,
      ).toEqual([{ status: 'ok' }])
    })
}

for (const { inbound, upstream: protocol } of matrix) {
  for (const stream of [false, true]) {
    test(`${inbound} -> ${protocol}: personal runtime preserves prefix, tool roundtrip and cache accounting ${stream ? 'SSE' : 'JSON'}`, async () => {
      const token = await configure(protocol)
      const model = `mine/${protocol}`
      await db.db.execute(
        sql`update gw_upstreams set scope='personal',owner_user_id=${session.userId},model_prefix='mine'`,
      )
      await db.db.execute(
        sql`update gw_keys set models=${JSON.stringify([model])}::jsonb`,
      )
      const models = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${token}`, 'x-coati-compatibility-policy': 'strict' },
      })
      expect(models.statusCode).toBe(200)
      expect(models.json().data.map((row: any) => row.id)).toEqual([model])
      for (const followup of [false, true]) {
        mode = followup ? 'text' : 'tools'
        const response = await app.inject({
          method: 'POST',
          url: '/v1' + paths[inbound],
          headers: {
            authorization: `Bearer ${token}`,
            'x-session-id': 'personal-fixture',
          },
          payload: { ...bodyFor(inbound, stream, followup), model },
        })
        expect(response.statusCode, response.body).toBe(200)
        expect(observed.model).toBe(protocol)
        expect(response.body).toContain(model)
        expect(response.body).toContain(followup ? '你好' : 'weather')
        expect(
          observedAuth[
            protocol === 'anthropic' ? 'x-api-key' : 'authorization'
          ],
        ).toBe(protocol === 'anthropic' ? 'matrix-key' : 'Bearer matrix-key')
      }
      expect(upstreamCalls).toBe(2)
      const rows = (
        await db.db.execute(
          sql`select status,input_tokens,output_tokens,cache_read_tokens,execution from gw_requests`,
        )
      ).rows
      expect(rows).toHaveLength(2)
      for (const row of rows)
        expect(row).toMatchObject({
          status: 'ok',
          input_tokens: '10',
          output_tokens: '3',
          cache_read_tokens: '2',
          execution: {
            route_kind: 'personal',
            route_id: null,
            route_name: model,
            upstream_model: protocol,
            upstream_protocol: protocol,
          },
        })
      expect(
        (await db.db.execute(sql`select * from gw_upstream_leases`)).rows,
      ).toEqual([])
      expect(
        (await db.db.execute(sql`select health_status from gw_upstreams`)).rows,
      ).toEqual([{ health_status: 'healthy' }])
    })
  }
}

for (const { inbound, upstream: protocol } of matrix)
  for (const stream of [false, true]) {
    test(`${inbound} -> ${protocol}: account headers retain gateway auth on ${stream ? 'SSE' : 'JSON'} wire`, async () => {
      const token = await configure(protocol)
      await db.db.execute(
        sql`update gw_upstreams set extra_headers='{"X-Fixture":"matrix-header","User-Agent":"coati-matrix"}'::jsonb`,
      )
      const response = await invoke(token, inbound, stream)
      expect(response.statusCode, response.body).toBe(200)
      expect(observedAuth).toMatchObject({
        'x-fixture': 'matrix-header',
        'user-agent': 'coati-matrix',
      })
      expect(
        observedAuth[protocol === 'anthropic' ? 'x-api-key' : 'authorization'],
      ).toBe(protocol === 'anthropic' ? 'matrix-key' : 'Bearer matrix-key')
      expect(
        (await db.db.execute(sql`select status from gw_requests`)).rows,
      ).toEqual([{ status: 'ok' }])
    })
  }


for (const { inbound, upstream: protocol } of matrix)
  for (const stream of [false, true]) {
    test(`${inbound} -> ${protocol}: account proxy carries ${stream ? 'SSE' : 'JSON'} without leaking proxy auth`, async () => {
      const proxy = await startProxyFixture()
      try {
        const token = await configure(protocol)
        const row = (await db.db.execute(sql`select id,name,base_url from gw_upstreams`)).rows[0]!
        const saved = await session.inject({ method: 'PUT', url: `/api/admin/gateway/upstreams/${row.id}`, payload: { name: row.name, protocol, base_url: row.base_url, proxy_url: proxy.url } })
        expect(saved.statusCode, saved.body).toBe(200)
        expect(saved.body).not.toContain('proxy-fixture-password')
        expect(saved.json()).not.toHaveProperty('proxy_secret')
        const response = await invoke(token, inbound, stream)
        expect(response.statusCode, response.body).toBe(200)
        expect(proxy.calls).toHaveLength(1)
        expect(proxy.calls[0]!.auth).toBe('Basic ' + Buffer.from('proxy-user:proxy-fixture-password').toString('base64'))
        expect(observedAuth['proxy-authorization']).toBeUndefined()
        expect(observedAuth[protocol === 'anthropic' ? 'x-api-key' : 'authorization']).toBe(protocol === 'anthropic' ? 'matrix-key' : 'Bearer matrix-key')
        expect((await db.db.execute(sql`select status from gw_requests`)).rows).toEqual([{ status: 'ok' }])
      } finally { await proxy.close() }
    })
  }


for (const { inbound, upstream: protocol } of matrix) for (const stream of [false, true]) {
  test(`${inbound} -> ${protocol}: ${stream ? 'SSE' : 'JSON'} extension policy acceptance`, async () => {
    const token = await configure(protocol)
    const send = (strict: boolean, extension = false) => app.inject({ method: 'POST', url: '/v1' + paths[inbound],
      headers: { authorization: `Bearer ${token}`, ...(strict ? { 'x-coati-compatibility-policy': 'strict' } : {}) },
      payload: { ...bodyFor(inbound, stream), ...(extension ? { vendor_extension: { private: 'PRIVATE_INPUT' } } : {}) } })
    const compatible = await send(false, true)
    expect(compatible.statusCode, compatible.body).toBe(200)
    expect(compatible.body).toContain('你好')
    expect(observed.vendor_extension).toEqual(inbound === protocol ? { private: 'PRIVATE_INPUT' } : undefined)
    const before = upstreamCalls
    const strictRequest = await send(true, true)
    expect(strictRequest.statusCode, strictRequest.body).toBe(inbound === protocol ? 200 : 400)
    expect(upstreamCalls).toBe(before + (inbound === protocol ? 1 : 0))
    expect(strictRequest.body).not.toContain('PRIVATE_INPUT')
    mode = 'extension'
    const response = await send(false)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.body).toContain('你好')
    const strictResponse = await send(true)
    if (inbound === protocol) {
      expect(strictResponse.statusCode, strictResponse.body).toBe(200)
      expect(strictResponse.body).toContain('PRIVATE_EXTENSION')
    } else {
      expect(strictResponse.statusCode, strictResponse.body).toBe(stream ? 200 : 502)
      expect(strictResponse.body).toContain(stream ? 'stream_error' : 'protocol_error')
      expect(strictResponse.body).not.toContain('PRIVATE_EXTENSION')
    }
    expect((await db.db.execute(sql`select id from gw_requests where status='reserved'`)).rows).toHaveLength(0)
    expect((await db.db.execute(sql`select request_id from gw_upstream_leases`)).rows).toHaveLength(0)
  })
}
