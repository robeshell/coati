/** Python attaches ZoneInfo with fold=0 to naive local buckets. Prefer the
 * earlier instant at an overlap, and the pre-transition offset in a gap. */
export function usageBucketIso(local: string, timezone: string) {
  const naive = Date.parse(local + 'Z')
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const localEpoch = (instant: number) => {
    const p = Object.fromEntries(
      formatter.formatToParts(instant).map((part) => [part.type, part.value]),
    )
    return Date.parse(
      `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
    )
  }
  const offsets = [-2, 0, 2].map((days) => {
    const instant = naive + days * 86400000
    return localEpoch(instant) - instant
  })
  const candidates = offsets
    .map((offset) => naive - offset)
    .filter((instant) => localEpoch(instant) === naive)
  const offset = candidates.length
    ? naive - Math.min(...candidates)
    : offsets[0]!
  const minutes = offset / 60000
  return `${local}${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`
}
