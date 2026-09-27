import type { Protocol } from '../schema'
import { array, object, type Obj, ProtocolBridgeError } from './compat-helpers'
import { declaredTools } from './responses-helpers'

function reject(path: string): never {
  // Include only the field path, never user content or opaque values.
  throw new ProtocolBridgeError(`当前协议转换无法保留参数 ${path}，请使用相同协议的上游路由`)
}

/** Validate request controls before conversion; never recurse into user JSON schemas. */
export function assertRequestControls(body: Obj, source: Protocol, target: Protocol) {
  if (source === target) return
  const known = new Set([
    'model','stream','messages','input','instructions','system','tools','tool_choice',
    'max_tokens','max_completion_tokens','max_output_tokens','temperature','top_p','stop','stop_sequences',
    'metadata','user','stream_options','n','response_format','text','reasoning','reasoning_effort',
    'parallel_tool_calls','thinking','output_config','store','background','previous_response_id','conversation',
    'web_search_options','logit_bias','seed','frequency_penalty','presence_penalty','logprobs','top_logprobs',
    'prediction','audio','modalities','container','top_k',
    // Gateway session routing metadata is deliberately not sent to suppliers.
    'session_id','sessionId',
  ])
  for (const key of Object.keys(body))
    if (!known.has(key) && body[key] != null) reject('unrecognized_request_field')
  if (source === 'anthropic' && body.output_config != null) reject('output_config')
  if (source === 'openai' && body.reasoning_effort != null && target !== 'responses')
    reject('reasoning_effort')
  if (source === 'responses' && body.reasoning != null) {
    if (target !== 'openai') reject('reasoning')
    const reasoning = object(body.reasoning)
    if (!body.reasoning || typeof body.reasoning !== 'object' || Array.isArray(body.reasoning)) reject('reasoning')
    for (const key of Object.keys(reasoning))
      if (key !== 'effort' && reasoning[key] != null) reject(`reasoning.${key}`)
  }
  if (source === 'responses' && object(body.text).verbosity != null) reject('text.verbosity')
  const tools = source === 'responses' ? declaredTools(body) : array(body.tools)
  for (const raw of tools) {
    const tool = object(raw)
    if (tool.type != null && tool.type !== 'function') reject('tools.type')
    const fn = source === 'openai' ? object(tool.function) : tool
    for (const key of ['cache_control', 'defer_loading', 'allowed_callers', 'input_examples'])
      if (tool[key] != null || fn[key] != null) reject(`tools.${key}`)
  }
  const checkContent = (raw: unknown, path: string) => {
    for (const value of array(raw)) {
      const block = object(value)
      if (block.type != null && !['message','text','input_text','output_text','summary_text','refusal','image_url','input_image','image','thinking','redacted_thinking','reasoning','tool_use','tool_result','function_call','function_call_output','additional_tools'].includes(String(block.type))) reject(`${path}.type`)
      if (['document', 'input_file', 'file', 'input_audio', 'audio', 'video'].includes(String(block.type))) reject(`${path}.type`)
      const detail = object(block.image_url).detail ?? block.detail
      if (target === 'anthropic' && detail != null && detail !== 'auto') reject(`${path}.detail`)
      if (block.cache_control != null) reject(`${path}.cache_control`)
      if (block.type === 'tool_result') {
        // These converters flatten tool results to text, so images cannot survive.
        for (const part of array(block.content)) {
          const nested = object(part)
          if (nested.type != null && !['text', 'input_text', 'output_text'].includes(String(nested.type))) reject(`${path}.tool_result.content.type`)
          if (nested.cache_control != null) reject(`${path}.tool_result.content.cache_control`)
        }
      }
    }
  }
  checkContent(body.system, 'system')
  for (const msg of array(source === 'responses' ? body.input : body.messages)) {
    const item = object(msg)
    // Input may contain direct file/audio items as well as messages.
    checkContent([item], 'input')
    checkContent(item.content, 'messages.content')
  }
}

export function preserveReasoningControl(body: Obj, converted: Obj, source: Protocol, target: Protocol): Obj {
  if (source === 'openai' && target === 'responses' && body.reasoning_effort != null)
    converted.reasoning = { effort: body.reasoning_effort }
  if (source === 'responses' && target === 'openai' && object(body.reasoning).effort != null)
    converted.reasoning_effort = object(body.reasoning).effort
  if (source === 'anthropic') {
    for (const message of array(body.messages))
      for (const raw of array(object(message).content)) {
        const block = object(raw)
        if (block.type !== 'tool_result' || block.is_error !== true) continue
        const items = array(target === 'openai' ? converted.messages : converted.input)
        for (const rawItem of items) {
          const item = object(rawItem)
          const matches = target === 'openai'
            ? item.role === 'tool' && item.tool_call_id === block.tool_use_id
            : item.type === 'function_call_output' && item.call_id === block.tool_use_id
          if (matches) {
            const field = target === 'openai' ? 'content' : 'output'
            // Chat/Responses have no is_error flag: expose it as structured
            // tool-result text, rather than turning a failed tool into success.
            item[field] = JSON.stringify({ is_error: true, content: item[field] })
          }
        }
      }
  }
  return converted
}
