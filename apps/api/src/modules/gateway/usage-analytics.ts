import { usageBucketIso } from './usage-bucket'
import type { GatewayRepository } from './repository'
import { legacyUsageFilters } from './legacy-pat'
import { aggregateUsage } from './usage-analytics-repository'
import { z } from 'zod'
function formatAnalytics(
  repo: GatewayRepository,
  result: Awaited<ReturnType<typeof aggregateUsage>>,
) {
  const requests = Number(result.summary.requests),
    errors = Number(result.summary.errors)
  return {
    timezone: repo.quotaTimezone,
    summary: {
      ...result.summary,
      cache_hit_rate: result.summary.cache_hit_rate == null ? null : Math.round(Number(result.summary.cache_hit_rate) * 10) / 10,
      successful_requests: requests - errors,
      success_rate: requests
        ? Math.round(((requests - errors) / requests) * 1000) / 10
        : 0,
    },
    trend: result.trend.map(({ local_bucket, ...row }) => ({
      ...row,
      bucket: usageBucketIso(String(local_bucket), repo.quotaTimezone),
    })),
    models: {
      tokens: result.modelTokens,
      items: result.models.map((row) => ({
        ...row,
        share_percent: result.modelTokens
          ? Math.round((Number(row.tokens) / result.modelTokens) * 1000) / 10
          : 0,
      })),
    },
  }
}
export async function personalUsageAnalytics(
  repo: GatewayRepository,
  owner: number,
  query: unknown,
) {
  const result = await aggregateUsage(
    repo,
    { kind: 'personal', owner },
    legacyUsageFilters(query),
  )
  return {
    ...formatAnalytics(repo, result),
    users: [],
    daily_quota_per_user: null,
    quota: await repo.quotaSummary(owner),
    filter_options: {
      models: result.options.map((row) => ({
        value: row.model,
        label: row.model,
      })),
      pats: result.pats.map((row) => ({
        value: row.id,
        label: [
          row.name || `令牌 #${row.id}`,
          row.kind === 'device' ? '设备' : null,
          row.revoked ? '已撤销' : row.expired ? '已过期' : null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    },
  }
}

export async function adminUsageAnalytics(
  repo: GatewayRepository,
  query: unknown,
) {
  const filters = legacyUsageFilters(query)
  const { user_id } = z
    .object({
      user_id: z.preprocess(
        (value) => (value === '' || value == null ? undefined : value),
        z.coerce.number().int().positive().safe().optional(),
      ),
    })
    .parse(query)
  const result = await aggregateUsage(
    repo,
    { kind: 'admin', owner: user_id },
    filters,
  )
  return {
    ...formatAnalytics(repo, result),
    users: result.users,
    upstreams: result.upstreams,
    daily_quota_per_user: repo.defaultQuota || null,
    filter_options: {
      users: result.userOptions,
      models: result.options.map((row) => ({
        value: row.model,
        label: row.model,
      })),
    },
  }
}
