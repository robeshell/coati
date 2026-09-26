import type { Protocol } from './schema'

/** Preserve Python endpoint handling for bare roots, version roots and full URLs. */
export function upstreamEndpoint(base: string, protocol: Protocol) {
  const root = base.replace(/\/+$/, '')
  if (protocol === 'anthropic') {
    if (root.endsWith('/messages')) return root
    return root + (root.endsWith('/v1') ? '/messages' : '/v1/messages')
  }
  const suffix = protocol === 'openai' ? '/chat/completions' : '/responses'
  return root.endsWith(suffix) ? root : root + suffix
}
