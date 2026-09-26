import {
  type Obj,
  object,
  isObject,
  array,
  truthy,
  fallback,
  text,
  pythonJson,
  image,
  userId,
  get,
  schemaDefault,
} from './compat-helpers'
import {
  inputTextType,
  responseEnvelope,
  outputText,
} from './responses-helpers'
export function anthropicToResponsesRequest(raw: unknown): Obj {
  const body = object(raw),
    input: Obj[] = []
  for (const msg of array(body.messages)) {
    if (!isObject(msg)) continue
    const role = msg.role || 'user',
      outRole = role === 'system' ? 'developer' : role
    if (typeof msg.content === 'string') {
      input.push({
        type: 'message',
        role: outRole,
        content: [{ type: inputTextType(role), text: msg.content }],
      })
      continue
    }
    for (const part of array(msg.content)) {
      if (!isObject(part)) continue
      if (part.type === 'thinking')
        input.push({
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: part.thinking || '' }],
          ...(part.signature ? { encrypted_content: part.signature } : {}),
        })
      else if (part.type === 'text')
        input.push({
          type: 'message',
          role: outRole,
          content: [{ type: inputTextType(role), text: part.text || '' }],
        })
      else if (part.type === 'image') {
        const converted = image(part)
        if (converted)
          input.push({
            type: 'message',
            role: outRole,
            content: [
              {
                type: 'input_image',
                image_url: object(converted.image_url).url,
              },
            ],
          })
      } else if (part.type === 'tool_use')
        input.push({
          type: 'function_call',
          call_id: part.id || '',
          name: part.name || '',
          arguments: pythonJson(fallback(part.input, {})),
        })
      else if (part.type === 'tool_result')
        input.push({
          type: 'function_call_output',
          call_id: part.tool_use_id || '',
          output:
            typeof part.content === 'string'
              ? part.content
              : text(part.content),
        })
    }
  }
  const out: Obj = {
    model: body.model ?? null,
    input,
    stream: truthy(body.stream),
    max_output_tokens: fallback(
      get(body, 'max_tokens', body.max_output_tokens),
      4096,
    ),
  }
  if (truthy(body.system)) out.instructions = text(body.system)
  if (userId(body)) out.user = userId(body)
  for (const key of ['temperature', 'top_p'])
    if (body[key] != null) out[key] = body[key]
  const tools = array(body.tools)
    .filter((tool): tool is Obj => isObject(tool) && truthy(tool.name))
    .map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      parameters: fallback(tool.input_schema, schemaDefault()),
    }))
  if (tools.length) {
    out.tools = tools
    const choice = object(body.tool_choice),
      kind = choice.type
    if (kind === 'none' || kind === 'auto' || kind === 'any')
      out.tool_choice = kind === 'any' ? 'required' : kind
    else if (kind === 'tool' && choice.name)
      out.tool_choice = { type: 'function', name: choice.name }
  }
  if (['enabled', 'adaptive'].includes(String(object(body.thinking).type)))
    out.reasoning = { effort: 'medium' }
  return out
}
export function anthropicToResponsesResponse(
  raw: unknown,
  clientModel?: string,
): Obj {
  const payload = object(raw),
    output: Obj[] = []
  for (const block of array(payload.content)) {
    if (!isObject(block)) continue
    if (block.type === 'thinking') {
      const item: Obj = {
        id: block.id || 'rs_coati',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: block.thinking || '' }],
      }
      if (block.signature) item.encrypted_content = block.signature
      output.push(item)
    } else if (block.type === 'text')
      output.push({
        id: 'msg_coati',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [outputText(block.text || '')],
      })
    else if (block.type === 'tool_use') {
      const id = block.id || 'fc_coati'
      output.push({
        id,
        type: 'function_call',
        call_id: id,
        name: block.name || '',
        arguments: pythonJson(fallback(block.input, {})),
      })
    }
  }
  const usage = object(payload.usage),
    read = Number(usage.cache_read_input_tokens || 0),
    write = Number(usage.cache_creation_input_tokens || 0),
    input = Number(usage.input_tokens || 0) + read + write,
    out = Number(usage.output_tokens || 0)
  return responseEnvelope(
    payload.id || 'resp_coati',
    clientModel || payload.model || '',
    output,
    {
      input_tokens: input,
      output_tokens: out,
      input_tokens_details: { cache_write_tokens: write, cached_tokens: read },
      output_tokens_details: {
        reasoning_tokens: Number(usage.reasoning_tokens || 0),
      },
      total_tokens: input + out,
    },
    payload.stop_reason === 'max_tokens',
  )
}
