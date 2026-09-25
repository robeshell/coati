import { z } from 'zod'
export const protocolSchema = z.enum(['openai', 'anthropic', 'responses'])
export type Protocol = z.infer<typeof protocolSchema>
export const upstreamSchema = z.object({
  name: z.string().trim().min(1).max(100),
  protocol: protocolSchema,
  base_url: z.url().max(2000),
  api_key: z.string().min(1).max(8192).optional(),
  enabled: z.boolean().default(true),
})
export const routeSchema = z.object({
  model: z.string().trim().min(1).max(200),
  upstream_id: z.number().int().positive(),
  upstream_model: z.string().trim().min(1).max(200),
  priority: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
})
export const keySchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['personal', 'application', 'device']).default('personal'),
  models: z.array(z.string().min(1).max(200)).min(1).max(100),
  daily_limit: z.number().int().min(0).max(1e12).default(0),
  concurrency_limit: z.number().int().min(1).max(1000).default(10),
  rpm_limit: z.number().int().min(1).max(100000).default(60),
  expires_days: z.number().int().min(1).max(365).default(30),
})
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
export class GatewayError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'gateway_error',
  ) {
    super(message)
  }
}
