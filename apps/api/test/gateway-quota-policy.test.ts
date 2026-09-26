import { expect, test } from 'vitest'
import { defaultDailyQuota, reservationTtlSeconds } from '../src/modules/gateway/quota-policy'
test('default quota accepts zero/nonnegative integers and fails closed for invalid values', () => {
  expect(defaultDailyQuota('')).toBe(0)
  expect(defaultDailyQuota('0')).toBe(0)
  expect(defaultDailyQuota('500')).toBe(500)
  for (const value of ['NaN', '-1', '1.5', '1000000000001']) expect(() => defaultDailyQuota(value)).toThrow()
})

test('reservation lifetime retains Python default, zero fallback and minimum', () => {
  expect(reservationTtlSeconds('')).toBe(3600)
  expect(reservationTtlSeconds('0')).toBe(3600)
  expect(reservationTtlSeconds('20')).toBe(300)
  expect(reservationTtlSeconds('7200')).toBe(7200)
})
