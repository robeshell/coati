import { utcNowIso } from '@/common/serialize'
import { z } from 'zod'
import type { GatewayRepository } from './repository'
import { GatewayError } from './schema'
export async function listQuotas(repo: GatewayRepository, query: unknown) {
  const integer = (fallback: number, maximum: number) =>
    z.coerce
      .number()
      .int()
      .safe()
      .default(fallback)
      .transform((value) => Math.max(1, Math.min(maximum, value)))
  const { page, per_page, search } = z
    .object({
      page: integer(1, Number.MAX_SAFE_INTEGER),
      per_page: integer(20, 100),
      search: z.string().trim().max(200).optional(),
    })
    .parse(query)
  const result = await repo.quotaPage(page, per_page, search)
  return {
    items: result.rows.map((row) => {
      const effective = row.daily_token_quota ?? repo.defaultQuota
      return {
        ...row,
        updated_at:
          row.daily_token_quota === null || !row.updated_at
            ? null
            : utcNowIso(new Date(row.updated_at)) + 'Z',
        effective_quota: effective || null,
        quota_source: row.daily_token_quota === null ? 'default' : 'user',
        remaining:
          effective > 0 ? Math.max(0, effective - row.used_today) : null,
        usage_percent:
          effective > 0
            ? Math.round(
                Math.min(100, (row.used_today / effective) * 100) * 10,
              ) / 10
            : null,
        exhausted: effective > 0 && row.used_today >= effective,
      }
    }),
    total: result.total,
    page,
    per_page,
    default_daily_quota: repo.defaultQuota || null,
  }
}
export async function updateQuota(
  repo: GatewayRepository,
  owner: number,
  body: unknown,
) {
  if (!(await repo.userLimits(owner))) throw new GatewayError(404, '用户不存在')
  const { daily_token_quota } = z
    .object({
      daily_token_quota: z.preprocess(
        (value) =>
          value === null || value === ''
            ? null
            : typeof value === 'string' && /^\d+$/.test(value.trim())
              ? Number(value)
              : value,
        z.number().int().min(0).max(1_000_000_000).nullable(),
      ),
    })
    .parse(body)
  await repo.saveDailyQuota(owner, daily_token_quota)
  return repo.quotaSummary(owner)
}
