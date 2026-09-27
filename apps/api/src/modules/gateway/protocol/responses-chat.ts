import {
  type Obj,
  object,
  isObject,
  array,
  truthy,
  text,
  userId,
  schemaDefault,
  fallback,
  get,
  ProtocolBridgeError,
} from './compat-helpers'
import {
  responsesContent,
  declaredTools,
  toolArguments,
} from './responses-helpers'
export function responsesToChatRequest(raw: unknown): Obj {
  const body = object(raw),
    messages: Obj[] = [],
    calls: Obj[] = [],
    reasoning: string[] = []
  if (truthy(body.instructions))
    messages.push({ role: 'system', content: text(body.instructions) })
  const flush = (standalone = false) => {
    if (!calls.length && !(standalone && reasoning.length)) return
    const item: Obj = {
      role: 'assistant',
      content: '',
      ...(calls.length ? { tool_calls: calls.splice(0) } : {}),
    }
    if (reasoning.length) item.reasoning_content = reasoning.splice(0).join('')
    messages.push(item)
  }
  if (typeof body.input === 'string')
    messages.push({ role: 'user', content: body.input })
  else
    for (const item of array(body.input)) {
      if (typeof item === 'string') {
        flush(true)
        messages.push({ role: 'user', content: item })
        continue
      }
      if (!isObject(item)) continue
      if (item.type === 'reasoning') {
        const value = responsesContent(
          fallback(item.summary, item.content),
        ).text
        if (value) reasoning.push(value)
        continue
      }
      if (item.type === 'function_call') {
        calls.push({
          id: item.call_id || item.id || '',
          type: 'function',
          function: {
            name: item.name || '',
            arguments: toolArguments(item.arguments),
          },
        })
        continue
      }
      if (item.type === 'function_call_output') {
        flush(true)
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || '',
          content:
            typeof item.output === 'string' ? item.output : text(item.output),
        })
        continue
      }
      flush(item.role !== 'assistant')
      const role = item.role || 'user',
        parts = responsesContent(item.content)
      const converted: Obj = {
        role,
        content: parts.images.length
          ? [
              ...(parts.text ? [{ type: 'text', text: parts.text }] : []),
              ...parts.images,
            ]
          : parts.text,
      }
      if (role === 'assistant' && reasoning.length)
        converted.reasoning_content = reasoning.splice(0).join('')
      messages.push(converted)
    }
  flush()
  if (reasoning.length && messages.at(-1)?.role === 'assistant')
    messages.at(-1)!.reasoning_content = reasoning.splice(0).join('')
  flush(true)
  const out: Obj = {
    model: body.model ?? null,
    messages,
    stream: truthy(body.stream),
  }
  const limit = get(body, 'max_output_tokens', body.max_tokens)
  if (limit != null) out.max_tokens = limit
  for (const key of ['temperature', 'top_p'])
    if (body[key] != null) out[key] = body[key]
  if (userId(body)) out.user = userId(body)
  if (isObject(body.metadata) && truthy(body.metadata))
    out.metadata = body.metadata
  const format = object(object(body.text).format)
  if (format.type === 'json_schema') {
    const schema: Obj = {}
    for (const key of ['name', 'description', 'schema', 'strict'])
      if (Object.hasOwn(format, key)) schema[key] = format[key]
    out.response_format = { type: 'json_schema', json_schema: schema }
  } else if (format.type === 'json_object' || format.type === 'text') {
    out.response_format = { type: format.type }
  } else if (format.type)
    throw new ProtocolBridgeError('不支持的结构化输出格式')
  const tools: Obj[] = []
  for (const tool of declaredTools(body)) {
    if (!isObject(tool))
      throw new ProtocolBridgeError(
        'Responses 工具声明格式无效，无法转换为 Chat Completions',
      )
    if (tool.type != null && tool.type !== 'function')
      throw new ProtocolBridgeError(
        `Responses 内置工具 ${tool.type || 'unknown'} 无法转换为 Chat Completions，请使用 Responses 原生上游`,
      )
    const fn = isObject(tool.function) ? tool.function : tool
    if (!truthy(fn.name))
      throw new ProtocolBridgeError(
        'Responses function 工具缺少名称，无法转换为 Chat Completions',
      )
    tools.push({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description || '',
        parameters: fallback(fn.parameters, schemaDefault()),
      },
    })
  }
  if (tools.length) {
    out.tools = tools
    const choice = body.tool_choice
    if (choice === 'none' || choice === 'auto' || choice === 'required')
      out.tool_choice = choice
    else if (isObject(choice)) {
      const name = object(choice.function).name || choice.name
      if (['function', 'tool'].includes(String(choice.type)) && name)
        out.tool_choice = { type: 'function', function: { name } }
    }
  }
  return out
}
export function responsesToChatResponse(
  raw: unknown,
  clientModel?: string,
): Obj {
  const payload = object(raw),
    texts: string[] = [],
    reasoning: string[] = [],
    calls: Obj[] = []
  for (const item of array(payload.output)) {
    if (!isObject(item)) continue
    if (item.type === 'reasoning') {
      const t = responsesContent(fallback(item.summary, item.content)).text
      if (t) reasoning.push(t)
    } else if (item.type === 'message') {
      const t = responsesContent(item.content).text
      if (t) texts.push(t)
    } else if (item.type === 'function_call')
      calls.push({
        id: item.call_id || item.id || '',
        type: 'function',
        function: {
          name: item.name || '',
          arguments: toolArguments(item.arguments),
        },
      })
  }
  const message: Obj = {
    role: 'assistant',
    content: texts.join('') || (calls.length ? '' : null),
  }
  if (reasoning.length) message.reasoning_content = reasoning.join('')
  if (calls.length) message.tool_calls = calls
  const usage = object(payload.usage)
  return {
    id: payload.id || 'chatcmpl_coati',
    object: 'chat.completion',
    model: clientModel || payload.model || '',
    choices: [
      {
        index: 0,
        message,
        finish_reason: calls.length
          ? 'tool_calls'
          : payload.status === 'incomplete'
            ? 'length'
            : 'stop',
      },
    ],
    usage: {
      prompt_tokens: Number(usage.input_tokens || usage.prompt_tokens || 0),
      completion_tokens: Number(
        usage.output_tokens || usage.completion_tokens || 0,
      ),
    },
  }
}
