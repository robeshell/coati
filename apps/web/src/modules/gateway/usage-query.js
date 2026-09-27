/** Keep applied filters across statistics/log tabs, reloads and history navigation. */
export function usageQueryParams(current, filters) {
  const next = new URLSearchParams(current)
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'page') continue
    if (value === '' || value == null) next.delete(key)
    else next.set(key, String(value))
  }
  return next
}
