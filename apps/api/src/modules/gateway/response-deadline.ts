import type { ServerResponse } from 'node:http'

/** Bound downstream writes as well as supplier work. Allow the normal error
 * response a short grace period, then drop sockets that cannot finish draining. */
export function boundResponseLifetime(
  response: ServerResponse,
  timeoutMs: number,
  graceMs = 1000,
) {
  const cleanup = () => {
    clearTimeout(timer)
    response.off('finish', cleanup)
    response.off('close', cleanup)
  }
  const timer = setTimeout(
    () => {
      cleanup()
      if (!response.writableFinished) response.destroy()
    },
    Math.max(0, timeoutMs) + graceMs,
  )
  timer.unref()
  response.once('finish', cleanup)
  response.once('close', cleanup)
  if (response.writableFinished || response.destroyed) cleanup()
}
