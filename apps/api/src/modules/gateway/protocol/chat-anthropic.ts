import {
  type Obj,
  isObject,
  object,
  array,
  truthy,
  fallback,
  text,
  userId,
  schemaDefault,
  get,
  jsonObject,
  checkCandidates,
  mergeAnthropic,
  ProtocolBridgeError,
} from './compat-helpers'
export function chatImage(part: Obj): Obj | undefined {
  const raw = isObject(part.image_url) ? part.image_url.url : part.image_url
  if (!truthy(raw)) return
  const image = String(raw)
  if (image.startsWith('data:') && image.includes(';base64,')) {
    const at = image.indexOf(';base64,')
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.slice(5, at) || 'image/png',
        data: image.slice(at + 8),
      },
    }
  }
  return { type: 'image', source: { type: 'url', url: image } }
}
export function chatContent(content: unknown): Obj[] {
  if (typeof content === 'string')
    return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return [{ type: 'text', text: text(content) }]
  const blocks: Obj[] = []
  for (const part of content) {
    if (typeof part === 'string') blocks.push({ type: 'text', text: part })
    else if (isObject(part)) {
      if (['text', 'input_text', 'output_text'].includes(String(part.type)))
        blocks.push({ type: 'text', text: part.text || '' })
      else if (
        ['image_url', 'input_image', 'image'].includes(String(part.type))
      ) {
        const converted = chatImage(part)
        if (converted) blocks.push(converted)
      }
    }
  }
  return blocks
}
export function chatToAnthropicRequest(raw: unknown): Obj {
  const body = object(raw)
  checkCandidates(body, 'anthropic')
  const system: Obj[] = [],
    messages: Obj[] = []
  for (const msg of array(body.messages)) {
    if (!isObject(msg)) continue
    if (['system', 'developer'].includes(String(msg.role || '').trim())) {
      system.push(...chatContent(msg.content))
      continue
    }
    const role = msg.role || 'user'
    if (role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || '',
            content: msg.content || '',
          },
        ],
      })
      continue
    }
    const content = chatContent(msg.content)
    if (role === 'assistant') {
      if (truthy(msg.reasoning_content))
        content.unshift({ type: 'text', text: String(msg.reasoning_content) })
      for (const call of array(msg.tool_calls)) {
        if (!isObject(call)) continue
        const fn = object(call.function)
        content.push({
          type: 'tool_use',
          id: call.id || '',
          name: fn.name || '',
          input: jsonObject(
            fn.arguments,
            'OpenAI 工具调用参数不是有效 JSON，无法转换为 Anthropic tool_use',
          ),
        })
      }
    }
    if (content.length) messages.push({ role, content })
  }
  if (isObject(body.web_search_options))
    throw new ProtocolBridgeError(
      'Anthropic Messages 不支持 Chat 的 web_search_options，请路由到 OpenAI 兼容账号，或改用 Anthropic 的 web_search server tool',
    )
  const format = object(body.response_format)
  if (format.type != null && format.type !== '' && format.type !== 'text')
    throw new ProtocolBridgeError(
      `Anthropic Messages 不支持 response_format=${format.type}，请路由到 OpenAI 兼容账号`,
    )
  const out: Obj = {
    model: body.model ?? null,
    messages: mergeAnthropic(messages),
    stream: truthy(body.stream),
    max_tokens: fallback(
      get(body, 'max_tokens', body.max_completion_tokens),
      4096,
    ),
  }
  if (system.length) out.system = system
  if (userId(body)) out.metadata = { user_id: userId(body) }
  for (const key of ['temperature', 'top_p'])
    if (body[key] != null) out[key] = body[key]
  if (truthy(body.stop))
    out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  const tools: Obj[] = []
  for (const tool of array(body.tools)) {
    if (!isObject(tool)) continue
    const fn = isObject(tool.function) ? tool.function : tool
    if (truthy(fn.name))
      tools.push({
        name: fn.name,
        description: fn.description || '',
        input_schema: fallback(fn.parameters, schemaDefault()),
      })
  }
  if (tools.length) {
    out.tools = tools
    const choice = body.tool_choice
    if (choice === 'none' || choice === 'auto')
      out.tool_choice = { type: choice }
    else if (choice === 'required' || choice === 'any')
      out.tool_choice = { type: 'any' }
    else if (isObject(choice)) {
      const fn = isObject(choice.function) ? choice.function : choice
      if (fn.name) out.tool_choice = { type: 'tool', name: fn.name }
    }
  }
  return out
}
export function chatToAnthropicResponse(
  raw: unknown,
  clientModel?: string,
): Obj {
  const payload = object(raw),
    choices = array(fallback(payload.choices, [{}])).filter(isObject)
  if (!choices.length) choices.push({})
  if (choices.length !== 1)
    throw new ProtocolBridgeError(
      'Anthropic Messages 不支持 OpenAI 的多候选响应，请将 n 设置为 1',
    )
  const choice = choices[0]!,
    message = object(choice.message),
    content: Obj[] = []
  if (truthy(message.reasoning_content))
    content.push({ type: 'text', text: String(message.reasoning_content) })
  if (truthy(message.content))
    content.push({ type: 'text', text: message.content })
  for (const call of array(message.tool_calls)) {
    if (!isObject(call)) continue
    const fn = object(call.function),
      rawArgs = fallback(fn.arguments, '{}')
    let args: unknown
    try {
      args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
    } catch {
      throw new ProtocolBridgeError(
        '上游工具调用参数不是有效 JSON，无法转换为 Anthropic tool_use',
      )
    }
    if (!isObject(args))
      throw new ProtocolBridgeError(
        '上游工具调用参数必须是 JSON 对象，无法转换为 Anthropic tool_use',
      )
    content.push({
      type: 'tool_use',
      id: call.id || '',
      name: fn.name || '',
      input: args,
    })
  }
  const reasons: Record<string, string> = {
      stop: 'end_turn',
      tool_calls: 'tool_use',
      length: 'max_tokens',
    },
    usage = object(payload.usage)
  return {
    id: payload.id || 'msg_coati',
    type: 'message',
    role: 'assistant',
    model: clientModel || payload.model || '',
    content,
    stop_reason: reasons[String(choice.finish_reason)] || 'end_turn',
    usage: {
      input_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
      output_tokens: Number(
        usage.completion_tokens || usage.output_tokens || 0,
      ),
    },
  }
}
