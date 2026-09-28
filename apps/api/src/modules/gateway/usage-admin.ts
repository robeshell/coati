import { z } from 'zod'
import type { GatewayRepository } from './repository'
import { usageFilters, usageItem } from './personal-access'
export async function listAdminUsage(repo: GatewayRepository, query: unknown) {
  const filters = usageFilters(query)
  const { user_id } = z
    .object({
      user_id: z.preprocess(
        (value) => (value == null || value === '' ? undefined : value),
        z.coerce.number().int().positive().safe().optional(),
      ),
    })
    .parse(query)
  const result = await repo.usagePage(
    { kind: 'admin', owner: user_id },
    filters,
    filters.pat_id,
  )
  return {
    items: result.rows.map((item) => ({
      ...usageItem(item),
      user_id: item.user_id,
      username: item.username,
      pat_id: item.row.key_id,
      credential_id: item.row.execution?.upstream_id ?? item.credential_id,
      credential_name: item.row.execution?.upstream_name ?? null,
      // Never reconstruct old execution metadata from mutable configuration.
      upstream_model: item.row.execution?.upstream_model ?? null,
      route_id: item.row.execution?.route_id ?? null,
      route_name: item.row.execution?.route_name ?? null,
      provider: item.row.execution?.provider ?? null,
      error_summary: item.row.error || '',
    })),
    total: result.total,
    page: filters.page,
    per_page: filters.per_page,
  }
}
