import {
  type Obj,
  object,
  isObject,
  array,
  truthy,
  fallback,
  text,
  pythonJson,
  userId,
  schemaDefault,
  get,
  checkCandidates,
  ProtocolBridgeError,
} from './compat-helpers'
import {
  inputTextType,
  responseEnvelope,
  outputText,
} from './responses-helpers'
export function chatToResponsesRequest(raw: unknown): Obj {
  const body = object(raw),
    incoming: Obj[] = [],
    instructions: string[] = []
  checkCandidates(body, 'responses')
  for (const msg of array(body.messages)) {
    if (!isObject(msg)) continue
    const role = msg.role || 'user'
    if (role === 'system' || role === 'developer') {
      instructions.push(text(msg.content))
      continue
    }
    if (role === 'tool') {
      incoming.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || '',
        output: msg.content || '',
      })
      continue
    }
    const content: Obj[] = []
    if (typeof msg.content === 'string')
      content.push({ type: inputTextType(role), text: msg.content })
    else
      for (const part of array(msg.content)) {
        if (typeof part === 'string')
          content.push({ type: 'input_text', text: part })
        else if (isObject(part)) {
          if (part.type === 'image_url')
            content.push({
              type: 'input_image',
              ...(object(part.image_url).detail != null ? { detail: object(part.image_url).detail } : {}),
              image_url: isObject(part.image_url)
                ? (part.image_url.url ?? null)
                : (part.image_url ?? null),
            })
          else if (
            ['text', 'input_text', 'output_text'].includes(String(part.type))
          )
            content.push({ type: inputTextType(role), text: part.text || '' })
        }
      }
    if (role === 'assistant' && truthy(msg.reasoning_content))
      incoming.push({
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: msg.reasoning_content }],
      })
    if (content.length) incoming.push({ type: 'message', role, content })
    if (role === 'assistant')
      for (const call of array(msg.tool_calls)) {
        if (!isObject(call)) continue
        const fn = object(call.function),
          args = fallback(fn.arguments, '{}')
        incoming.push({
          type: 'function_call',
          call_id: call.id || '',
          name: fn.name || '',
          arguments: typeof args === 'string' ? args : pythonJson(args),
        })
      }
  }
  const out: Obj = {
    model: body.model ?? null,
    input: incoming,
    stream: truthy(body.stream),
  }
  if (instructions.length)
    out.instructions = instructions.filter(Boolean).join('\n')
  if (userId(body)) out.user = userId(body)
  if (isObject(body.metadata) && truthy(body.metadata))
    out.metadata = body.metadata
  const limit = get(
    body,
    'max_output_tokens',
    get(body, 'max_completion_tokens', body.max_tokens),
  )
  if (limit != null) out.max_output_tokens = limit
  for (const key of ['temperature', 'top_p', 'parallel_tool_calls'])
    if (body[key] != null) out[key] = body[key]
  const tools: Obj[] = []
  for (const tool of array(body.tools)) {
    if (!isObject(tool)) continue
    const fn = isObject(tool.function) ? tool.function : tool
    if (truthy(fn.name))
      tools.push({
        type: 'function',
        name: fn.name,
        description: fn.description || '',
        parameters: fallback(fn.parameters, schemaDefault()),
      })
  }
  if (isObject(body.web_search_options)) {
    const search = body.web_search_options,
      native: Obj = { type: 'web_search' }
    if (search.search_context_size)
      native.search_context_size = search.search_context_size
    if (isObject(search.user_location)) {
      const location = search.user_location,
        picked = isObject(location.approximate)
          ? location.approximate
          : location
      const trimmed = Object.fromEntries(
        ['city', 'region', 'country', 'timezone']
          .filter((key) => String(picked[key] || '').trim())
          .map((key) => [key, picked[key]]),
      )
      if (truthy(trimmed)) native.user_location = trimmed
    }
    tools.push(native)
  }
  if (tools.length) out.tools = tools
  const format = object(body.response_format)
  if (format.type === 'json_schema') {
    const schema = object(format.json_schema)
    out.text = {
      format: {
        type: 'json_schema',
        name: schema.name || 'response_schema',
        description: schema.description ?? null,
        schema: fallback(schema.schema, {}),
        strict: get(schema, 'strict', true),
      },
    }
  } else if (format.type) out.text = { format: { type: format.type } }
  if (tools.length && body.tool_choice != null) {
    const choice = body.tool_choice
    if (typeof choice === 'string') out.tool_choice = choice
    else if (isObject(choice)) {
      const fn = isObject(choice.function) ? choice.function : choice
      if (['function', 'tool'].includes(String(choice.type)) && fn.name)
        out.tool_choice = { type: 'function', name: fn.name }
    }
  }
  return out
}
export function chatToResponsesResponse(
  raw: unknown,
  clientModel?: string,
): Obj {
  const payload = object(raw),
    choices = array(fallback(payload.choices, [{}])).filter(isObject)
  if (!choices.length) choices.push({})
  if (choices.length !== 1)
    throw new ProtocolBridgeError(
      'Responses 不支持 OpenAI Chat 的多候选响应，请将 n 设置为 1',
    )
  const id = payload.id || 'resp_coati',
    choice = choices[0]!,
    message = object(choice.message),
    output: Obj[] = []
  if (truthy(message.reasoning_content))
    output.push({
      id: `rs_${id}_0`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: message.reasoning_content }],
    })
  if (truthy(message.content))
    output.push({
      id: `msg_${id}_0`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [outputText(message.content)],
    })
  for (const [index, call] of array(message.tool_calls).entries()) {
    if (!isObject(call)) continue
    const fn = object(call.function),
      callId = call.id || `fc_0_${index}`
    output.push({
      id: callId,
      type: 'function_call',
      call_id: callId,
      name: fn.name || '',
      arguments: fallback(fn.arguments, '{}'),
    })
  }
  return responseEnvelope(
    id,
    clientModel || payload.model || '',
    output,
    object(payload.usage),
    choice.finish_reason === 'length',
  )
}
