import { supportedModels } from './account-models'
import type { Account, Candidate } from './pool-route'

export type SearchCapability = 'web-search' | 'web-fetch'
/** Only configured protocols and the legacy DeepSeek same-origin endpoint are eligible. */
export function capabilityCandidate(account: Account, capability: SearchCapability): Candidate | undefined {
  if (!account.enabled || account.scope !== 'platform' || account.owner_user_id !== null) return
  let upstream = account
  if (account.protocol === 'openai' && account.provider === 'deepseek') {
    const root = account.base_url.replace(/\/+$/, '').replace(/\/v1$/, '')
    upstream = {...account, protocol:'anthropic',base_url:root + '/anthropic'}
  }
  if (upstream.protocol !== 'anthropic' && !(capability === 'web-search' && upstream.protocol === 'responses')) return
  const model = account.default_model || supportedModels(account)[0]
  if (!model) return
  return {upstream,route:{id:account.id,upstream_id:account.id,model:capability,
    upstream_model:model,vision_model:null,priority:1000-account.priority,enabled:true,
    description:null,upstream_base:null,created_at:account.created_at,automatic_pool:true,capability}}
}
