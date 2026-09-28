/** Only navigate to an origin-relative application path after authentication. */
export function safeReturnPath(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || Array.from(value).some(char => char === '\\' || char.charCodeAt(0) <= 32)) return '/'
  return value.startsWith('/login') ? '/' : value
}
