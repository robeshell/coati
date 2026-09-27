import type { Protocol } from '../schema'
import { array, object, type Obj, ProtocolBridgeError } from './compat-helpers'

/** Protect semantic output blocks. Provider envelope/usage metadata is handled separately. */
export function assertResponseContent(raw: unknown, source: Protocol, target: Protocol) {
  if (source === target) return
  const body = object(raw)
  const fail = () => { throw new ProtocolBridgeError('上游返回了当前协议转换无法保留的内容或引用，请使用相同协议的上游路由') }
  const annotations = (block: Obj) => {
    if (array(block.annotations).length || array(block.citations).length) fail()
  }
  const content = (raw: unknown, allowed: string[]) => {
    for (const value of array(raw)) {
      if (typeof value === 'string') continue
      const block = object(value)
      if (!allowed.includes(String(block.type))) fail()
      annotations(block)
    }
  }
  if (source === 'openai') {
    for (const choice of array(body.choices)) {
      const value = object(choice), message = object(value.message ?? value.delta)
      annotations(message)
      for (const field of Object.keys(message))
        if (!['role','content','reasoning_content','tool_calls','refusal'].includes(field) && message[field] != null) fail()
      if (Array.isArray(message.content)) content(message.content, ['text'])
      if (message.refusal && target === 'anthropic') fail()
      if (value.logprobs != null) fail()
    }
  } else if (source === 'anthropic') {
    const allowed = ['text','thinking','tool_use','redacted_thinking']
    content(body.content, allowed)
    content(object(body.message).content, allowed)
    if (body.content_block) content([body.content_block], allowed)
    const delta = object(body.delta)
    annotations(delta)
    if (delta.type && !['text_delta','thinking_delta','signature_delta','input_json_delta'].includes(String(delta.type))) fail()
  } else {
    if (body.type && !['response','error','response.created','response.in_progress','response.queued','response.output_item.added','response.output_item.done','response.content_part.added','response.content_part.done','response.output_text.delta','response.output_text.done','response.refusal.delta','response.refusal.done','response.function_call_arguments.delta','response.function_call_arguments.done','response.reasoning_summary_part.added','response.reasoning_summary_part.done','response.reasoning_summary_text.delta','response.reasoning_summary_text.done','response.reasoning_text.delta','response.reasoning_text.done','response.completed','response.incomplete','response.failed','response.done'].includes(String(body.type))) fail()
    const item = (value: unknown) => {
      const block = object(value)
      if (!['message','reasoning','function_call'].includes(String(block.type))) fail()
      annotations(block)
      if (block.type === 'message') content(block.content, ['output_text','text','refusal'])
    }
    for (const value of array(body.output)) item(value)
    for (const value of array(object(body.response).output)) item(value)
    if (body.item) item(body.item)
    if (body.part) content([body.part], ['output_text','text','refusal','summary_text','reasoning_text'])
    if (String(body.type).includes('annotation') || String(body.type).includes('citation')) fail()
  }
}
