import { expect, test } from 'vitest'
import { bridgeRequest } from '../src/modules/gateway/protocol/bridge'
import { matrix } from '../src/modules/gateway/protocol/matrix'

test('explicit parallel control does not invent a tool choice on tool-less conversions', () => {
  for (const { inbound, upstream } of matrix) {
    if (inbound === upstream) continue
    const body = {
      model: 'fixture',
      messages: [],
      input: [],
      ...(inbound === 'anthropic'
        ? { tool_choice: { type: 'auto', disable_parallel_tool_use: true } }
        : { parallel_tool_calls: false }),
    }
    expect(bridgeRequest(body, inbound, upstream).tool_choice).toBeUndefined()
  }
})
test('none tool choice stays none without unsupported parallel options on Messages', () => {
  const converted = bridgeRequest(
    {
      model: 'fixture',
      messages: [],
      tools: [
        {
          type: 'function',
          function: { name: 'weather', parameters: { type: 'object' } },
        },
      ],
      tool_choice: 'none',
      parallel_tool_calls: false,
    },
    'openai',
    'anthropic',
  )
  expect(converted.tool_choice).toEqual({ type: 'none' })
})
test('cross-protocol controls reject non-booleans instead of coercing them', () => {
  for (const { inbound, upstream } of matrix) {
    if (inbound === upstream) continue
    const body = {
      model: 'fixture',
      messages: [],
      input: [],
      ...(inbound === 'anthropic'
        ? { tool_choice: { type: 'auto', disable_parallel_tool_use: 'false' } }
        : { parallel_tool_calls: 'false' }),
    }
    expect(() => bridgeRequest(body, inbound, upstream)).toThrow(
      '工具并行控制必须为布尔值',
    )
  }
})

for (const { inbound, upstream } of matrix) {
  if (inbound === upstream) continue
  test(`${inbound} -> ${upstream}: strict controls preserve absence, schemas and input`, () => {
    const schema = {
      type: 'object',
      properties: { strict: { type: 'boolean' } },
    }
    const tools = [true, false, undefined].map((strict, index) => {
      const fn = {
        name: `tool${index}`,
        ...(strict === undefined ? {} : { strict }),
        ...(inbound === 'anthropic'
          ? { input_schema: schema }
          : { parameters: schema }),
      }
      return inbound === 'openai'
        ? { type: 'function', function: fn }
        : { ...(inbound === 'responses' ? { type: 'function' } : {}), ...fn }
    })
    const body = { model: 'fixture', messages: [], input: [], tools }
    const before = structuredClone(body)
    const result = bridgeRequest(body, inbound, upstream).tools as any[]
    result.forEach((tool, index) => {
      const fn = upstream === 'openai' ? tool.function : tool
      expect(fn.strict).toBe([true, false, undefined][index])
      expect(Object.hasOwn(fn, 'strict')).toBe(index !== 2)
      expect(
        upstream === 'anthropic' ? fn.input_schema : fn.parameters,
      ).toEqual(schema)
    })
    expect(body).toEqual(before)
    for (const invalid of ['false', null, 0, {}]) {
      const broken: any = structuredClone(body)
      const fn =
        inbound === 'openai' ? broken.tools[0].function : broken.tools[0]
      fn.strict = invalid
      expect(() => bridgeRequest(broken, inbound, upstream)).toThrow(
        '工具严格模式必须为布尔值',
      )
    }
    const duplicate = { ...body, tools: [tools[0], tools[0]] }
    expect(() => bridgeRequest(duplicate, inbound, upstream)).toThrow(
      '工具严格模式声明无法唯一匹配',
    )
  })
}

for (const upstream of ['openai', 'anthropic'] as const) {
  test(`Responses additional_tools -> ${upstream} retains strict`, () => {
    const result = bridgeRequest(
      {
        model: 'fixture',
        input: [
          {
            type: 'additional_tools',
            tools: [
              {
                type: 'function',
                name: 'weather',
                strict: false,
                parameters: { type: 'object' },
              },
            ],
          },
        ],
      },
      'responses',
      upstream,
    )
    const tool = (result.tools as any[])[0]
    expect(upstream === 'openai' ? tool.function.strict : tool.strict).toBe(
      false,
    )
  })
}
