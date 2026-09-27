import { array, object, isObject, type Obj } from './protocol/compat-helpers'

const toolPrefixes = [
  'web_search_',
  'web_fetch_',
  'code_execution_',
  'bash_code_execution_',
  'text_editor_code_execution_',
  'tool_search_tool_',
]
const text = (v: unknown) => String(v || '').trim()
function decodedContent(value: unknown): Obj {
  if (typeof value !== 'string' || !value.startsWith('coati1:') || value.length > 1024 * 1024) return {}
  try {
    return object(
      JSON.parse(Buffer.from(value.slice(7), 'base64url').toString('utf8')),
    )
  } catch {
    return {}
  }
}
function historyResult(block: Obj): string {
  const raw = block.content
  if (block.type === 'web_fetch_tool_result') {
    if (!isObject(raw)) return 'Web fetch failed: unavailable.'
    if (raw.type === 'web_fetch_tool_result_error')
      return `Web fetch failed: ${raw.error_code || 'unavailable'}.`
    const document = object(raw.content),
      source = object(document.source)
    const title = text(document.title)
    return `Fetched ${raw.url || ''}${title ? ' — ' + title : ''}\n\n${text(source.data) || '(empty page)'}`
  }
  if (isObject(raw))
    return `Web search failed: ${raw.error_code || 'unavailable'}.`
  const sources = array(raw).filter(isObject)
  if (!sources.length)
    return 'Search results for "previous turn": no results found.'
  const lines = ['Search results for "previous turn":']
  sources.forEach((source, index) => {
    const decoded = decodedContent(source.encrypted_content)
    const url = text(source.url || decoded.url),
      title = text(source.title || decoded.title) || url
    lines.push(`[${index + 1}] ${title}`)
    if (url) lines.push(`URL: ${url}`)
    const age = text(source.page_age || decoded.page_age)
    if (age) lines.push(`Updated: ${age}`)
    const content = text(decoded.content)
    if (content) lines.push(content)
    lines.push('')
  })
  return lines.join('\n').trim()
}

/** Shared by request execution and count_tokens so replay bodies cannot drift. */
export function normalizeServerToolHistory(body: Obj): Obj {
  if (!Array.isArray(body.messages)) return body
  let messages = body.messages
  if (Array.isArray(messages))
    messages = messages.map((raw) => {
      const message = object(raw)
      if (!Array.isArray(message.content)) return raw
      return {
        ...message,
        content: message.content.map((raw) => {
          const part = object(raw)
          if (
            part.type === 'server_tool_use' &&
            ['web_search', 'web_fetch'].includes(String(part.name))
          ) {
            const input = object(part.input)
            return {
              type: 'text',
              text: (part.name === 'web_fetch'
                ? `Fetched the page: ${input.url || ''}`
                : `Searched the web for: ${input.query || ''}`
              ).trim(),
            }
          }
          if (
            part.type === 'web_search_tool_result' ||
            part.type === 'web_fetch_tool_result'
          )
            return { type: 'text', text: historyResult(part) }
          return raw
        }),
      }
    })
  return { ...body, messages }
}

/** Same local estimate shape as the Python count_tokens endpoint; never bills or calls a supplier. */
export function estimateMessageTokens(body: Obj): number {
  const estimate: Obj = { messages: normalizeServerToolHistory(body).messages ?? null }
  const tools = Array.isArray(body.tools)
    ? body.tools.filter(
        (raw) =>
          !toolPrefixes.some((prefix) =>
            String(object(raw).type || '').startsWith(prefix),
          ),
      )
    : body.tools
  if (tools && (!Array.isArray(tools) || tools.length)) estimate.tools = tools
  for (const key of ['system', 'tool_choice'])
    if (body[key] != null) estimate[key] = body[key]
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(estimate)) / 4))
}

/** Python reservation estimate includes only the payload fields it budgets. */
export function estimateReservationTokens(body: Obj): number {
  const value: Obj = { messages: body.messages ?? null, tools: body.tools ?? null, response_format: body.response_format ?? null }
  for (const field of ['input', 'instructions', 'system']) if (body[field] != null) value[field] = body[field]
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4))
}
