/** Python compatibility port. Pure converters; not wired into routes until the matrix is ready. */
import {
  type Obj,
  isObject,
  object,
  array,
  truthy,
  fallback,
  pythonJson,
  text,
  image,
} from './compat-helpers'
function convertMessage(msg: Obj): Obj[] {
  const { role, content } = msg
  if (typeof content === 'string') return [{ role: role ?? null, content }]
  if (!Array.isArray(content))
    return [{ role: role || 'user', content: text(content) }]
  const texts: string[] = [],
    thinking: string[] = [],
    images: Obj[] = [],
    calls: Obj[] = [],
    results: Obj[] = []
  for (const part of content) {
    if (!isObject(part)) continue
    if (part.type === 'text') texts.push(String(part.text || ''))
    else if (part.type === 'thinking')
      thinking.push(String(part.thinking || ''))
    else if (part.type === 'image') {
      const converted = image(part)
      if (converted) images.push(converted)
    } else if (part.type === 'tool_use')
      calls.push({
        id: part.id || '',
        type: 'function',
        function: {
          name: part.name || '',
          arguments:
            typeof part.input === 'string'
              ? part.input
              : pythonJson(fallback(part.input, {})),
        },
      })
    else if (part.type === 'tool_result')
      results.push({
        role: 'tool',
        tool_call_id: part.tool_use_id || '',
        content: text(part.content),
      })
  }
  if (
    results.length &&
    !texts.length &&
    !calls.length &&
    !images.length &&
    !thinking.length
  )
    return results
  let converted: Obj
  if (role === 'assistant') {
    converted = {
      role: 'assistant',
      content: texts.join('') || (calls.length ? '' : null),
    }
    if (thinking.length) converted.reasoning_content = thinking.join('')
    if (calls.length) converted.tool_calls = calls
  } else if (images.length) {
    converted = {
      role: role || 'user',
      content: [
        ...(texts.length ? [{ type: 'text', text: texts.join('') }] : []),
        ...images,
      ],
    }
  } else converted = { role: role || 'user', content: texts.join('') }
  return [...results, converted]
}
export function anthropicToChatRequest(raw: unknown): Obj {
  const body = object(raw),
    messages: Obj[] = []
  if (truthy(body.system))
    messages.push({ role: 'system', content: text(body.system) })
  for (const msg of array(body.messages))
    if (isObject(msg)) messages.push(...convertMessage(msg))
  const out: Obj = {
    model: body.model ?? null,
    messages,
    stream: truthy(body.stream),
  }
  for (const key of ['max_tokens', 'temperature', 'top_p'])
    if (body[key] != null) out[key] = body[key]
  if (truthy(body.stop_sequences)) out.stop = body.stop_sequences
  const user =
    String(body.user || '').trim() ||
    String(object(body.metadata).user_id || '').trim()
  if (user) out.user = user
  const tools = array(body.tools)
    .filter(
      (tool): tool is Obj =>
        isObject(tool) && tool.name != null && tool.name !== '',
    )
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: fallback(tool.input_schema, {
          type: 'object',
          properties: {},
        }),
      },
    }))
  if (tools.length) {
    out.tools = tools
    const choice = object(body.tool_choice)
    if (choice.type === 'none' || choice.type === 'auto')
      out.tool_choice = choice.type
    else if (choice.type === 'any') out.tool_choice = 'required'
    else if (choice.type === 'tool' && choice.name)
      out.tool_choice = { type: 'function', function: { name: choice.name } }
  }
  return out
}
export function anthropicToChatResponse(
  raw: unknown,
  clientModel?: string,
): Obj {
  const payload = object(raw),
    texts: string[] = [],
    reasoning: string[] = [],
    calls: Obj[] = []
  for (const block of array(payload.content)) {
    if (!isObject(block)) continue
    if (block.type === 'text') texts.push(String(block.text || ''))
    else if (block.type === 'thinking')
      reasoning.push(String(block.thinking || ''))
    else if (block.type === 'tool_use')
      calls.push({
        id: block.id || '',
        type: 'function',
        function: {
          name: block.name || '',
          arguments: pythonJson(fallback(block.input, {})),
        },
      })
  }
  const message: Obj = {
    role: 'assistant',
    content: texts.join('') || (calls.length ? '' : null),
  }
  if (reasoning.length) message.reasoning_content = reasoning.join('')
  if (calls.length) message.tool_calls = calls
  const usage = object(payload.usage),
    read = Number(usage.cache_read_input_tokens || 0),
    write = Number(usage.cache_creation_input_tokens || 0)
  const resultUsage: Obj = {
    prompt_tokens: Number(usage.input_tokens || 0) + read + write,
    completion_tokens: Number(usage.output_tokens || 0),
  }
  if (read) resultUsage.prompt_tokens_details = { cached_tokens: read }
  if (write) resultUsage.cache_creation_input_tokens = write
  const reasons: Record<string, string> = {
    end_turn: 'stop',
    stop_sequence: 'stop',
    tool_use: 'tool_calls',
    max_tokens: 'length',
  }
  return {
    id: payload.id || 'chatcmpl_coati',
    object: 'chat.completion',
    model: clientModel || payload.model || '',
    choices: [
      {
        index: 0,
        message,
        finish_reason: reasons[String(payload.stop_reason)] || 'stop',
      },
    ],
    usage: resultUsage,
  }
}
