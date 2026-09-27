import { sql, type SQL } from 'drizzle-orm'
import type { GatewayRepository } from './repository'

export interface UsageFilters {
  days: number
  status?: string
  model?: string
  pat_id?: number
}
export type UsageScope =
  | { kind: 'personal'; owner: number }
  | { kind: 'admin'; owner?: number }
export async function aggregateUsage(
  repo: GatewayRepository,
  scope: UsageScope,
  filters: UsageFilters,
) {
  const status = sql`case when r.status='error' then 'upstream_error' when r.status='cancelled' then 'client_error' else r.status end`
  const time = sql`r.created_at >= now() - (${filters.days} * interval '1 day')`
  const base = sql`${time} ${scope.owner === undefined ? sql`` : sql`and k.owner_id=${scope.owner}`}`
  const optionScope = scope.kind === 'admin' ? time : base
  const where = (model = true) => sql`${base}
    and ${filters.status ? sql`${status}=${filters.status}` : sql`r.status <> 'reserved'`}
    ${filters.pat_id ? sql`and r.key_id=${filters.pat_id}` : sql``}
    ${model && filters.model ? sql`and r.model=${filters.model}` : sql``}`
  const billable = sql`r.status in ('ok','stream_error','client_error','cancelled')`
  const sum = (field: SQL) =>
    sql`coalesce(sum(case when ${billable} then ${field} else 0 end),0)::float8`
  const tokens = sum(sql`r.input_tokens+r.output_tokens`)
  const from = sql`from gw_requests r join gw_keys k on k.id=r.key_id`
  const errors = sql`coalesce(sum(case when r.status <> 'ok' then 1 else 0 end),0)::integer`
  return repo.db.transaction(
    async (tx) => {
      const summary = await tx.execute(sql`select count(*)::integer as requests,
      ${sum(sql`r.input_tokens`)} as prompt_tokens, ${sum(sql`r.output_tokens`)} as completion_tokens,
      ${tokens} as tokens, ${errors} as errors,
      trunc(coalesce(avg(r.duration_ms),0))::float8 as avg_latency_ms,
      trunc(coalesce(percentile_cont(0.95) within group(order by r.duration_ms),0)::numeric)::float8 as p95_latency_ms,
      count(distinct k.owner_id)::integer as active_users, count(distinct r.model)::integer as active_models,
      (sum(r.cache_read_tokens) filter(where ${billable}))::float8 as cache_read_tokens,
      (sum(r.cache_write_tokens) filter(where ${billable}))::float8 as cache_write_tokens,
      (sum(r.cache_miss_tokens) filter(where ${billable}))::float8 as cache_miss_tokens,
      count(r.cache_read_tokens) filter(where ${billable})::integer as cache_read_reported_requests,
      count(r.cache_write_tokens) filter(where ${billable})::integer as cache_write_reported_requests,
      count(r.cache_miss_tokens) filter(where ${billable})::integer as cache_miss_reported_requests,
      (sum(r.cache_write_5m_tokens) filter(where ${billable}))::float8 as cache_write_5m_tokens,
      (sum(r.cache_write_1h_tokens) filter(where ${billable}))::float8 as cache_write_1h_tokens,
      count(r.cache_write_5m_tokens) filter(where ${billable})::integer as cache_write_5m_reported_requests,
      count(r.cache_write_1h_tokens) filter(where ${billable})::integer as cache_write_1h_reported_requests,
      (sum(r.reasoning_tokens) filter(where ${billable}))::float8 as reasoning_tokens,
      count(*) filter(where ${billable} and r.usage_source='estimated')::integer as estimated_requests,
      (100.0 * sum(r.cache_read_tokens) filter(where ${billable} and r.cache_read_tokens <= r.input_tokens)
        / nullif(sum(r.input_tokens) filter(where ${billable} and r.cache_read_tokens is not null and r.cache_read_tokens <= r.input_tokens),0))::float8 as cache_hit_rate
      ${from} where ${where()}`)
      const bucket = sql`date_trunc(${filters.days <= 1 ? 'hour' : 'day'},r.created_at at time zone ${repo.quotaTimezone})`
      const trend =
        await tx.execute(sql`select to_char(${bucket},'YYYY-MM-DD"T"HH24:MI:SS') as local_bucket,
      count(*)::integer as requests, ${tokens} as tokens, ${errors} as errors,
      trunc(coalesce(avg(r.duration_ms),0))::float8 as avg_latency_ms
      ${from} where ${where()} group by 1 order by 1`)
      const models =
        await tx.execute(sql`select r.model,count(*)::integer as requests,
      ${sum(sql`r.input_tokens`)} as prompt_tokens,${sum(sql`r.output_tokens`)} as completion_tokens,${tokens} as tokens
      ${from} where ${where(false)} group by r.model order by ${tokens} desc,r.model limit 8`)
      const total = await tx.execute(
        sql`select ${tokens} as tokens ${from} where ${where(false)}`,
      )
      const options = await tx.execute(
        sql`select distinct r.model ${from} where ${optionScope} order by r.model`,
      )
      const pats =
        scope.kind === 'personal'
          ? (
              await tx.execute(sql`select distinct k.id,k.name,k.kind,k.revoked,
          (k.expires_at <= now()) as expired ${from} where ${base} order by k.name,k.id`)
            ).rows
          : []
      const users =
        scope.kind === 'admin'
          ? (
              await tx.execute(sql`select u.id as user_id,u.username,count(*)::integer as requests,
          ${tokens} as tokens,${errors} as errors ${from} join admin_users u on u.id=k.owner_id
          where ${where()} group by u.id,u.username order by ${tokens} desc,u.id limit 8`)
            ).rows
          : []
      const upstreams = scope.kind === 'admin' ? (await tx.execute(sql`
        select r.execution->>'upstream_id' as upstream_id,
        coalesce(r.execution->>'upstream_name','未记录上游') as name,
        coalesce(r.execution->>'upstream_protocol',r.upstream_protocol,'未报告') as protocol,
        count(*)::integer as requests, ${errors} as errors, ${tokens} as tokens,
        (sum(r.cache_read_tokens) filter(where ${billable}))::float8 as cache_read_tokens,
        count(r.cache_read_tokens) filter(where ${billable})::integer as cache_read_reported_requests,
        (100.0 * sum(r.cache_read_tokens) filter(where ${billable} and r.cache_read_tokens <= r.input_tokens)
          / nullif(sum(r.input_tokens) filter(where ${billable} and r.cache_read_tokens is not null and r.cache_read_tokens <= r.input_tokens),0))::float8 as cache_hit_rate
        ${from} where ${where()} group by 1,2,3 order by ${tokens} desc,2 limit 100
      `)).rows : []
      const userOptions =
        scope.kind === 'admin'
          ? (
              await tx.execute(sql`select distinct u.id as value,u.username as label ${from}
          join admin_users u on u.id=k.owner_id where ${time} order by u.username,u.id`)
            ).rows
          : []
      return {
        summary: summary.rows[0]!,
        trend: trend.rows,
        models: models.rows,
        modelTokens: Number(total.rows[0]!.tokens),
        options: options.rows,
        pats,
        users,
        upstreams,
        userOptions,
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
