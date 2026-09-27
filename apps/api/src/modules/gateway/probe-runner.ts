import type { AppConfig } from '@/config'
import type { Db } from '@/db/client'
import type { SchedulerLogger } from '@/common/scheduler/runner'
import { GatewayService, gatewayOptions } from './service'
import { GatewayError } from './schema'

export function probePolicy(env: NodeJS.ProcessEnv = process.env) {
  const integer = (name: string, fallback: number, minimum: number) => {
    const raw = env[name]?.trim()
    const parsed = raw && /^[+-]?\d+$/.test(raw) ? Number(raw) : fallback
    return Math.max(minimum, Number.isSafeInteger(parsed) && parsed ? Number(parsed) : fallback)
  }
  return {
    // The standalone worker remains opt-in; importing the API never starts probes.
    enabled: /^(1|true|yes|on)$/i.test(env.GATEWAY_ENABLE_PROBES ?? env.AGENT_CREDENTIAL_PROBE_ENABLED ?? ''),
    intervalSeconds: integer('AGENT_CREDENTIAL_PROBE_INTERVAL_SECONDS', 300, 30),
    batchLimit: integer('AGENT_CREDENTIAL_PROBE_BATCH_LIMIT', 5, 1),
    quietSeconds: integer('AGENT_CREDENTIAL_PROBE_QUIET_SECONDS', 600, 30),
  }
}

export async function runProbeBatch(
  service: GatewayService,
  shouldStop = () => false,
  policy = probePolicy(),
) {
  const candidates = await service.repo.probeCandidates(policy.batchLimit, policy.quietSeconds, true)
  const results = []
  for (const candidate of candidates) {
    if (shouldStop()) break
    try {
      results.push({
        id: candidate.id,
        ...(await service.probeUpstream(
          candidate.id,
          policy.quietSeconds,
          candidate.owner_user_id ?? undefined,
        )),
      })
    } catch (error) {
      if (error instanceof GatewayError && error.code === 'probe_busy') continue
      results.push({ id: candidate.id, verified: false })
    }
  }
  return results
}

export function startGatewayProbeRunner(
  db: Db,
  config: AppConfig,
  logger: SchedulerLogger,
) {
  const policy = probePolicy()
  const service = new GatewayService(db, gatewayOptions(config))
  let stopping = false
  let active: Promise<void> | undefined
  const tick = () => {
    if (stopping || active) return
    active = runProbeBatch(service, () => stopping, policy)
      .then(
        () => {},
        (error) => {
          logger.error({ err: error }, 'Gateway recovery probe batch failed')
        },
      )
      .finally(() => {
        active = undefined
      })
  }
  const timer = setInterval(tick, policy.intervalSeconds * 1000)
  tick()
  return {
    async stop() {
      stopping = true
      clearInterval(timer)
      await active
      await service.transport.close()
    },
  }
}
