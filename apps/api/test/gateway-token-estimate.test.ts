import { expect, test } from 'vitest'
import fixtures from './fixtures/token-estimate.json'
import { estimateMessageTokens } from '../src/modules/gateway/token-estimate'


fixtures.cases.forEach((fixture, index) =>
  test(`Gateway count_tokens parity ${index}`, () => {
    const before = structuredClone(fixture.body)
    expect({ input_tokens: estimateMessageTokens(fixture.body) }).toEqual(
      fixture.expected,
    )
    expect(fixture.body).toEqual(before)
  }),
)
