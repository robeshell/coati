import type { Protocol } from '../src/modules/gateway/schema'
export const parallelCalls = [
  { id: 'call-a', name: 'weather', args: { city: '上海', note: 'a"b' } },
  { id: 'call-b', name: 'weather', args: { city: '北京', note: 'c\\d' } },
]
export function parallelFixture(
  protocol: Protocol,
  usage: Record<string, unknown>,
) {
  const args = parallelCalls.map((call) => JSON.stringify(call.args))
  const calls = parallelCalls.map((call, index) =>
    protocol === 'openai'
      ? {
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: args[index] },
        }
      : protocol === 'anthropic'
        ? { type: 'tool_use', id: call.id, name: call.name, input: call.args }
        : {
            id: call.id,
            call_id: call.id,
            type: 'function_call',
            name: call.name,
            arguments: args[index],
          },
  )
  const json =
    protocol === 'openai'
      ? {
          id: 'parallel',
          model: protocol,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '', tool_calls: calls },
              finish_reason: 'tool_calls',
            },
          ],
          usage,
        }
      : protocol === 'anthropic'
        ? {
            id: 'parallel',
            type: 'message',
            role: 'assistant',
            model: protocol,
            content: calls,
            stop_reason: 'tool_use',
            usage,
          }
        : {
            id: 'parallel',
            model: protocol,
            status: 'completed',
            output: calls,
            usage,
          }
  const events: any[] =
    protocol === 'openai'
      ? []
      : protocol === 'anthropic'
        ? [
            {
              type: 'message_start',
              message: {
                id: 'parallel',
                model: protocol,
                role: 'assistant',
                content: [],
                usage: { ...usage, output_tokens: 0 },
              },
            },
          ]
        : [
            {
              type: 'response.created',
              response: {
                id: 'parallel',
                model: protocol,
                status: 'in_progress',
                output: [],
              },
            },
          ]
  parallelCalls.forEach((call, index) => {
    if (protocol === 'openai')
      events.push({
        id: 'parallel',
        model: protocol,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    else if (protocol === 'anthropic')
      events.push({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: {},
        },
      })
    else
      events.push({
        type: 'response.output_item.added',
        output_index: index,
        item: { ...calls[index], arguments: '' },
      })
  })
  // Alternate single-character fragments, including JSON escape boundaries.
  for (
    let offset = 0;
    offset < Math.max(...args.map((value) => value.length));
    offset++
  )
    for (const index of [1, 0]) {
      const fragment = args[index]![offset]
      if (fragment === undefined) continue
      if (protocol === 'openai')
        events.push({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index, function: { arguments: fragment } }],
              },
              finish_reason: null,
            },
          ],
        })
      else if (protocol === 'anthropic')
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: fragment },
        })
      else
        events.push({
          type: 'response.function_call_arguments.delta',
          output_index: index,
          item_id: parallelCalls[index]!.id,
          delta: fragment,
        })
    }
  if (protocol === 'openai')
    events.push(
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage },
      '[DONE]',
    )
  else if (protocol === 'anthropic')
    events.push(
      ...[1, 0].map((index) => ({ type: 'content_block_stop', index })),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage },
      { type: 'message_stop' },
    )
  else
    events.push(
      ...calls.map((item, index) => ({
        type: 'response.output_item.done',
        output_index: index,
        item,
      })),
      { type: 'response.completed', response: json },
    )
  return { json, events }
}
