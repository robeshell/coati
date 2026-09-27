import { GatewayError } from './schema'
import type { BridgeOptions } from './protocol/opaque-content'

/** Validate once, including tool shortcuts that do not execute a model round. */
export function bridgePolicy(headers: Record<string, unknown>): Required<BridgeOptions> {
  const reasoningPolicy = headers['x-coati-reasoning-policy'] ?? 'preserve'
  const compatibilityPolicy = headers['x-coati-compatibility-policy'] ?? 'python'
  if (reasoningPolicy !== 'preserve' && reasoningPolicy !== 'text-only')
    throw new GatewayError(400, '推理兼容模式无效', 'invalid_request')
  if (compatibilityPolicy !== 'python' && compatibilityPolicy !== 'strict')
    throw new GatewayError(400, '协议兼容策略无效', 'invalid_request')
  return { reasoningPolicy, compatibilityPolicy }
}
