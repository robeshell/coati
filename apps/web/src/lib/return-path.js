/** Only navigate to an origin-relative application path after authentication. */
export function safeReturnPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value)) return '/'
  return value.startsWith('/login') ? '/' : value
}
