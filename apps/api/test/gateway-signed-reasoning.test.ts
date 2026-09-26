import { interleavedThinking } from './reasoning-fixture'
import { array, object } from '../src/modules/gateway/protocol/compat-helpers'
import { expect, test } from 'vitest'
import { bridgeStream } from '../src/modules/gateway/protocol/stream-bridge'
import { UsageMeter } from '../src/modules/gateway/stream'

function events(close = true) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'signed',
        role: 'assistant',
        model: 'fixture',
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'thinking',
        thinking: '第一块',
        signature: 'sig-a',
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'signature_delta', signature: 'sig-' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'signature_delta', signature: 'b' },
    },
    ...(close ? [{ type: 'content_block_stop', index: 1 }] : []),
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}
async function* bytes(close = true) {
  const wire = events(close)
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
  for (const byte of Buffer.from(wire)) yield Uint8Array.of(byte)
}
const parse = (wire: string) =>
  wire
    .split('\n\n')
    .filter(Boolean)
    .map((frame) =>
      JSON.parse(
        frame
          .split('\n')
          .find((line) => line.startsWith('data:'))!
          .slice(5),
      ),
    )
test('multiple Messages thinking blocks retain distinct signatures, IDs and empty summaries in Responses', async () => {
  let wire = ''
  for await (const part of bridgeStream(
    bytes(),
    'anthropic',
    'responses',
    'public-model',
    new UsageMeter(),
  ))
    wire += part
  const result = parse(wire)
  const output = result.find((event) => event.type === 'response.completed')
    .response.output
  expect(output).toHaveLength(2)
  expect(output[0]).toMatchObject({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: '第一块' }],
    encrypted_content: 'sig-a',
  })
  expect(output[1]).toMatchObject({
    type: 'reasoning',
    summary: [],
    encrypted_content: 'sig-b',
  })
  expect(new Set(output.map((item: any) => item.id)).size).toBe(2)
  expect(
    result
      .filter((event) => event.type === 'response.output_item.done')
      .map((event) => event.item),
  ).toEqual(output)
  expect(
    result
      .filter((event) => event.type === 'response.output_item.added')
      .map((event) => event.item.id),
  ).toEqual(output.map((item: any) => item.id))
})
test('a source terminal cannot silently close an unfinished signed thinking block', async () => {
  let wire = ''
  await expect(
    (async () => {
      for await (const part of bridgeStream(
        bytes(false),
        'anthropic',
        'responses',
        'public-model',
        new UsageMeter(),
      ))
        wire += part
    })(),
  ).rejects.toMatchObject({ code: 'truncated_stream' })
  expect(wire).not.toContain('response.completed')
})

test('Messages request signatures survive separate reasoning items and replay back to Messages', async () => {
  const { bridgeRequest } = await import(
    '../src/modules/gateway/protocol/bridge'
  )
  const input = {
    model: 'public-model',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first', signature: 'opaque-a' },
          { type: 'thinking', thinking: '', signature: 'opaque-b' },
          { type: 'thinking', thinking: 'unsigned' },
          { type: 'text', text: 'answer' },
        ],
      },
    ],
  }
  const original = structuredClone(input)
  const converted = bridgeRequest(input, 'anthropic', 'responses')
  expect(
    array(converted.input).filter((item) => object(item).type === 'reasoning'),
  ).toEqual([
    {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'first' }],
      encrypted_content: 'opaque-a',
    },
    {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: '' }],
      encrypted_content: 'opaque-b',
    },
    {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'unsigned' }],
    },
  ])
  const restored = bridgeRequest(converted, 'responses', 'anthropic')
  expect(object(array(restored.messages)[0]).content).toEqual([
    { type: 'thinking', thinking: 'first', signature: 'opaque-a' },
    { type: 'thinking', thinking: '', signature: 'opaque-b' },
    { type: 'text', text: 'unsigned' },
    { type: 'text', text: 'answer' },
  ])
  expect(input).toEqual(original)
})

const responseReasoning = [
  {
    id: 'r-a',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: '第一段' }],
    encrypted_content: 'opaque-a',
  },
  { id: 'r-b', type: 'reasoning', summary: [], encrypted_content: 'opaque-b' },
  {
    id: 'r-c',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: '无签名' }],
  },
]
async function* responseBytes(itemDone: boolean, complete = true) {
  const events: any[] = [
    {
      type: 'response.created',
      response: {
        id: 'r',
        model: 'fixture',
        status: 'in_progress',
        output: [],
      },
    },
  ]
  for (const [index, item] of responseReasoning.entries()) {
    events.push({
      type: 'response.output_item.added',
      output_index: index,
      item: { id: item.id, type: 'reasoning', summary: [] },
    })
    if (item.summary.length)
      events.push({
        type: 'response.reasoning_summary_text.delta',
        output_index: index,
        item_id: item.id,
        summary_index: 0,
        delta: item.summary[0]!.text,
      })
    if (itemDone)
      events.push({
        type: 'response.output_item.done',
        output_index: index,
        item,
      })
  }
  events.push({
    type: 'response.completed',
    response: {
      id: 'r',
      status: 'completed',
      output: complete ? responseReasoning : [],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })
  for (const event of events)
    for (const byte of Buffer.from(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    ))
      yield Uint8Array.of(byte)
}
for (const itemDone of [true, false])
  test(`Responses reasoning ${itemDone ? 'item and terminal' : 'terminal only'} preserves signed and unsigned blocks once`, async () => {
    let wire = ''
    for await (const part of bridgeStream(
      responseBytes(itemDone),
      'responses',
      'anthropic',
      'public-model',
      new UsageMeter(),
    ))
      wire += part
    const events = parse(wire),
      blocks: any[] = []
    for (const event of events) {
      if (event.type === 'content_block_start')
        blocks[event.index] = { ...event.content_block }
      if (event.type === 'content_block_delta') {
        const field =
          event.delta.type === 'signature_delta'
            ? 'signature'
            : event.delta.type === 'thinking_delta'
              ? 'thinking'
              : 'text'
        blocks[event.index][field] =
          (blocks[event.index][field] ?? '') + event.delta[field]
      }
    }
    expect(blocks).toEqual([
      { type: 'thinking', thinking: '第一段', signature: 'opaque-a' },
      { type: 'thinking', thinking: '', signature: 'opaque-b' },
      { type: 'text', text: '无签名' },
    ])
    expect(
      events.filter((event) => event.type === 'content_block_stop'),
    ).toHaveLength(3)
    expect(
      events.filter((event) => event.type === 'message_stop'),
    ).toHaveLength(1)
    expect(events[0].message.usage.input_tokens).toBeUndefined()
  })
test('unfinished Responses reasoning cannot disappear behind a source terminal', async () => {
  let wire = ''
  await expect(
    (async () => {
      for await (const part of bridgeStream(
        responseBytes(false, false),
        'responses',
        'anthropic',
        'public-model',
        new UsageMeter(),
      ))
        wire += part
    })(),
  ).rejects.toMatchObject({ code: 'truncated_stream' })
  expect(wire).not.toContain('message_stop')
})

for (const change of ['text', 'signature', 'identity'] as const)
  test(`conflicting final reasoning ${change} cannot become a successful Messages stream`, async () => {
    const { reasoningEvents } = await import('./reasoning-fixture')
    const frames = structuredClone(reasoningEvents('responses', {}))
    frames.at(-1).response = structuredClone(frames.at(-1).response)
    const final = frames.at(-1).response.output[0]
    if (change === 'text') final.summary[0].text = 'conflicting text'
    if (change === 'signature') delete final.encrypted_content
    if (change === 'identity') final.id = 'different-item'
    async function* data() {
      for (const event of frames)
        yield Buffer.from(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
    }
    let wire = ''
    await expect(
      (async () => {
        for await (const part of bridgeStream(
          data(),
          'responses',
          'anthropic',
          'public-model',
          new UsageMeter(),
        ))
          wire += part
      })(),
    ).rejects.toMatchObject({ code: 'invalid_response' })
    expect(wire).not.toContain('message_stop')
    expect(wire).not.toContain('conflicting text')
  })
test('reasoning deltas addressed only by output index resolve to the announced item', async () => {
  const { reasoningEvents, thought, signature } = await import(
    './reasoning-fixture'
  )
  const frames = reasoningEvents('responses', {})
  for (const event of frames) delete event.item_id
  async function* data() {
    for (const event of frames)
      yield Buffer.from(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
  }
  let wire = ''
  for await (const part of bridgeStream(
    data(),
    'responses',
    'anthropic',
    'public-model',
    new UsageMeter(),
  ))
    wire += part
  const events = parse(wire)
  expect(
    events
      .filter((event) => event.delta?.thinking)
      .map((event) => event.delta.thinking)
      .join(''),
  ).toBe(thought)
  expect(
    events
      .filter((event) => event.delta?.signature)
      .map((event) => event.delta.signature)
      .join(''),
  ).toBe(signature)
  expect(events.filter((event) => event.type === 'message_stop')).toHaveLength(
    1,
  )
})

for (const terminalOnly of [false, true])
  test(`late reasoning ${terminalOnly ? 'terminal' : 'item'} completion preserves thought before answer`, async () => {
    const { reasoningEvents, thought, answer } = await import(
      './reasoning-fixture'
    )
    const frames = reasoningEvents('responses', {})
    const index = frames.findIndex(
      (event) =>
        event.type === 'response.output_item.done' &&
        event.item.type === 'reasoning',
    )
    const [completion] = frames.splice(index, 1)
    if (!terminalOnly) frames.splice(frames.length - 1, 0, completion)
    async function* data() {
      for (const event of frames)
        yield Buffer.from(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
    }
    let wire = ''
    for await (const part of bridgeStream(
      data(),
      'responses',
      'anthropic',
      'public-model',
      new UsageMeter(),
    ))
      wire += part
    const events = parse(wire)
    expect(
      events
        .filter((event) => event.type === 'content_block_start')
        .map((event) => event.content_block.type),
    ).toEqual(['thinking', 'text'])
    expect(
      events
        .filter((event) => event.delta?.thinking)
        .map((event) => event.delta.thinking)
        .join(''),
    ).toBe(thought)
    expect(
      events
        .filter((event) => event.delta?.text)
        .map((event) => event.delta.text)
        .join(''),
    ).toBe(answer)
    expect(
      events.filter((event) => event.type === 'message_stop'),
    ).toHaveLength(1)
  })
test('reasoning ordering buffer enforces byte bounds before a missing item completes', async () => {
  const { orderReasoningFrames } = await import(
    '../src/modules/gateway/protocol/reasoning-order'
  )
  async function* data() {
    yield 'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning"}}\n\n'
    yield 'data: ' +
      JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'x'.repeat(300),
      }) +
      '\n\n'
  }
  await expect(
    (async () => {
      for await (const frame of orderReasoningFrames(data(), 200)) void frame
    })(),
  ).rejects.toMatchObject({ code: 'stream_limit' })
})

test('a tool announced behind unfinished reasoning retains its ID and arguments after ordered emission', async () => {
  const { reasoningEvents } = await import('./reasoning-fixture')
  const frames = reasoningEvents('responses', {})
  const at = frames.findIndex(
    (event) =>
      event.type === 'response.output_item.done' &&
      event.item.type === 'reasoning',
  )
  const [completion] = frames.splice(at, 1)
  const tool = {
    id: 'fc1',
    type: 'function_call',
    call_id: 'call1',
    name: 'inspect',
    arguments: '{"path":"中文"}',
  }
  frames.at(-1).response.output.push(tool)
  frames.splice(
    frames.length - 1,
    0,
    {
      type: 'response.output_item.added',
      output_index: 2,
      item: { ...tool, arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 2,
      item_id: 'fc1',
      delta: tool.arguments,
    },
    { type: 'response.output_item.done', output_index: 2, item: tool },
    completion,
  )
  async function* data() {
    for (const event of frames)
      yield Buffer.from(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
  }
  let wire = ''
  for await (const part of bridgeStream(
    data(),
    'responses',
    'anthropic',
    'public-model',
    new UsageMeter(),
  ))
    wire += part
  const events = parse(wire),
    starts = events.filter((event) => event.type === 'content_block_start')
  expect(starts.map((event) => event.content_block.type)).toEqual([
    'thinking',
    'text',
    'tool_use',
  ])
  expect(starts[2].content_block).toMatchObject({
    id: 'call1',
    name: 'inspect',
  })
  expect(
    events
      .filter((event) => event.delta?.partial_json)
      .map((event) => event.delta.partial_json)
      .join(''),
  ).toBe(tool.arguments)
})

async function* thinkingBytes(frames: unknown[]) {
  for (const frame of frames)
    for (const byte of Buffer.from(`data: ${JSON.stringify(frame)}\n\n`))
      yield Uint8Array.of(byte)
}
test('interleaved Messages thinking keeps block signatures separate and text after reasoning', async () => {
  let wire = ''
  for await (const part of bridgeStream(
    thinkingBytes(interleavedThinking()),
    'anthropic',
    'responses',
    'public-model',
    new UsageMeter(),
  ))
    wire += part
  const output = parse(wire).find(
    (event) => event.type === 'response.completed',
  ).response.output
  expect(output.map((item: any) => item.type)).toEqual([
    'reasoning',
    'reasoning',
    'message',
  ])
  expect(output[0]).toMatchObject({
    summary: [{ type: 'summary_text', text: '第一块' }],
    encrypted_content: 'sig-a',
  })
  expect(output[1]).toMatchObject({
    summary: [{ type: 'summary_text', text: '第二块' }],
    encrypted_content: 'sig-b',
  })
  expect(output[2].content[0].text).toBe('答案')
})
for (const fault of [
  'duplicate-start',
  'late-signature',
  'unknown-signature',
] as const)
  test(`invalid Messages thinking ${fault} fails explicitly`, async () => {
    const frames: any[] = interleavedThinking()
    if (fault === 'duplicate-start')
      frames.splice(2, 0, structuredClone(frames[1]))
    if (fault === 'late-signature')
      frames.splice(7, 0, {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'signature_delta', signature: 'late' },
      })
    if (fault === 'unknown-signature')
      frames.splice(1, 0, {
        type: 'content_block_delta',
        index: 99,
        delta: { type: 'signature_delta', signature: 'unknown' },
      })
    let wire = ''
    await expect(
      (async () => {
        for await (const part of bridgeStream(
          thinkingBytes(frames),
          'anthropic',
          'responses',
          'public-model',
          new UsageMeter(),
        ))
          wire += part
      })(),
    ).rejects.toMatchObject({ code: 'invalid_response' })
    expect(wire).not.toContain('response.completed')
  })

test('opaque guard checks actual protocol content, not tool payloads or schemas', async () => {
  const { assertAnthropicOpaqueContent } = await import(
    '../src/modules/gateway/protocol/opaque-content'
  )
  expect(() =>
    assertAnthropicOpaqueContent({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              input: {
                type: 'redacted_thinking',
                data: 'ordinary tool argument',
              },
            },
          ],
        },
      ],
      tools: [
        {
          input_schema: {
            properties: { type: { const: 'redacted_thinking' } },
          },
        },
      ],
    }),
  ).not.toThrow()
  expect(() =>
    assertAnthropicOpaqueContent({
      type: 'message_start',
      message: { content: [{ type: 'redacted_thinking', data: 'opaque' }] },
    }),
  ).toThrow('跨协议转换不支持 redacted_thinking')
})

test('text-only does not permit dropping redacted thinking', async () => {
  const { bridgeRequest } = await import(
    '../src/modules/gateway/protocol/bridge'
  )
  expect(() =>
    bridgeRequest(
      {
        model: 'fixture',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'redacted_thinking', data: 'opaque' }],
          },
        ],
      },
      'anthropic',
      'openai',
      { reasoningPolicy: 'text-only' },
    ),
  ).toThrow('redacted_thinking')
})

test('standalone Responses reasoning stays before the next user message when converted to Chat', async () => {
  const { bridgeRequest } = await import(
    '../src/modules/gateway/protocol/bridge'
  )
  const result = bridgeRequest(
    {
      model: 'fixture',
      input: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: '思考' }],
        },
        { role: 'user', content: '继续' },
      ],
    },
    'responses',
    'openai',
  )
  expect(result.messages).toEqual([
    { role: 'assistant', content: '', reasoning_content: '思考' },
    { role: 'user', content: '继续' },
  ])
})
