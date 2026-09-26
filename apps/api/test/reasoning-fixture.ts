import type { Protocol } from '../src/modules/gateway/schema'
export const thought = '先检查边界，再比较结果。'
export const signature = 'opaque-fixture-signature/+=不是密钥'
export const answer = '结论成立。'
export function reasoningJson(
  protocol: Protocol,
  usage: Record<string, unknown>,
) {
  const common = { id: 'reasoning-1', model: protocol, usage }
  if (protocol === 'openai')
    return {
      ...common,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: answer,
            reasoning_content: thought,
          },
          finish_reason: 'stop',
        },
      ],
    }
  if (protocol === 'anthropic')
    return {
      ...common,
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: thought, signature },
        { type: 'text', text: answer },
      ],
      stop_reason: 'end_turn',
    }
  return {
    ...common,
    object: 'response',
    status: 'completed',
    output: [
      {
        id: 'rs1',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: thought }],
        encrypted_content: signature,
      },
      {
        id: 'msg1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: answer, annotations: [] }],
      },
    ],
  }
}

export function reasoningEvents(
  protocol: Protocol,
  usage: Record<string, unknown>,
): any[] {
  const json = reasoningJson(protocol, usage) as any
  if (protocol === 'openai')
    return [
      ...[...thought].map((text) => ({
        id: json.id,
        model: protocol,
        choices: [
          { index: 0, delta: { reasoning_content: text }, finish_reason: null },
        ],
      })),
      ...[...answer].map((text) => ({
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      })),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage },
      '[DONE]',
    ]
  if (protocol === 'anthropic')
    return [
      {
        type: 'message_start',
        message: {
          ...json,
          content: [],
          stop_reason: null,
          usage: { ...usage, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
      ...[...thought].map((thinking) => ({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking },
      })),
      ...[...signature].map((signature) => ({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature },
      })),
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
      ...[...answer].map((text) => ({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text },
      })),
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
      { type: 'message_stop' },
    ]
  return [
    {
      type: 'response.created',
      response: {
        ...json,
        status: 'in_progress',
        output: [],
        usage: undefined,
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'rs1', type: 'reasoning', summary: [] },
    },
    {
      type: 'response.reasoning_summary_part.added',
      output_index: 0,
      item_id: 'rs1',
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    },
    ...[...thought].map((delta) => ({
      type: 'response.reasoning_summary_text.delta',
      output_index: 0,
      item_id: 'rs1',
      summary_index: 0,
      delta,
    })),
    {
      type: 'response.reasoning_summary_text.done',
      output_index: 0,
      item_id: 'rs1',
      summary_index: 0,
      text: thought,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: json.output[0],
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { ...json.output[1], content: [] },
    },
    ...[...answer].map((delta) => ({
      type: 'response.output_text.delta',
      output_index: 1,
      item_id: 'msg1',
      content_index: 0,
      delta,
    })),
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: json.output[1],
    },
    { type: 'response.completed', response: json },
  ]
}

export function interleavedThinking() {
  return [
    {
      type: 'message_start',
      message: {
        id: 'mixed',
        role: 'assistant',
        model: 'fixture',
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'thinking_delta', thinking: '第二块' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '第一块' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'signature_delta', signature: 'sig-b' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: '答案' },
    },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig-a' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}
