import { array, object, type Obj } from './protocol/compat-helpers'

const leads = ['perform a web search for the query:', 'perform a web search for:']

/** Match the legacy dedicated search prompt; ordinary questions still need the model. */
export function searchOnlyQuery(body: Obj): string | undefined {
  if (['0', 'false', 'no', 'off'].includes((process.env.AGENT_WEB_SEARCH_SHORTCUT_ENABLED ?? 'true').trim().toLowerCase())) return
  const tools = array(body.tools).map(object)
  if (tools.length !== 1 || !String(tools[0]!.type).startsWith('web_search')) return
  const messages = array(body.messages).map(object)
  if (messages.length !== 1 || messages[0]!.role !== 'user') return
  const content = messages[0]!.content
  if (Array.isArray(content) && content.some(part => ['tool_result', 'image'].includes(String(object(part).type)))) return
  const text = (typeof content === 'string' ? content : array(content).map(object).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('\n')).trim()
  const lead = leads.find(value => text.toLowerCase().startsWith(value))
  const query = lead ? text.slice(lead.length).trim() : ''
  return query && Array.from(query).length <= 400 ? query : undefined
}

export function searchResultBlocks(id: string, query: string, sources: Obj[]): Obj[] {
  const lines = [`Search results for "${query}":`]
  sources.forEach((source, index) => {
    lines.push(`[${index + 1}] ${source.title || source.url}`, `URL: ${source.url}`)
    const age = source.page_age || source.publishedAt
    if (age) lines.push(`Updated: ${age}`)
    if (source.content || source.snippet) lines.push(String(source.content || source.snippet))
    lines.push('')
  })
  return [
    {type:'server_tool_use',id,name:'web_search',input:{query}},
    {type:'web_search_tool_result',tool_use_id:id,content:sources.map(source => ({
      ...source,type:'web_search_result',encrypted_content:'coati1:' + Buffer.from(JSON.stringify({
        url:source.url,title:source.title,content:source.content || source.snippet,
      })).toString('base64').replace(/\+/g,'-').replace(/\//g,'_'),
    }))},
    {type:'text',text:lines.join('\n').trim()},
  ]
}
