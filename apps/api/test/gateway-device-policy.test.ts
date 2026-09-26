import { expect, test } from 'vitest'
import { deviceStartPolicy, deviceFlowPolicy } from '../src/modules/gateway/device-policy'
test('device admission defaults match Python and invalid configuration falls back', () => {
  const defaults = { startsPerMinute: 60, maxActive: 5000, retentionHours: 24 }
  expect(deviceStartPolicy({})).toEqual(defaults)
  for (const value of ['', '0', '-1', 'abc', '1.5', 'Infinity']) {
    expect(
      deviceStartPolicy({
        AGENT_DEVICE_STARTS_PER_MINUTE: value,
        AGENT_DEVICE_MAX_ACTIVE: value,
        AGENT_DEVICE_RETENTION_HOURS: value,
      }),
    ).toEqual(defaults)
  }
  expect(
    deviceStartPolicy({
      AGENT_DEVICE_STARTS_PER_MINUTE: '3',
      AGENT_DEVICE_MAX_ACTIVE: '10',
      AGENT_DEVICE_RETENTION_HOURS: '48',
    }),
  ).toEqual({ startsPerMinute: 3, maxActive: 10, retentionHours: 48 })
})

test('device flow exposes legacy TTL, polling interval and verification path settings', () => {
  expect(deviceFlowPolicy({})).toEqual({ ttlSeconds: 600, intervalSeconds: 5, verificationPath: '/agent/device-confirm' })
  expect(deviceFlowPolicy({ AGENT_DEVICE_TTL_SECONDS: '900', AGENT_DEVICE_INTERVAL_SECONDS: '3', AGENT_DEVICE_VERIFY_PATH: '/login/device' })).toEqual({ ttlSeconds: 900, intervalSeconds: 3, verificationPath: '/login/device' })
})
