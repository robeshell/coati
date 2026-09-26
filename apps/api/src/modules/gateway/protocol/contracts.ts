/** Draft v1 bridge contract. Not connected to production routes yet. */
import type { Protocol } from '../schema'
export type { Protocol }
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json }
export type Extension = { protocol: Protocol; path: string; value: Json }
export type Content =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { url: string } | { data: string; mimeType: string }
    }
  | { type: 'reasoning'; text?: string; opaque?: Extension }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | {
      type: 'tool_result'
      callId: string
      content: Content[]
      isError: boolean
    }
export interface Message {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: Content[]
  extensions: Extension[]
}
export interface Request {
  version: 1
  inbound: Protocol
  publicModel: string
  stream: boolean
  messages: Message[]
  tools: {
    name: string
    description?: string
    parameters: Json
    strict?: boolean
  }[]
  toolChoice?: 'auto' | 'none' | 'required' | { name: string }
  parallelTools?: boolean
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  stop?: string[]
  extensions: Extension[]
}
/** Input includes cache read/write; reasoning is a subset of output, never additive. */
export interface Usage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
  source: 'upstream' | 'estimated'
}
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter'
export interface Response {
  id: string
  publicModel: string
  content: Content[]
  finishReason: FinishReason
  usage?: Usage
  extensions: Extension[]
}
export interface Failure {
  code:
    | 'unsupported_capability'
    | 'invalid_request'
    | 'upstream_error'
    | 'timeout'
    | 'cancelled'
    | 'truncated_stream'
    | 'settlement_failed'
  message: string
  retryable: boolean
  requestId: string
}
export type Event =
  | { type: 'start'; id: string; publicModel: string }
  | { type: 'block_start'; index: number; block: Content }
  | {
      type: 'delta'
      index: number
      kind: 'text' | 'reasoning' | 'tool_arguments'
      value: string
    }
  | { type: 'block_end'; index: number }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: FinishReason }
  | { type: 'error'; error: Failure }
export interface CallContext {
  requestId: string
  upstreamModel: string
  signal: AbortSignal
  deadline: number
  // Inject an already policy-enforcing transport; adapters must not resolve ambient credentials.
  headers: Readonly<Record<string, string>>
  fetch: typeof globalThis.fetch
}
export interface InboundAdapter {
  protocol: Protocol
  decode(body: unknown): Request
  encode(response: Response): unknown
  encodeEvent(event: Event): Uint8Array[]
}
export interface UpstreamAdapter {
  protocol: Protocol
  invoke(request: Request, context: CallContext): AsyncIterable<Event>
}
