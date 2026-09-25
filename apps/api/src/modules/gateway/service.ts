import { utcNowIso } from '@/common/serialize'
import { randomUUID, randomBytes } from 'node:crypto'
import type { AppConfig } from '@/config'
import type { Db } from '@/db/client'
import { GatewayRepository, type KeyRow } from './repository'
import { CredentialVault, hashToken, mintToken, redact } from './crypto'
import {
  GatewayError,
  upstreamSchema,
  routeSchema,
  keySchema,
  requestSchema,
  type Protocol,
} from './schema'
import { GatewayTransport, readBounded, validateBase } from './transport'
import { UsageMeter, nativeStream, rewriteModel, streamError } from './stream'

export interface GatewayOptions {
  encryptionKey: string
  allowPrivate: boolean
  timeoutMs: number
  idleTimeoutMs: number
}
export function gatewayOptions(config: AppConfig): GatewayOptions {
  const encryptionKey =
    process.env.GATEWAY_ENCRYPTION_KEY ||
    (config.isProduction ? '' : config.secretKey)
  if (!encryptionKey)
    throw new Error('Production requires GATEWAY_ENCRYPTION_KEY')
  return {
    encryptionKey,
    allowPrivate: process.env.GATEWAY_ALLOW_PRIVATE_UPSTREAMS === 'true',
    timeoutMs: 180000,
    idleTimeoutMs: 30000,
  }
}
const paths: Record<Protocol, string> = {
  openai: '/chat/completions',
  anthropic: '/messages',
  responses: '/responses',
}
export class GatewayService {
  readonly repo: GatewayRepository
  readonly vault: CredentialVault
  readonly transport: GatewayTransport
  constructor(
    db: Db,
    readonly options: GatewayOptions,
    readonly report: (error: unknown) => void = () => {},
  ) {
    this.repo = new GatewayRepository(db)
    this.vault = new CredentialVault(options.encryptionKey)
    this.transport = new GatewayTransport(options.allowPrivate)
  }
  async upstreams() {
    return (await this.repo.upstreams()).map(({ secret, ...x }) => ({
      ...x,
      has_secret: Boolean(secret),
    }))
  }
  async saveUpstream(value: unknown, id?: number) {
    const input = upstreamSchema.parse(value)
    const existing = id
      ? (await this.repo.upstreams()).find((x) => x.id === id)
      : null
    if (id && !existing) throw new GatewayError(404, '模型服务不存在')
    if (!input.api_key && !existing)
      throw new GatewayError(400, '请输入上游 API Key')
    const row = await this.repo.saveUpstream(
      {
        name: input.name,
        protocol: input.protocol,
        base_url: validateBase(input.base_url, this.options.allowPrivate),
        enabled: input.enabled,
        secret: input.api_key
          ? this.vault.encrypt(input.api_key)
          : existing!.secret,
      },
      id,
    )
    const { secret, ...safe } = row!
    return { ...safe, has_secret: Boolean(secret) }
  }
  async saveRoute(value: unknown, id?: number) {
    const data = routeSchema.parse(value)
    if (!(await this.repo.upstreams()).some((x) => x.id === data.upstream_id))
      throw new GatewayError(400, '请选择有效的模型服务')
    const row = await this.repo.saveRoute(data, id)
    if (!row) throw new GatewayError(404, '路由不存在')
    return row
  }
  async keys(owner: number) {
    return (await this.repo.keys(owner)).map(
      ({ digest: _digest, ...safe }) => safe,
    )
  }
  async createKey(owner: number, value: unknown) {
    const data = keySchema.parse(value),
      token = mintToken()
    const { expires_days, ...fields } = data
    const row = await this.repo.createKey({
      ...fields,
      owner_id: owner,
      digest: hashToken(token),
      prefix: token.slice(0, 12),
      expires_at:
        utcNowIso(new Date(Date.now() + expires_days * 86400000)) + 'Z',
    })
    const { digest: _digest, ...safe } = row
    return { ...safe, token }
  }
  async authenticate(raw: string) {
    const key = raw && (await this.repo.key(hashToken(raw)))
    if (
      !key ||
      key.revoked ||
      (key.expires_at && Date.parse(key.expires_at) <= Date.now())
    )
      throw new GatewayError(401, 'API Key 无效或已过期', 'invalid_api_key')
    return key
  }
  async models(key: KeyRow) {
    return {
      object: 'list',
      data: [
        ...new Set(
          (await this.repo.models())
            .filter(
              (x) => key.models.includes('*') || key.models.includes(x.model),
            )
            .map((x) => x.model),
        ),
      ].map((id) => ({ id, object: 'model', owned_by: 'coati' })),
    }
  }
  async execute(
    key: KeyRow,
    raw: unknown,
    protocol: Protocol,
    clientSignal: AbortSignal,
  ) {
    const body = requestSchema.parse(raw)
    if (!key.models.includes('*') && !key.models.includes(body.model))
      throw new GatewayError(403, '无权访问此模型', 'model_forbidden')
    if (body.previous_response_id || body.background || body.store === true)
      throw new GatewayError(
        400,
        '此版本不持久化 Responses；请传入完整历史并设置 store:false',
        'unsupported_feature',
      )
    const candidates = await this.repo.candidates(body.model, protocol)
    if (!candidates.length)
      throw new GatewayError(
        404,
        '没有可用的同协议路由；此版本不静默转换协议',
        'model_not_found',
      )
    const id = randomUUID(),
      started = Date.now(),
      meter = new UsageMeter()
    const promptEstimate = Math.max(
      1,
      Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 3),
    )
    const outputLimit =
      body.max_completion_tokens ??
      body.max_output_tokens ??
      body.max_tokens ??
      4096
    const denied = await this.repo.reserve(key.id, {
      id,
      model: body.model,
      protocol,
      reserved_tokens: promptEstimate + outputLimit,
      expires_at:
        utcNowIso(new Date(Date.now() + this.options.timeoutMs + 60000)) + 'Z',
    })
    if (denied)
      throw new GatewayError(
        denied === 'unauthorized' ? 401 : 429,
        denied === 'quota_exceeded' ? '剩余额度不足以预留本次请求' : denied,
        denied,
      )
    const controller = new AbortController(),
      signal = AbortSignal.any([
        clientSignal,
        controller.signal,
        AbortSignal.timeout(this.options.timeoutMs),
      ])
    let secret = '',
      settled = false,
      firstByte: number | undefined
    const finish = async (status: string, error?: string) => {
      if (settled) return
      const usage = meter.result(promptEstimate)
      await this.repo.finish(id, {
        status,
        ...usage,
        error: error ? redact(error, [secret]) : null,
        duration_ms: Date.now() - started,
        first_byte_ms: firstByte ?? null,
      })
      settled = true
    }
    try {
      for (let i = 0; i < candidates.length; i++) {
        const { upstream, route } = candidates[i]!
        secret = this.vault.decrypt(upstream.secret)
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: body.stream ? 'text/event-stream' : 'application/json',
        }
        if (protocol === 'anthropic') {
          headers['x-api-key'] = secret
          headers['anthropic-version'] = '2023-06-01'
        } else headers.authorization = `Bearer ${secret}`
        const payload: Record<string, unknown> = {
          ...body,
          model: route.upstream_model,
        }
        if (protocol === 'anthropic' && payload.max_tokens === undefined)
          payload.max_tokens = outputLimit
        if (protocol === 'responses') payload.store = false
        if (protocol === 'responses' && payload.max_output_tokens === undefined)
          payload.max_output_tokens = outputLimit
        if (
          protocol === 'openai' &&
          payload.max_tokens === undefined &&
          payload.max_completion_tokens === undefined
        )
          payload.max_completion_tokens = outputLimit
        if (protocol === 'openai' && body.stream)
          payload.stream_options = {
            ...((body.stream_options as object) || {}),
            include_usage: true,
          }
        const attemptStart = Date.now()
        let response
        try {
          response = await this.transport.send(
            validateBase(upstream.base_url, this.options.allowPrivate) +
              paths[protocol],
            payload,
            headers,
            signal,
          )
        } catch (error) {
          await this.repo.attempt({
            request_id: id,
            upstream_id: upstream.id,
            duration_ms: Date.now() - attemptStart,
            error: redact(String(error), [secret]),
          })
          throw error
        }
        if (!response.ok) {
          const text = redact(await readBounded(response, 65536), [secret])
          await this.repo.attempt({
            request_id: id,
            upstream_id: upstream.id,
            status: response.status,
            duration_ms: Date.now() - attemptStart,
            error: text,
          })
          if ([429, 503].includes(response.status) && i < candidates.length - 1)
            continue
          throw new GatewayError(
            response.status === 429 ? 429 : 502,
            `上游 ${response.status}: ${text}`,
            'upstream_error',
          )
        }
        if (body.stream) {
          if (
            !response.headers.get('content-type')?.includes('text/event-stream')
          ) {
            await response.body?.cancel()
            throw new GatewayError(502, '上游未返回 SSE 响应')
          }
          const { repo, options, report } = this
          async function* stream() {
            let idle: ReturnType<typeof setTimeout> | undefined
            const reset = () => {
              clearTimeout(idle)
              idle = setTimeout(
                () => controller.abort(new Error('上游流式响应超时')),
                options.idleTimeoutMs,
              )
              idle.unref()
            }
            try {
              reset()
              const source = async function* () {
                for await (const chunk of response!.body!) {
                  reset()
                  yield chunk
                }
              }
              let terminal = ''
              for await (const event of nativeStream(
                source(),
                protocol,
                body.model,
                meter,
              )) {
                if (firstByte === undefined) firstByte = Date.now() - started
                if (meter.finished) {
                  terminal += event
                  if (Buffer.byteLength(terminal) > 1024 * 1024) throw new GatewayError(502, '上游 SSE 事件超过大小限制')
                } else yield event
              }
              await finish('ok')
              if (terminal) yield terminal
            } catch (error) {
              const message = redact(
                error instanceof Error ? error.message : String(error),
                [secret],
              )
              await finish(
                clientSignal.aborted ? 'cancelled' : 'stream_error',
                message,
              ).catch(report)
              if (!clientSignal.aborted)
                yield streamError(protocol, message, id)
            } finally {
              clearTimeout(idle)
              controller.abort()
              if (!settled) await finish('cancelled', '客户端中断流式响应').catch(report)
              await repo
                .attempt({
                  request_id: id,
                  upstream_id: upstream.id,
                  status: 200,
                  duration_ms: Date.now() - attemptStart,
                  error: meter.finished ? null : '流未正常完成',
                })
                .catch(report)
            }
          }
          return { id, stream: stream() }
        }
        const text = await readBounded(response)
        let json
        try {
          json = JSON.parse(text)
        } catch {
          throw new GatewayError(502, '上游未返回有效 JSON')
        }
        if (json === null || typeof json !== 'object' || Array.isArray(json))
          throw new GatewayError(502, '上游未返回有效 JSON')
        meter.observe(json, protocol)
        meter.outputCharacters = JSON.stringify(json).length
        await this.repo.attempt({
          request_id: id,
          upstream_id: upstream.id,
          status: response.status,
          duration_ms: Date.now() - attemptStart,
        })
        await finish('ok')
        return { id, json: rewriteModel(json, body.model) }
      }
      throw new GatewayError(503, '所有上游暂时不可用')
    } catch (error) {
      controller.abort()
      await finish(
        clientSignal.aborted ? 'cancelled' : 'error',
        String(error),
      ).catch(this.report)
      if (error instanceof GatewayError) throw error
      throw new GatewayError(
        signal.aborted ? 504 : 502,
        signal.aborted ? '请求取消或上游超时' : '上游连接失败',
        'upstream_error',
      )
    }
  }
  async startDevice() {
    const deviceCode = randomBytes(32).toString('base64url'),
      userCode = randomBytes(5).toString('hex').toUpperCase()
    await this.repo.createDevice({
      device_hash: hashToken(deviceCode),
      user_code: userCode,
      expires_at: utcNowIso(new Date(Date.now() + 600000)) + 'Z',
    })
    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: '/agent/device-confirm',
      expires_in: 600,
      interval: 5,
    }
  }
  async pollDevice(code: string) {
    const token = mintToken(),
      error = await this.repo.consumeDevice(hashToken(code), {
        name: '设备授权',
        kind: 'device',
        digest: hashToken(token),
        prefix: token.slice(0, 12),
        models: ['*'],
        daily_limit: 100000,
        concurrency_limit: 5,
        rpm_limit: 60,
        expires_at: utcNowIso(new Date(Date.now() + 30 * 86400000)) + 'Z',
      })
    if (error) throw new GatewayError(400, error, error)
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 2592000,
      scope: 'chat profile',
    }
  }
}
