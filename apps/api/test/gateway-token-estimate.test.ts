import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import fixtures from './fixtures/python-token-estimate.json'
import { estimateMessageTokens } from '../src/modules/gateway/token-estimate'

test('count_tokens Python reference fixture sources remain unchanged', () => {
  for (const [file, expected] of Object.entries(fixtures.sources)) {
    expect(
      createHash('sha256')
        .update(
          readFileSync(
            new URL(
              `../../../portal/backend/app/agent/service/${file}`,
              import.meta.url,
            ),
          ),
        )
        .digest('hex'),
    ).toBe(expected)
  }
})
fixtures.cases.forEach((fixture, index) =>
  test(`Python count_tokens parity ${index}`, () => {
    const before = structuredClone(fixture.body)
    expect({ input_tokens: estimateMessageTokens(fixture.body) }).toEqual(
      fixture.expected,
    )
    expect(fixture.body).toEqual(before)
  }),
)
