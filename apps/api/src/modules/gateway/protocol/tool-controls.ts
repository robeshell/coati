import { declaredTools } from './responses-helpers'
import type { Protocol } from '../schema'
import {
  array,
  object,
  isObject,
  type Obj,
  ProtocolBridgeError,
} from './compat-helpers'

/** Preserve explicit parallel-call control without adding tool choice to tool-less requests. */
export function preserveParallelTools(
  body: Obj,
  converted: Obj,
  source: Protocol,
  target: Protocol,
): Obj {
  const raw =
    source === 'anthropic'
      ? object(body.tool_choice).disable_parallel_tool_use
      : body.parallel_tool_calls
  if (raw == null) return converted
  if (typeof raw !== 'boolean')
    throw new ProtocolBridgeError('工具并行控制必须为布尔值')
  if (!array(converted.tools).length) return converted
  const parallel = source === 'anthropic' ? !raw : raw
  if (target === 'anthropic') {
    const choice = object(converted.tool_choice)
    if (choice.type !== 'none')
      converted.tool_choice = {
        type: 'auto',
        ...choice,
        disable_parallel_tool_use: !parallel,
      }
  } else converted.parallel_tool_calls = parallel
  return converted
}

/** Copy only tool-level controls; JSON Schema properties are never inspected. */
export function preserveStrictTools(
  body: Obj,
  converted: Obj,
  source: Protocol,
  target: Protocol,
): Obj {
  const definitions = new Map<unknown, unknown>()
  for (const raw of source === 'responses'
    ? declaredTools(body)
    : array(body.tools)) {
    const tool = object(raw)
    const fn =
      source !== 'anthropic' && isObject(tool.function) ? tool.function : tool
    if (!Object.prototype.hasOwnProperty.call(fn, 'strict')) continue
    if (typeof fn.strict !== 'boolean')
      throw new ProtocolBridgeError('工具严格模式必须为布尔值')
    if (!fn.name || definitions.has(fn.name))
      throw new ProtocolBridgeError('工具严格模式声明无法唯一匹配')
    definitions.set(fn.name, fn.strict)
  }
  for (const [name, strict] of definitions) {
    const matches = array(converted.tools)
      .map((raw) => {
        const tool = object(raw)
        return target === 'openai' ? object(tool.function) : tool
      })
      .filter((fn) => fn.name === name)
    if (matches.length !== 1)
      throw new ProtocolBridgeError('工具严格模式声明无法唯一匹配')
    matches[0]!.strict = strict
  }
  return converted
}
