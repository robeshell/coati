import { z } from 'zod'
import { utcNowIso } from '@/common/serialize'
import type {
  ModelProfileRepository,
  ProfileRow,
} from './model-profile-repository'
const tokens = z.coerce.number().int().min(1).max(1000000)
const nullableTokens = z
  .preprocess((v) => (v === '' ? null : v), tokens.nullable())
  .optional()
const enabled = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())
      : v,
  z.boolean(),
)
const input = z.object({
  model_name: z.string().trim().min(1).max(128),
  context_window_override: nullableTokens,
  max_output_tokens_override: nullableTokens,
  context_window: tokens.optional(),
  max_output_tokens: tokens.optional(),
  enabled: enabled.optional(),
  note: z.string().trim().max(255).nullable().optional(),
})
export function profileRecord(row: ProfileRow) {
  const overrides =
    Number(row.context_window_override !== null) +
    Number(row.max_output_tokens_override !== null)
  return {
    ...row,
    context_window:
      row.context_window_override ?? row.catalog_context_window ?? 128000,
    max_output_tokens:
      row.max_output_tokens_override ?? row.catalog_max_output_tokens ?? 8192,
    source:
      overrides === 2
        ? 'admin'
        : overrides === 1
          ? 'mixed'
          : row.catalog_source
            ? 'catalog'
            : 'fallback',
    created_at: utcNowIso(new Date(row.created_at)) + 'Z',
    updated_at: utcNowIso(new Date(row.updated_at)) + 'Z',
    catalog_synced_at: row.catalog_synced_at
      ? utcNowIso(new Date(row.catalog_synced_at)) + 'Z'
      : null,
  }
}
export async function listProfiles(repo: ModelProfileRepository, raw: unknown) {
  const query = z
    .object({
      page: z.coerce.number().int().min(1).max(1000000).default(1),
      per_page: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().optional(),
      enabled: z.preprocess(
        (v) => (v === '' ? undefined : v),
        enabled.optional(),
      ),
    })
    .parse(raw)
  const result = await repo.page(query)
  return { ...result, items: result.items.map(profileRecord) }
}
export async function saveProfile(
  repo: ModelProfileRepository,
  raw: unknown,
  id?: number,
) {
  const data = (
    id === undefined
      ? input
      : input
          .partial()
          .refine(
            (values) => Object.keys(values).length > 0,
            '请提供需要修改的字段',
          )
  ).parse(raw)
  const { context_window, max_output_tokens, ...values } = data
  if (
    !Object.hasOwn(values, 'context_window_override') &&
    context_window !== undefined
  )
    values.context_window_override = context_window
  if (
    !Object.hasOwn(values, 'max_output_tokens_override') &&
    max_output_tokens !== undefined
  )
    values.max_output_tokens_override = max_output_tokens
  return profileRecord(await repo.save(values, id))
}
export async function syncProfiles(repo: ModelProfileRepository, raw: unknown) {
  const data = z
    .object({
      source: z.string().trim().min(1).max(255).default('admin-import'),
      items: z
        .array(
          z.object({
            model_name: z.string().trim().min(1).max(128),
            context_window: tokens,
            max_output_tokens: tokens,
          }),
        )
        .max(1000)
        .optional(),
      force: z.boolean().optional(),
    })
    .parse(raw ?? {})
  if (!data.items)
    return {
      status: 'disabled',
      message: '自动外部目录同步未启用，请导入已核验的模型能力数据',
      matched_count: 0,
      missing_models: await repo.candidates(),
    }
  return repo.sync(
    [...new Map(data.items.map((row) => [row.model_name, row])).values()],
    data.source,
  )
}
