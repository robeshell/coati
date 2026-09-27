import {
  type Obj,
  object,
  isObject,
  array,
  fallback,
  truthy,
  text,
  pythonJson,
} from './compat-helpers'
export const inputTextType = (role: unknown) =>
  role === 'assistant' ? 'output_text' : 'input_text'
export function responsesContent(content: unknown): {
  text: string
  images: Obj[]
} {
  if (!Array.isArray(content)) return { text: text(content), images: [] }
  const texts: string[] = [],
    images: Obj[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      texts.push(item)
      continue
    }
    if (!isObject(item)) continue
    if (
      ['input_text', 'output_text', 'text', 'summary_text'].includes(
        String(item.type),
      )
    )
      texts.push(String(item.text || ''))
    else if (item.type === 'refusal')
      texts.push(String(item.refusal || item.text || ''))
    else if (
      ['input_image', 'image_url', 'image'].includes(String(item.type))
    ) {
      let image = item.image_url || item.url
      if (isObject(image)) image = image.url
      const source = object(item.source)
      if (!truthy(image)) {
        if (source.type === 'url') image = source.url
        else if (source.type === 'base64' && source.data)
          image = `data:${source.media_type || 'image/png'};base64,${source.data}`
      }
      if (truthy(image))
        images.push({ type: 'image_url', image_url: { url: image, ...(item.detail != null ? { detail: item.detail } : {}) } })
    }
  }
  return { text: texts.join(''), images }
}
export const toolArguments = (value: unknown): string =>
  typeof value === 'string' ? value : pythonJson(fallback(value, {}))
export function declaredTools(body: Obj): unknown[] {
  const tools = [...array(body.tools)]
  for (const item of array(body.input))
    if (isObject(item) && item.type === 'additional_tools')
      tools.push(...array(item.tools))
  return tools
}
export function responsesUsage(raw: unknown): Obj {
  const usage = object(raw),
    input = Number(usage.input_tokens || usage.prompt_tokens || 0),
    output = Number(usage.output_tokens || usage.completion_tokens || 0)
  const details = object(usage.input_tokens_details),
    outputDetails = object(usage.output_tokens_details)
  return {
    input_tokens: input,
    input_tokens_details: isObject(usage.input_tokens_details)
      ? {
          cache_write_tokens: Number(
            details.cache_write_tokens ||
              details.cache_creation_input_tokens ||
              0,
          ),
          cached_tokens: Number(details.cached_tokens || 0),
        }
      : {
          cache_write_tokens: Number(usage.cache_creation_input_tokens || 0),
          cached_tokens: Number(usage.cache_read_input_tokens || 0),
        },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: Number(
        isObject(usage.output_tokens_details)
          ? outputDetails.reasoning_tokens || 0
          : usage.reasoning_tokens || 0,
      ),
    },
    total_tokens: Number(usage.total_tokens || input + output),
  }
}
export function responseEnvelope(
  id: unknown,
  model: unknown,
  output: Obj[],
  usage: unknown,
  incomplete: boolean,
  now = Date.now(),
): Obj {
  return {
    id: id || 'resp_coati',
    object: 'response',
    created_at: Math.floor(now / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    error: null,
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    instructions: null,
    model: model || '',
    output,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: usage == null ? null : responsesUsage(usage),
  }
}
export const outputText = (value: unknown): Obj => ({
  type: 'output_text',
  text: typeof value === 'string' ? value : text(value),
  annotations: [],
})
