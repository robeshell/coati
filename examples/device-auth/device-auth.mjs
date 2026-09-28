import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

export class ApiError extends Error {
  constructor(status, code) {
    super(`Gateway request failed (HTTP ${status})`)
    this.status = status
    this.code = code
  }
}

export class Client {
  constructor(baseUrl, fetcher = fetch) {
    const url = new URL(baseUrl)
    const local = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Use an HTTPS origin, or HTTP on localhost; credentials and paths are not allowed')
    }
    this.origin = url.origin
    this.fetcher = fetcher
  }

  verificationUrl(path) {
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin || url.username || url.password) throw new Error('Verification URL must use the gateway origin')
    return url.href
  }

  async request(method, path, body, token) {
    const url = this.verificationUrl(path)
    const response = await this.fetcher(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new ApiError(response.status, data?.error_code)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid gateway response')
    return data
  }
}

export async function waitForToken(client, flow, { delay = sleep, now = Date.now } = {}) {
  const ttl = Number(flow.expires_in), initial = Number(flow.interval ?? 5)
  if (!Number.isFinite(ttl) || ttl <= 0 || !Number.isFinite(initial) || initial <= 0 || typeof flow.device_code !== 'string') throw new Error('Invalid device flow')
  const deadline = now() + ttl * 1000
  let interval = initial * 1000
  while (now() < deadline) {
    await delay(Math.min(interval, deadline - now()))
    if (now() >= deadline) break
    try {
      const result = await client.request('POST', '/api/agent/auth/device/poll', { device_code: flow.device_code })
      if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('Missing access token')
      return result.access_token
    } catch (error) {
      if (error instanceof ApiError && error.status === 400 && error.code === 'authorization_pending') continue
      if (error instanceof ApiError && [400, 429].includes(error.status) && error.code === 'slow_down') { interval += 5000; continue }
      throw error
    }
  }
  throw new Error('Device authorization expired')
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { url: { type: 'string', default: 'http://localhost:8080' }, model: { type: 'string' }, prompt: { type: 'string', default: 'Reply with a short hello.' }, help: { type: 'boolean' } } })
  if (values.help) { console.log('node device-auth.mjs --url https://gateway.example [--model MODEL --prompt TEXT]'); return }
  const client = new Client(values.url)
  const flow = await client.request('POST', '/api/agent/auth/device/start', {})
  console.log(`Code: ${flow.user_code}\nOpen: ${client.verificationUrl(flow.verification_uri_complete)}`)
  const token = await waitForToken(client, flow)
  console.log('Authorized. The access token stays in process memory and is never printed.')
  try {
    const me = await client.request('GET', '/api/agent/me', undefined, token)
    console.log(`User: ${me.user.username}`)
    const models = await client.request('GET', '/api/agent/v1/models', undefined, token)
    console.log(`Models: ${models.data.map(item => item.id).join(', ')}`)
    if (values.model) {
      if (!models.data.some(item => item.id === values.model)) throw new Error('Model is not available')
      const result = await client.request('POST', '/api/agent/v1/chat/completions', { model: values.model, messages: [{ role: 'user', content: values.prompt }], stream: false, max_tokens: 64 }, token)
      console.log(result.choices[0].message.content ?? '')
    }
  } finally {
    console.log(`Revoke device-${flow.user_code} in ${client.origin}/gateway/keys when finished.`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Example failed. Check the gateway URL, authorization and model settings.'); process.exitCode = 1 })
}
