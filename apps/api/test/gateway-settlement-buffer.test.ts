import { expect, test } from 'vitest'
import { SettlementBuffer } from '../src/modules/gateway/settlement-buffer'
const frame = (type: string, text = '') =>
  `data: ${JSON.stringify({ type, text })}\n\n`
test('repeated content endings do not consume response completion buffer', () => {
  const gate = new SettlementBuffer(128)
  const end = frame('response.completed')
  const parts = [
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
  ].map((type) => frame(type, 'x'.repeat(64)))
  expect([...gate.accept(parts.join('') + end, 'responses')]).toEqual(parts)
  expect(gate.release()).toBe(end)
  expect(gate.release()).toBe('')
})
test('single content events and aggregate held completion remain bounded', () => {
  expect(() => [
    ...new SettlementBuffer(128).accept(
      frame('response.output_text.done', 'x'.repeat(128)),
      'responses',
    ),
  ]).toThrow('超过大小限制')
  expect(() => [
    ...new SettlementBuffer(128).accept(
      frame('response.completed', 'x'.repeat(128)),
      'responses',
    ),
  ]).toThrow('超过大小限制')
  expect(() => [
    ...new SettlementBuffer(128).accept(
      frame('response.completed').repeat(8),
      'responses',
    ),
  ]).toThrow('超过大小限制')
})
test('nothing overtakes a held completion and non-Responses endings remain held', () => {
  const gate = new SettlementBuffer()
  const chunks =
    frame('response.incomplete') + frame('response.output_item.done')
  expect([...gate.accept(chunks, 'responses')]).toEqual([])
  expect(gate.release()).toBe(chunks)
  for (const protocol of ['openai', 'anthropic'] as const) {
    const gate = new SettlementBuffer()
    expect([
      ...gate.accept(frame('response.output_item.done'), protocol),
    ]).toEqual([])
    expect(gate.release()).toBe(frame('response.output_item.done'))
  }
})
