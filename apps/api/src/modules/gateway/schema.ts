import { proxyUrlSchema } from './account-proxy'
import { accountHeadersSchema } from './account-headers'
import { z } from 'zod'
export const protocolSchema = z.enum(['openai', 'anthropic', 'responses'])
export type Protocol = z.infer<typeof protocolSchema>
export const upstreamSchema = z.object({
  proxy_url: proxyUrlSchema.optional(),
  request_timeout_seconds: z.number().int().min(5).max(300).optional(),
  extra_headers: accountHeadersSchema.optional(),
  note: z.string().trim().max(255).nullable().optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  supported_models: z.preprocess(
    (value) => (value === null || value === '' ? [] : value),
    z
      .array(z.string().trim().max(128))
      .transform((values) => [...new Set(values.filter(Boolean))])
      .pipe(z.array(z.string()).max(50))
      .optional(),
  ),
  default_model: z.preprocess(
    (value) => (value === null ? '' : value),
    z.string().trim().max(128).optional(),
  ),
  provider: z.string().trim().min(1).max(64).optional(),
  weight: z.number().int().min(1).max(10000).default(1),
  concurrency_limit: z.number().int().min(1).max(1000).default(10),
  name: z.string().trim().min(1).max(100),
  protocol: protocolSchema,
  base_url: z.url().max(2000),
  api_key: z.string().min(1).max(8192).optional(),
  enabled: z.boolean().default(true),
})
export const routeSchema = z.object({
  description: z
    .string()
    .trim()
    .max(255)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value)),
  upstream_base: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value)),
  model: z.string().trim().min(1).max(200),
  upstream_id: z.number().int().positive(),
  upstream_model: z.string().trim().min(1).max(200),
  vision_model: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((value) => value || null),
  priority: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
})
export const keySchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['personal', 'application', 'device']).default('personal'),
  scopes: z
    .array(z.enum(['chat', 'profile']))
    .min(1)
    .max(2)
    .default(['chat', 'profile']),
  models: z.array(z.string().min(1).max(200)).min(1).max(100),
  daily_limit: z.number().int().min(0).max(1e12).default(0),
  concurrency_limit: z.number().int().min(0).max(1000).default(0),
  rpm_limit: z.number().int().min(0).max(100000).default(0),
  expires_days: z.number().int().min(1).max(3650).nullable().default(null),
})
export const keyUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    expires_days: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .strict()
export const requestSchema = z
  .object({
    model: z.string().min(1).max(200),
    stream: z.boolean().optional(),
    n: z.literal(1).optional(),
    max_tokens: z.number().int().positive().max(1000000).optional(),
    max_completion_tokens: z.number().int().positive().max(1000000).optional(),
    max_output_tokens: z.number().int().positive().max(1000000).optional(),
  })
  .passthrough()
export type GatewayBody = z.infer<typeof requestSchema>
export function requiresResponseStorage(body: GatewayBody, policy: unknown = 'python') {
  const previous = typeof body.previous_response_id === 'string'
    ? body.previous_response_id.trim() : body.previous_response_id
  // Python always forces store:false. Strict callers can opt into rejection.
  return Boolean(previous || (policy === 'strict' &&
    (body.conversation != null || body.background || body.store === true)))
}
export class GatewayError extends Error {
  requestId?: string
  upstreamBody?: unknown
  constructor(
    public status: number,
    message: string,
    public code = 'gateway_error',
  ) {
    super(message)
  }
}

export const userLimitsSchema = z.object({
  daily_limit: z.number().int().min(0).max(1e12).nullable(),
  concurrency_limit: z.number().int().min(0).max(10000),
  rpm_limit: z.number().int().min(0).max(1000000),
})

export const publicRouteSchema = z.object({
  model: z.string().trim().min(1).max(128),
  upstream_id: z.number().int().positive().nullable().default(null),
  upstream_model: z.string().trim().max(128).nullable().default(null),
  vision_model: z.string().trim().max(128).nullable().default(null),
  upstream_base: z.string().trim().max(2000).nullable().default(null),
  description: z.string().trim().max(255).nullable().default(null),
  fallback_enabled: z.boolean().default(false),
  enabled: z.boolean().default(true),
})
