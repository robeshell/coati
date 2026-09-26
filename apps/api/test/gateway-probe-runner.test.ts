import { afterEach, expect, test, vi } from 'vitest'
import { probePolicy, startGatewayProbeRunner } from '../src/modules/gateway/probe-runner'
import type { Db } from '../src/db/client'
import type { AppConfig } from '../src/config'
const mocks = vi.hoisted(() => ({
  candidates: vi.fn(),
  probe: vi.fn(),
  close: vi.fn(),
}))
vi.mock('../src/modules/gateway/service', () => ({
  gatewayOptions: () => ({}),
  GatewayService: class {
    repo = { probeCandidates: mocks.candidates }
    probeUpstream = mocks.probe
    transport = { close: mocks.close }
  },
}))
afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})
test('runner does not overlap batches and drains the current probe before closing', async () => {
  vi.useFakeTimers()
  mocks.candidates.mockResolvedValue([{ id: 1 }, { id: 2 }])
  let finish!: (value: unknown) => void
  mocks.probe.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const runner = startGatewayProbeRunner({} as Db, {} as AppConfig, logger)
  await vi.advanceTimersByTimeAsync(120000)
  expect(mocks.candidates).toHaveBeenCalledTimes(1)
  expect(mocks.probe).toHaveBeenCalledTimes(1)
  const stopped = runner.stop()
  expect(mocks.close).not.toHaveBeenCalled()
  finish({ verified: false })
  await stopped
  expect(mocks.probe).toHaveBeenCalledTimes(1)
  expect(mocks.close).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(120000)
  expect(mocks.candidates).toHaveBeenCalledTimes(1)
})
test('batch database failure is logged and the next timer retries', async () => {
  vi.useFakeTimers()
  mocks.candidates
    .mockRejectedValueOnce(new Error('fixture DB unavailable'))
    .mockResolvedValue([])
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const runner = startGatewayProbeRunner({} as Db, {} as AppConfig, logger)
  await vi.advanceTimersByTimeAsync(300000)
  expect(logger.error).toHaveBeenCalledTimes(1)
  expect(mocks.candidates).toHaveBeenCalledTimes(2)
  await runner.stop()
})

test('legacy probe settings are bounded and an explicit Node switch takes precedence', () => {
  expect(probePolicy({})).toEqual({ enabled: false, intervalSeconds: 300, batchLimit: 5, quietSeconds: 600 })
  expect(probePolicy({ AGENT_CREDENTIAL_PROBE_ENABLED: 'yes', AGENT_CREDENTIAL_PROBE_INTERVAL_SECONDS: '10', AGENT_CREDENTIAL_PROBE_BATCH_LIMIT: '2', AGENT_CREDENTIAL_PROBE_QUIET_SECONDS: '90' })).toEqual({ enabled: true, intervalSeconds: 30, batchLimit: 2, quietSeconds: 90 })
  expect(probePolicy({ GATEWAY_ENABLE_PROBES: 'false', AGENT_CREDENTIAL_PROBE_ENABLED: 'true' }).enabled).toBe(false)
})
