import { randomUUID } from 'node:crypto'
import {
  type Obj,
  object,
  isObject,
  array,
  truthy,
  fallback,
  text,
  get,
  userId,
  jsonObject,
  schemaDefault,
  mergeAnthropic,
  ProtocolBridgeError,
} from './compat-helpers'
import { responsesContent, declaredTools } from './responses-helpers'
import { chatImage } from './chat-anthropic'
function contentBlocks(value: unknown): Obj[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  const out: Obj[] = []
  for (const part of array(value)) {
    if (typeof part === 'string') {
      out.push({ type: 'text', text: part })
      continue
    }
    if (!isObject(part)) continue
    if (['input_text', 'output_text', 'text'].includes(String(part.type)))
      out.push({ type: 'text', text: part.text || '' })
    else if (part.type === 'refusal') {
      const refusal = part.refusal || part.text
      if (refusal) out.push({ type: 'text', text: String(refusal) })
    } else if (
      ['input_image', 'image_url', 'image'].includes(String(part.type))
    ) {
      const converted = chatImage({ image_url: part.image_url || part.url })
      if (converted) out.push(converted)
    }
  }
  return out
}
export function responsesToAnthropicRequest(raw: unknown): Obj {
  const body = object(raw),
    messages: Obj[] = [],
    systems: string[] = [],
    reasoning: Obj[] = [],
    assistant: Obj[] = []
  const flush = () => {
    if (reasoning.length || assistant.length)
      messages.push({
        role: 'assistant',
        content: [...reasoning.splice(0), ...assistant.splice(0)],
      })
  }
  if (typeof body.input === 'string')
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: body.input }],
    })
  else
    for (const item of array(body.input)) {
      if (typeof item === 'string') {
        flush()
        messages.push({ role: 'user', content: [{ type: 'text', text: item }] })
        continue
      }
      if (!isObject(item)) continue
      if (item.type === 'reasoning') {
        const t = responsesContent(fallback(item.summary, item.content)).text
        if (item.encrypted_content)
          reasoning.push({
            type: 'thinking',
            thinking: t,
            signature: item.encrypted_content,
          })
        else if (t) reasoning.push({ type: 'text', text: t })
        continue
      }
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        assistant.push({
          type: 'tool_use',
          id: item.call_id || item.id || '',
          name: item.name || '',
          input: jsonObject(
            item.arguments,
            'Responses 工具调用参数不是有效 JSON，无法转换为 Anthropic tool_use',
          ),
        })
        continue
      }
      if (item.type === 'function_call_output') {
        flush()
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: item.call_id || '',
              content:
                typeof item.output === 'string' || Array.isArray(item.output)
                  ? item.output
                  : String(item.output || ''),
            },
          ],
        })
        continue
      }
      const role = item.role || 'user'
      if (role === 'developer' || role === 'system') {
        flush()
        const t = responsesContent(item.content).text
        if (t) systems.push(t)
        continue
      }
      if (role === 'assistant' || role === 'model') {
        assistant.push(...contentBlocks(item.content))
        continue
      }
      flush()
      messages.push({ role, content: contentBlocks(item.content) })
    }
  flush()
  const out: Obj = {
    model: body.model ?? null,
    messages: mergeAnthropic(messages),
    stream: truthy(body.stream),
    max_tokens: fallback(get(body, 'max_output_tokens', body.max_tokens), 4096),
  }
  let instructions = ''
  if (Array.isArray(body.instructions))
    instructions = body.instructions
      .map((item) =>
        typeof item === 'string'
          ? item
          : isObject(item)
            ? responsesContent(item.content ?? item.text).text
            : '',
      )
      .join('')
  else instructions = text(body.instructions)
  if (instructions) systems.unshift(instructions)
  if (systems.length) out.system = systems.join('\n')
  for (const key of ['temperature', 'top_p'])
    if (body[key] != null) out[key] = body[key]
  if (userId(body)) out.metadata = { user_id: userId(body) }
  const tools: Obj[] = []
  for (const value of declaredTools(body)) {
    if (!isObject(value))
      throw new ProtocolBridgeError(
        'Responses 工具声明格式无效，无法转换为 Anthropic',
      )
    let tool: Obj = value
    if (tool.type != null && tool.type !== 'function')
      throw new ProtocolBridgeError(
        `Responses 内置工具 ${tool.type || 'unknown'} 无法转换为 Anthropic，请使用 Responses 原生上游`,
      )
    let name = tool.name
    if (!name) {
      const fn = object(tool.function)
      name = fn.name
      tool = { ...fn, ...tool }
    }
    if (!name)
      throw new ProtocolBridgeError(
        'Responses function 工具缺少名称，无法转换为 Anthropic',
      )
    tools.push({
      name,
      description: tool.description || '',
      input_schema: fallback(
        tool.parameters,
        fallback(tool.input_schema, schemaDefault()),
      ),
    })
  }
  if (tools.length) {
    out.tools = tools
    const choice = body.tool_choice
    if (choice === 'none' || choice === 'auto')
      out.tool_choice = { type: choice }
    else if (choice === 'required') out.tool_choice = { type: 'any' }
    else if (isObject(choice)) {
      const name = object(choice.function).name || choice.name
      if (name) out.tool_choice = { type: 'tool', name }
    }
  }
  return out
}
export function serverToolId(value: unknown): string {
  const raw = String(value || '').trim(),
    prefix = 'srvtoolu_'
  const cleaned = (
    raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
  ).replace(/[^a-zA-Z0-9_]/g, '_')
  return prefix + (cleaned || randomUUID().replaceAll('-', '').slice(0, 16))
}
function searchBlocks(item: Obj): Obj[] {
  const action = object(item.action),
    id = serverToolId(item.id)
  let queries = array(action.queries)
    .filter((q) => String(q || '').trim())
    .map((q) => String(q).trim())
  if (!queries.length && String(action.query || '').trim())
    queries = [String(action.query).trim()]
  const first: Obj = {
    type: 'server_tool_use',
    id,
    name: 'web_search',
    input: { query: queries[0] || '' },
  }
  const results = array(action.sources)
    .filter((s): s is Obj => isObject(s) && !!String(s.url || '').trim())
    .map((s) => {
      const url = String(s.url).trim()
      return {
        type: 'web_search_result',
        url,
        title: String(s.title || '').trim() || url,
      }
    })
  return [
    first,
    {
      type: 'web_search_tool_result',
      tool_use_id: id,
      content:
        item.status === 'failed'
          ? { type: 'web_search_tool_result_error', error_code: 'unavailable' }
          : results,
    },
  ]
}
export function responsesToAnthropicResponse(
  raw: unknown,
  clientModel?: string,
): Obj {
  const payload = object(raw),
    content: Obj[] = []
  let hasTool = false
  for (const item of array(payload.output)) {
    if (!isObject(item)) continue
    if (item.type === 'reasoning') {
      const t = responsesContent(fallback(item.summary, item.content)).text
      if (item.encrypted_content)
        content.push({
          type: 'thinking',
          thinking: t,
          signature: item.encrypted_content,
        })
      else if (t) content.push({ type: 'text', text: t })
    } else if (item.type === 'message') {
      const t = responsesContent(item.content).text
      if (t) content.push({ type: 'text', text: t })
    } else if (
      item.type === 'function_call' ||
      item.type === 'custom_tool_call'
    ) {
      hasTool = true
      content.push({
        type: 'tool_use',
        id: item.call_id || item.id || 'fc_coati',
        name: item.name || '',
        input: jsonObject(
          item.arguments,
          'Responses 工具调用参数不是有效 JSON，无法转换为 Anthropic tool_use',
        ),
      })
    } else if (item.type === 'web_search_call')
      content.push(...searchBlocks(item))
  }
  const usage = object(payload.usage),
    details = object(usage.input_tokens_details),
    read = Number(details.cached_tokens || usage.cache_read_input_tokens || 0),
    write = Number(
      usage.cache_creation_input_tokens || details.cache_write_tokens || 0,
    )
  const converted: Obj = {
    input_tokens: Math.max(0, Number(usage.input_tokens || 0) - read - write),
    output_tokens: Number(usage.output_tokens || 0),
  }
  if (read) converted.cache_read_input_tokens = read
  if (write) converted.cache_creation_input_tokens = write
  return {
    id: payload.id || 'msg_coati',
    type: 'message',
    role: 'assistant',
    model: clientModel || payload.model || '',
    content,
    stop_reason: hasTool
      ? 'tool_use'
      : payload.status === 'incomplete'
        ? 'max_tokens'
        : 'end_turn',
    usage: converted,
  }
}
