import { supportedModels } from './account-models'
import type { Account, ResolvedRoute } from './pool-route'

export function personalModelNames(account: Account): string[] {
  const raw = account.model_prefix.trim()
  if (!raw) return []
  const prefix = /[/-]$/.test(raw) ? raw : `${raw}/`
  return supportedModels(account).map((model) => prefix + model)
}

export function personalRoute(
  account: Account,
  owner: number,
  model: string,
): ResolvedRoute | null {
  if (
    account.scope !== 'personal' ||
    account.owner_user_id !== owner ||
    !account.enabled
  )
    return null
  const index = personalModelNames(account).indexOf(model)
  const actual = supportedModels(account)[index]
  if (!actual) return null
  return {
    id: account.id,
    model,
    upstream_id: account.id,
    upstream_model: actual,
    vision_model: null,
    upstream_base: null,
    description: null,
    enabled: true,
    priority: 1000 - account.priority,
    created_at: account.created_at,
    personal_owner: owner,
  }
}
