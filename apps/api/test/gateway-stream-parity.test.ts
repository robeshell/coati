import { readFileSync } from 'node:fs'
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  AnthropicToOpenAIStream,
  ResponsesToOpenAIStream,
} from '../src/modules/gateway/protocol/stream-source'
import {
  OpenAIToAnthropicStream,
  OpenAIToResponsesStream,
} from '../src/modules/gateway/protocol/stream-target'
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/protocol/python-stream-golden.json', import.meta.url),
    'utf8',
  ),
)
const classes: Record<string, any> = {
  AnthropicToOpenAIStream,
  ResponsesToOpenAIStream,
  OpenAIToAnthropicStream,
  OpenAIToResponsesStream,
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(1700000000000))
})
afterEach(() => vi.useRealTimers())
const unwrap = (value: any): any =>
  Array.isArray(value)
    ? value.map(unwrap)
    : value && typeof value === 'object' && 'bytes' in value
      ? value.bytes
      : value
for (const [i, trace] of fixture.cases.entries()) {
  test(`Python stream ${i}: ${trace.class} / ${trace.test}`, () => {
    const instance = new classes[trace.class](...trace.args)
    for (const call of trace.calls) {
      const args = [...call.args]
      if (call.kwargs.event !== undefined) args.push(call.kwargs.event)
      if (call.kwargs.finish_reason !== undefined)
        args[0] = call.kwargs.finish_reason
      if (call.kwargs.usage !== undefined) args[1] = call.kwargs.usage
      if (call.error)
        expect(() => instance[call.method](...args)).toThrow(call.error)
      else expect(instance[call.method](...args)).toEqual(unwrap(call.expected))
      expect(instance.finished).toBe(call.finished)
    }
  })
}

test('partial Anthropic usage updates retain cache counts and do not double count snapshots', async () => {
  const { UsageMeter } = await import('../src/modules/gateway/stream')
  const meter = new UsageMeter()
  meter.observe(
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 7,
          output_tokens: 0,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      },
    },
    'anthropic',
  )
  meter.observe(
    { type: 'message_delta', usage: { input_tokens: 7, output_tokens: 3 } },
    'anthropic',
  )
  meter.observe(
    { type: 'message_delta', usage: { output_tokens: 3 } },
    'anthropic',
  )
  expect(meter.result(99)).toEqual({
    input_tokens: 10,
    output_tokens: 3,
    usage_source: 'upstream',
  })
  expect(meter.rawUsage).toEqual({
    input_tokens: 7,
    output_tokens: 3,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
  })
})
