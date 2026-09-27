import { schedulingPolicy, inHealthPenalty, preferredHealthy } from '../src/modules/gateway/scheduling-policy'
import { expect, test } from 'vitest'
import {
  orderCandidates,
  smoothCandidates,
  personalCandidates,
} from '../src/modules/gateway/selection'
const pool = [1, 2, 3].map((id, index) => ({
  route: { id, priority: 100 },
  upstream: { id, weight: [1, 3, 2][index]! },
}))
test('affinity ranking matches Python SHA256 exponential scoring and ignores enumeration order', () => {
  const rank = orderCandidates(pool, '7:session-a:model-a').map(
    (c) => c.upstream.id,
  )
  expect(rank).toEqual([2, 3, 1])
  expect(
    orderCandidates([...pool].reverse(), '7:session-a:model-a').map(
      (c) => c.upstream.id,
    ),
  ).toEqual(rank)
  expect(pool.map((c) => c.upstream.id)).toEqual([1, 2, 3])
})
test('priority overrides weight and affinity, removing a candidate preserves remaining affinity order', () => {
  const sorted = orderCandidates(pool, 'session')
  expect(
    orderCandidates(
      pool.filter((c) => c.upstream.id !== sorted[0]!.upstream.id),
      'session',
    ),
  ).toEqual(sorted.slice(1))
  const preferred = { ...pool[0]!, route: { id: 4, priority: 1 } }
  expect(orderCandidates([...pool, preferred], 'session')[0]).toEqual(preferred)
})
test('unbound weighted routing is proportional without selecting a candidate twice', () => {
  let seed = 42
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0
    return (seed + 1) / (2 ** 32 + 1)
  }
  let heavy = 0
  for (let i = 0; i < 10000; i++) {
    const ranked = orderCandidates(pool.slice(0, 2), undefined, random)
    expect(new Set(ranked.map((c) => c.upstream.id)).size).toBe(2)
    if (ranked[0]!.upstream.id === 2) heavy++
  }
  expect(heavy / 10000).toBeGreaterThan(0.73)
  expect(heavy / 10000).toBeLessThan(0.77)
})

test('duplicate routes for one account do not buy extra random samples', () => {
  let calls = 0
  const random = () => {
    calls++
    return 0.5
  }
  const duplicate = { ...pool[0]!, route: { ...pool[0]!.route, id: 99 } }
  const sorted = orderCandidates([...pool, duplicate], undefined, random)
  expect(calls).toBe(3)
  expect(sorted[0]!.upstream.id).toBe(2)
})

test('smooth ordering includes session and request load divided by account weight', () => {
  const load = {
    bindings: { 1: 0, 2: 8, 3: 0 },
    active: { 1: 0, 2: 0, 3: 10 },
    last: null,
  }
  expect(smoothCandidates(pool, load).map((c) => c.upstream.id)).toEqual([
    1, 2, 3,
  ])
  expect(pool.map((c) => c.upstream.id)).toEqual([1, 2, 3])
})
test('equal smooth scores rotate after the last account without crossing priorities', () => {
  const equal = pool.map((c) => ({
    ...c,
    upstream: { ...c.upstream, weight: 1 },
  }))
  expect(
    smoothCandidates(equal, { bindings: {}, active: {}, last: 1 }).map(
      (c) => c.upstream.id,
    ),
  ).toEqual([2, 1, 3])
  const preferred = { ...equal[0]!, route: { id: 4, priority: 1 } }
  expect(
    smoothCandidates([...equal, preferred], {
      bindings: { 1: 100 },
      active: {},
      last: 1,
    })[0],
  ).toEqual(preferred)
})

test('personal load ties preserve weighted random ranking instead of preferring the smallest ID', () => {
  const equal = pool.map(c => ({...c, upstream: {...c.upstream, weight: 1}}))
  const values = [0.1, 0.9, 0.5]
  expect(personalCandidates(equal, {1: 1, 2: 1, 3: 1}, () => values.shift()!).map(c => c.upstream.id)).toEqual([2, 3, 1])
  expect(personalCandidates(equal, {1: 10, 2: 0, 3: 2}, () => 0.5).map(c => c.upstream.id)).toEqual([2, 3, 1])
})

test('Python health windows demote recent failures but retain an all-penalized fallback pool', () => {
  const policy=schedulingPolicy({}), now=Date.parse('2030-01-01T00:10:00Z')
  const healthy={upstream:{health_status:'healthy',last_error_at:null}}
  const soft={upstream:{health_status:'healthy',last_error_at:new Date(now-9000).toISOString()}}
  const hard={upstream:{health_status:'unhealthy',last_error_at:new Date(now-299000).toISOString()}}
  expect(preferredHealthy([soft,hard,healthy],policy,now)).toEqual([healthy])
  expect(preferredHealthy([soft,hard],policy,now)).toEqual([soft,hard])
  expect(inHealthPenalty(soft.upstream,policy,now+1000)).toBe(false)
  expect(inHealthPenalty(hard.upstream,policy,now+1000)).toBe(false)
  expect(inHealthPenalty({health_status:'cooldown',last_error_at:new Date(now).toISOString()},policy,now)).toBe(false)
  expect(inHealthPenalty(soft.upstream,{...policy,softRetrySeconds:0},now)).toBe(false)
})
test('Python scheduling settings retain zero behavior and clamp the candidate window', () => {
  expect(schedulingPolicy({AGENT_GATEWAY_SELECTION_POOL_SIZE:'100',AGENT_CREDENTIAL_SOFT_RETRY_SECONDS:'0',AGENT_CREDENTIAL_UNHEALTHY_RETRY_SECONDS:'0',AGENT_CREDENTIAL_COOLDOWN_SECONDS:'0',AGENT_CREDENTIAL_FAILURE_THRESHOLD:'0'})).toEqual({selectionPoolSize:50,softRetrySeconds:0,unhealthyRetrySeconds:300,cooldownSeconds:60,failureThreshold:1})
})
