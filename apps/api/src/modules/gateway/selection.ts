import { createHash, randomInt } from 'node:crypto'
type Candidate = {
  route: { id: number; priority: number }
  upstream: { id: number; weight: number }
}
/** Weighted exponential race; priority buckets are never crossed by weight or affinity. */
export function orderCandidates<T extends Candidate>(
  candidates: T[],
  affinity?: string,
  random: () => number = () => (randomInt(0, 2 ** 48 - 1) + 1) / (2 ** 48 + 1),
): T[] {
  const samples = new Map<string, number>()
  return candidates
    .map((candidate) => {
      const sampleKey = `${candidate.route.priority}:${candidate.upstream.id}`
      if (!affinity && !samples.has(sampleKey)) samples.set(sampleKey, random())
      const uniform = affinity
        ? (Number(
            createHash('sha256')
              .update(affinity + '\0' + candidate.upstream.id)
              .digest()
              .readBigUInt64BE(),
          ) +
            1) /
          (2 ** 64 + 1)
        : samples.get(sampleKey)!
      return {
        candidate,
        score:
          -Math.log(Math.max(Number.MIN_VALUE, Math.min(1, uniform))) /
          Math.max(1, candidate.upstream.weight),
      }
    })
    .sort(
      (a, b) =>
        a.candidate.route.priority - b.candidate.route.priority ||
        a.score - b.score ||
        String(a.candidate.upstream.id).localeCompare(
          String(b.candidate.upstream.id),
        ) ||
        a.candidate.route.id - b.candidate.route.id,
    )
    .map((item) => item.candidate)
}

export type PoolLoad = {
  bindings: Record<number, number>
  active: Record<number, number>
  last: number | null
}
/** Python smooth session ordering, with Node's documented ascending route priorities. */
export function smoothCandidates<T extends Candidate>(
  candidates: T[],
  load: PoolLoad,
): T[] {
  const result: T[] = []
  for (const priority of [
    ...new Set(candidates.map((c) => c.route.priority)),
  ].sort((a, b) => a - b)) {
    const bucket = candidates.filter((c) => c.route.priority === priority)
    const remaining = [
      ...new Map(bucket.map((c) => [c.upstream.id, c])).values(),
    ].sort((a, b) => a.upstream.id - b.upstream.id)
    let previous = load.last
    while (remaining.length) {
      const score = (c: T) =>
        (Number(load.bindings[c.upstream.id] || 0) +
          Number(load.active[c.upstream.id] || 0) +
          1) /
        Math.max(1, c.upstream.weight)
      const best = Math.min(...remaining.map(score))
      const ties = remaining.filter((c) => score(c) === best)
      const index = ties.findIndex((c) => c.upstream.id === previous)
      const chosen = ties[index >= 0 ? (index + 1) % ties.length : 0]!
      result.push(...bucket.filter((c) => c.upstream.id === chosen.upstream.id))
      remaining.splice(remaining.indexOf(chosen), 1)
      previous = chosen.upstream.id
    }
  }
  return result
}

/** Python personal channels: least weighted active load, random weighted ties. */
export function personalCandidates<T extends Candidate>(candidates: T[], active: Record<number, number>, random?: () => number): T[] {
  const ranked = orderCandidates(candidates, undefined, random)
  return ranked.sort((a, b) => a.route.priority - b.route.priority ||
    (Number(active[a.upstream.id] || 0) + 1) / Math.max(1, a.upstream.weight) -
    (Number(active[b.upstream.id] || 0) + 1) / Math.max(1, b.upstream.weight))
}
