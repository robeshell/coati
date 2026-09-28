/** Keep applied filters across statistics/log tabs, reloads and history navigation. */
export function usageQueryParams(current: URLSearchParams, filters: Record<string, unknown>) {
  const next = new URLSearchParams(current)
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'page') continue
    if (value === '' || value == null) next.delete(key)
    else next.set(key, String(value))
  }
  return next
}

/** Read only the declared filter keys; URL parameters are strings. */
export function readUsageFilters<T extends Record<string, string>>(defaults: T, params: URLSearchParams): T {
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, params.get(key) || value])) as T
}
