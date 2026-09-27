import { expect, test } from 'vitest'
import { gatewayTimezone } from '../src/modules/gateway/timezone'
test('business timezone matches legacy fallback and supports explicit UTC', () => {
  expect(gatewayTimezone('')).toBe('Asia/Shanghai')
  expect(gatewayTimezone('not-a-zone')).toBe('Asia/Shanghai')
  expect(gatewayTimezone('+08:00')).toBe('Asia/Shanghai')
  expect(gatewayTimezone('UTC')).toBe('UTC')
  expect(gatewayTimezone('America/New_York')).toBe('America/New_York')
})
