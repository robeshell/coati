# -*- coding: utf-8 -*-
"""用户 Anthropic ↔ 上游 OpenAI 翻译。"""

import json
import re

import pytest

from backend.app.agent.service.protocol_bridge import (
    AnthropicToOpenAIStream,
    OpenAIToAnthropicStream,
    OpenAIToResponsesStream,
    ProtocolBridgeError,
    ResponsesToOpenAIStream,
    anthropic_to_openai_body,
    anthropic_to_openai_message,
    anthropic_to_responses_body,
    anthropic_to_responses_message,
    bridge_request_body,
    bridge_response_body,
    openai_to_anthropic_body,
    openai_to_anthropic_message,
    openai_to_responses_body,
    openai_to_responses_message,
    responses_to_anthropic_body,
    responses_to_anthropic_message,
    responses_to_openai_message,
    responses_to_openai_body,
    server_tool_use_id,
)


def test_anthropic_to_openai_maps_system_tools_and_thinking():
    body = anthropic_to_openai_body({
        'model': 'coati-auto',
        'system': [{'type': 'text', 'text': 'be brief'}],
        'max_tokens': 64,
        'messages': [
            {
                'role': 'assistant',
                'content': [
                    {'type': 'thinking', 'thinking': 'plan', 'signature': 'sig'},
                    {'type': 'tool_use', 'id': 'tool_1', 'name': 'read', 'input': {'path': 'a.py'}},
                ],
            },
            {
                'role': 'user',
                'content': [{'type': 'tool_result', 'tool_use_id': 'tool_1', 'content': 'ok'}],
            },
        ],
        'tools': [{
            'name': 'read',
            'description': 'read file',
            'input_schema': {'type': 'object', 'properties': {'path': {'type': 'string'}}},
        }],
        'tool_choice': {'type': 'auto'},
    })
    assert body['messages'][0] == {'role': 'system', 'content': 'be brief'}
    assert body['messages'][1]['reasoning_content'] == 'plan'
    assert body['messages'][1]['tool_calls'][0]['function']['name'] == 'read'
    assert body['messages'][2] == {'role': 'tool', 'tool_call_id': 'tool_1', 'content': 'ok'}
    assert body['tools'][0]['function']['name'] == 'read'
    assert body['tool_choice'] == 'auto'
    assert body['max_tokens'] == 64


def test_openai_to_anthropic_maps_reasoning_and_tools():
    payload = openai_to_anthropic_message({
        'id': 'chatcmpl-1',
        'model': 'gpt-4o',
        'choices': [{
            'finish_reason': 'tool_calls',
            'message': {
                'role': 'assistant',
                'content': '',
                'reasoning_content': 'think',
                'tool_calls': [{
                    'id': 'call_1',
                    'type': 'function',
                    'function': {'name': 'read', 'arguments': '{"path":"a.py"}'},
                }],
            },
        }],
        'usage': {'prompt_tokens': 3, 'completion_tokens': 5},
    }, client_model='coati-auto')
    assert payload['model'] == 'coati-auto'
    assert payload['stop_reason'] == 'tool_use'
    assert payload['content'][0] == {'type': 'text', 'text': 'think'}
    assert payload['content'][1]['type'] == 'tool_use'
    assert payload['content'][1]['input'] == {'path': 'a.py'}
    assert payload['usage'] == {'input_tokens': 3, 'output_tokens': 5}


def test_openai_to_anthropic_rejects_malformed_tool_arguments():
    with pytest.raises(ProtocolBridgeError, match='不是有效 JSON'):
        openai_to_anthropic_message({
            'choices': [{
                'message': {
                    'tool_calls': [{
                        'function': {'name': 'read', 'arguments': '{not-json'},
                    }],
                },
            }],
        })


def test_openai_to_anthropic_rejects_multiple_choices_instead_of_dropping_them():
    with pytest.raises(ProtocolBridgeError, match='多候选'):
        openai_to_anthropic_message({
            'choices': [{'message': {}}, {'message': {}}],
        })


def test_protocol_matrix_uses_direct_request_and_response_bridges():
    anthropic_body = bridge_request_body(
        {'model': 'glm', 'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 32},
        'openai', 'anthropic-messages',
    )
    assert anthropic_body['messages'][0]['role'] == 'user'

    responses_body = bridge_request_body(
        {'model': 'claude', 'system': 'brief', 'messages': [{'role': 'user', 'content': 'hi'}]},
        'anthropic', 'openai-responses',
    )
    assert responses_body['instructions'] == 'brief'
    assert responses_body['input'][0]['content'][0]['text'] == 'hi'

    response = bridge_response_body(
        {'id': 'msg-1', 'type': 'message', 'model': 'glm', 'role': 'assistant',
         'content': [{'type': 'text', 'text': 'ok'}], 'usage': {'input_tokens': 2, 'output_tokens': 1}},
        'anthropic-messages', 'openai', 'glm-alias',
    )
    assert response['choices'][0]['message']['content'] == 'ok'
    assert response['model'] == 'glm-alias'


def test_direct_anthropic_responses_converters_preserve_reasoning_tools_and_cache():
    body = anthropic_to_responses_body({
        'model': 'claude', 'system': 'brief', 'max_tokens': 64,
        'thinking': {'type': 'enabled'},
        'messages': [{
            'role': 'assistant',
            'content': [
                {'type': 'thinking', 'thinking': 'plan'},
                {'type': 'tool_use', 'id': 'call_1', 'name': 'read', 'input': {'path': 'a.py'}},
            ],
        }],
    })
    assert body['instructions'] == 'brief'
    assert body['input'][0]['type'] == 'reasoning'
    assert body['input'][1]['type'] == 'function_call'
    assert body['reasoning'] == {'effort': 'medium'}

    restored = responses_to_anthropic_body({
        'model': 'glm', 'instructions': 'brief', 'max_output_tokens': 64,
        'input': [
            {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'hi'}]},
            {'type': 'reasoning', 'summary': [{'type': 'summary_text', 'text': 'plan'}],
             'encrypted_content': 'sig'},
            {'type': 'function_call', 'call_id': 'call_1', 'name': 'read', 'arguments': '{"path":"a.py"}'},
        ],
    })
    assert restored['system'] == 'brief'
    assert restored['messages'][0]['role'] == 'user'
    assert restored['messages'][1]['role'] == 'assistant'
    assert restored['messages'][1]['content'][0]['type'] == 'thinking'
    assert restored['messages'][1]['content'][0]['signature'] == 'sig'
    assert restored['messages'][1]['content'][1]['type'] == 'tool_use'

    response = anthropic_to_responses_message({
        'id': 'msg-1', 'model': 'claude', 'content': [
            {'type': 'thinking', 'thinking': 'plan', 'signature': 'sig'},
            {'type': 'tool_use', 'id': 'call_1', 'name': 'read', 'input': {'path': 'a.py'}},
        ], 'stop_reason': 'tool_use',
        'usage': {'input_tokens': 3, 'cache_read_input_tokens': 7, 'output_tokens': 2},
    })
    assert response['output'][0]['type'] == 'reasoning'
    assert response['output'][0]['encrypted_content'] == 'sig'
    assert response['output'][1]['type'] == 'function_call'
    assert response['usage']['input_tokens'] == 10

    cached_response = anthropic_to_responses_message({
        'id': 'msg-cache-write', 'model': 'claude',
        'content': [{'type': 'text', 'text': 'ok'}],
        'usage': {
            'input_tokens': 3,
            'cache_read_input_tokens': 7,
            'cache_creation_input_tokens': 2,
            'output_tokens': 1,
        },
    })
    assert cached_response['usage']['input_tokens_details'] == {
        'cache_write_tokens': 2,
        'cached_tokens': 7,
    }

    restored_response = responses_to_anthropic_message({
        'id': 'resp-1', 'model': 'glm', 'status': 'completed', 'output': [
            {'type': 'reasoning', 'summary': [{'type': 'summary_text', 'text': 'plan'}],
             'encrypted_content': 'sig'},
            {'type': 'message', 'content': [{'type': 'output_text', 'text': 'ok'}]},
            {'type': 'function_call', 'call_id': 'call_1', 'name': 'read', 'arguments': '{"path":"a.py"}'},
        ], 'usage': {'input_tokens': 10, 'output_tokens': 2,
                     'input_tokens_details': {'cached_tokens': 7}},
    })
    assert restored_response['content'][0]['type'] == 'thinking'
    assert restored_response['content'][0]['signature'] == 'sig'
    assert restored_response['content'][1] == {'type': 'text', 'text': 'ok'}
    assert restored_response['content'][2]['type'] == 'tool_use'
    assert restored_response['usage']['input_tokens'] == 3
    assert restored_response['usage']['cache_read_input_tokens'] == 7

    restored_cache_write = responses_to_anthropic_message({
        'id': 'resp-cache-write', 'model': 'glm', 'status': 'completed',
        'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': 'ok'}]}],
        'usage': {
            'input_tokens': 12,
            'output_tokens': 1,
            'input_tokens_details': {'cache_write_tokens': 2, 'cached_tokens': 7},
        },
    })
    assert restored_cache_write['usage'] == {
        'input_tokens': 3,
        'output_tokens': 1,
        'cache_read_input_tokens': 7,
        'cache_creation_input_tokens': 2,
    }


def test_anthropic_stream_can_be_converted_to_openai_chat_stream():
    bridge = AnthropicToOpenAIStream('glm')
    output = b''.join([
        bridge.feed({'type': 'message_start', 'message': {'id': 'msg-1', 'model': 'glm'}}, event='message_start'),
        bridge.feed({'type': 'content_block_start', 'index': 1,
                     'content_block': {'type': 'text', 'text': ''}}, event='content_block_start'),
        bridge.feed({'type': 'content_block_delta', 'index': 1,
                     'delta': {'type': 'text_delta', 'text': 'ok'}}, event='content_block_delta'),
        bridge.feed({'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'},
                     'usage': {'input_tokens': 1, 'output_tokens': 2}}, event='message_delta'),
        bridge.feed({'type': 'message_stop'}, event='message_stop'),
    ])
    text = output.decode('utf-8')
    assert '"content": "ok"' in text
    assert '"finish_reason": "stop"' in text
    assert 'data: [DONE]' in text


def test_anthropic_stream_merges_start_cache_usage_into_final_chat_usage():
    bridge = AnthropicToOpenAIStream('claude')
    bridge.feed({
        'type': 'message_start',
        'message': {
            'id': 'msg-usage',
            'usage': {
                'input_tokens': 3,
                'cache_read_input_tokens': 7,
                'cache_creation_input_tokens': 2,
            },
        },
    }, event='message_start')
    output = bridge.feed({
        'type': 'message_delta',
        'delta': {'stop_reason': 'end_turn'},
        'usage': {'output_tokens': 5},
    }, event='message_delta')
    chunks = [
        json.loads(line[6:]) for line in output.decode('utf-8').splitlines()
        if line.startswith('data: ') and line[6:] != '[DONE]'
    ]
    usage = chunks[-1]['usage']
    assert usage['prompt_tokens'] == 12
    assert usage['completion_tokens'] == 5
    assert usage['prompt_tokens_details']['cached_tokens'] == 7
    assert usage['cache_creation_input_tokens'] == 2


def test_failed_source_stream_events_raise_instead_of_emitting_done():
    anthropic = AnthropicToOpenAIStream('claude')
    with pytest.raises(ProtocolBridgeError, match='overloaded'):
        anthropic.feed({
            'type': 'error',
            'error': {'type': 'overloaded_error', 'message': 'overloaded'},
        }, event='error')

    responses = ResponsesToOpenAIStream('gpt')
    with pytest.raises(ProtocolBridgeError, match='upstream failed'):
        responses.feed({
            'type': 'response.failed',
            'response': {
                'status': 'failed',
                'error': {'type': 'server_error', 'message': 'upstream failed'},
            },
        }, event='response.failed')


def test_stream_matrix_builds_cross_protocol_pipelines():
    from backend.app.agent.service.protocol_bridge import ProtocolStreamPipeline, build_stream_bridge

    responses_target = build_stream_bridge('anthropic-messages', 'responses', 'model')
    assert isinstance(responses_target, ProtocolStreamPipeline)
    result = responses_target.feed_line('event: message_start')
    assert result == b''
    result = responses_target.feed_line(
        'data: {"type":"message_start","message":{"id":"msg-1","model":"glm"}}',
    )
    assert b'event: response.created' in result
    result = responses_target.feed_line(
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    )
    assert b'event: response.output_text.delta' in result

    anthropic_target = build_stream_bridge('openai-responses', 'anthropic', 'model')
    assert isinstance(anthropic_target, ProtocolStreamPipeline)
    result = anthropic_target.feed_line(
        'event: response.created',
    )
    assert result == b''
    result = anthropic_target.feed_line(
        'data: {"type":"response.created","response":{"id":"resp-1","model":"gpt"}}',
    )
    assert b'event: message_start' in result


def test_openai_stream_to_anthropic_events():
    bridge = OpenAIToAnthropicStream('coati-auto')
    first = bridge.feed({
        'id': 'chatcmpl-1',
        'choices': [{'delta': {'reasoning_content': 'why'}}],
    })
    second = bridge.feed({
        'choices': [{'delta': {'content': 'hi'}, 'finish_reason': 'stop'}],
        'usage': {'prompt_tokens': 1, 'completion_tokens': 2},
    })
    text = (first + second).decode('utf-8')
    assert 'event: message_start' in text
    assert '"thinking"' not in text
    assert '"text": "why"' in text
    assert '"text": "hi"' in text
    assert 'event: message_stop' in text
    first_event = json.loads(text.split('data: ', 1)[1].split('\n', 1)[0])
    assert first_event['message']['id'] == 'chatcmpl-1'
    assert first_event['message']['model'] == 'coati-auto'
    assert first_event['message']['stop_reason'] is None
    assert first_event['message']['stop_sequence'] is None
    assert first_event['message']['usage'] == {
        'input_tokens': 0,
        'output_tokens': 0,
    }
    events = [
        json.loads(line[6:])
        for line in text.splitlines()
        if line.startswith('data: ')
    ]
    message_delta = next(item for item in events if item.get('type') == 'message_delta')
    assert message_delta['delta'] == {
        'stop_reason': 'end_turn',
        'stop_sequence': None,
    }
    assert message_delta['usage'] == {'output_tokens': 2}
    assert bridge.finish() == []


def test_openai_tool_stream_keeps_block_index_and_serializes_object_arguments():
    bridge = OpenAIToAnthropicStream('qwen3.8-flash')
    first = bridge.feed({
        'choices': [{'delta': {'tool_calls': [{
            'index': 0, 'id': 'call_1',
            'function': {'name': 'read_file', 'arguments': ''},
        }]}}],
    })
    second = bridge.feed({
        'choices': [{'delta': {'tool_calls': [{
            'index': 0, 'function': {'arguments': {'path': 'a.py'}},
        }]}, 'finish_reason': 'tool_calls'}],
    })
    events = []
    for line in (first + second).decode('utf-8').splitlines():
        if line.startswith('data: '):
            events.append(json.loads(line[6:]))
    starts = [item for item in events if item.get('type') == 'content_block_start']
    deltas = [item for item in events if item.get('type') == 'content_block_delta']
    stops = [item for item in events if item.get('type') == 'content_block_stop']
    assert starts[0]['index'] == 0
    assert deltas[0]['index'] == 0
    assert json.loads(deltas[0]['delta']['partial_json']) == {'path': 'a.py'}
    assert stops[0]['index'] == 0


def test_responses_to_openai_maps_input_tools_and_history():
    body = responses_to_openai_body({
        'model': 'coati-auto',
        'instructions': 'short',
        'max_output_tokens': 64,
        'input': [
            {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'hi'}]},
            {
                'type': 'function_call',
                'call_id': 'call_1',
                'name': 'read',
                'arguments': '{"path":"a.py"}',
            },
            {'type': 'function_call_output', 'call_id': 'call_1', 'output': 'ok'},
        ],
        'tools': [{
            'type': 'function',
            'name': 'read',
            'description': 'read file',
            'parameters': {'type': 'object', 'properties': {'path': {'type': 'string'}}},
        }],
        'tool_choice': 'auto',
    })
    assert body['messages'][0] == {'role': 'system', 'content': 'short'}
    assert body['messages'][1] == {'role': 'user', 'content': 'hi'}
    assert body['messages'][2]['tool_calls'][0]['function']['name'] == 'read'
    assert body['messages'][3] == {'role': 'tool', 'tool_call_id': 'call_1', 'content': 'ok'}
    assert body['tools'][0]['function']['name'] == 'read'
    assert body['max_tokens'] == 64


def test_responses_to_openai_merges_additional_tools_from_input():
    body = responses_to_openai_body({
        'model': 'coati-auto',
        'input': [{
            'type': 'additional_tools',
            'tools': [{
                'type': 'function',
                'name': 'search',
                'parameters': {'type': 'object', 'properties': {}},
            }],
        }],
    })
    assert [tool['function']['name'] for tool in body['tools']] == ['search']


def test_responses_builtin_tools_are_rejected_on_non_responses_upstreams():
    request = {
        'model': 'gpt',
        'input': 'search this',
        'tools': [{'type': 'web_search_preview'}],
    }
    with pytest.raises(ProtocolBridgeError, match='Responses 原生上游'):
        responses_to_openai_body(request)
    with pytest.raises(ProtocolBridgeError, match='Responses 原生上游'):
        responses_to_anthropic_body(request)


def test_anthropic_nonstream_usage_includes_cache_read_and_creation_tokens():
    response = anthropic_to_openai_message({
        'id': 'msg-cache',
        'content': [{'type': 'text', 'text': 'ok'}],
        'usage': {
            'input_tokens': 3,
            'cache_read_input_tokens': 7,
            'cache_creation_input_tokens': 2,
            'output_tokens': 5,
        },
    })
    assert response['usage']['prompt_tokens'] == 12
    assert response['usage']['completion_tokens'] == 5
    assert response['usage']['prompt_tokens_details']['cached_tokens'] == 7


def test_openai_to_responses_maps_reasoning_and_tools():
    payload = openai_to_responses_message({
        'id': 'chatcmpl-1',
        'model': 'gpt-4o',
        'choices': [{
            'finish_reason': 'tool_calls',
            'message': {
                'role': 'assistant',
                'content': '',
                'reasoning_content': 'think',
                'tool_calls': [{
                    'id': 'call_1',
                    'type': 'function',
                    'function': {'name': 'read', 'arguments': '{"path":"a.py"}'},
                }],
            },
        }],
        'usage': {'prompt_tokens': 3, 'completion_tokens': 5},
    }, client_model='coati-auto')
    assert payload['object'] == 'response'
    assert payload['model'] == 'coati-auto'
    assert payload['output'][0]['type'] == 'reasoning'
    assert payload['output'][1]['type'] == 'function_call'
    assert payload['output'][1]['name'] == 'read'
    assert payload['usage'] == {
        'input_tokens': 3,
        'input_tokens_details': {'cache_write_tokens': 0, 'cached_tokens': 0},
        'output_tokens': 5,
        'output_tokens_details': {'reasoning_tokens': 0},
        'total_tokens': 8,
    }


def test_openai_stream_to_responses_events():
    bridge = OpenAIToResponsesStream('coati-auto')
    first = bridge.feed({
        'id': 'chatcmpl-1',
        'choices': [{'delta': {'content': 'hi'}, 'finish_reason': 'stop'}],
        'usage': {'prompt_tokens': 1, 'completion_tokens': 2},
    })
    text = first.decode('utf-8')
    assert 'event: response.created' in text
    assert 'event: response.output_text.delta' in text
    assert '"delta": "hi"' in text
    assert 'event: response.completed' in text
    created = json.loads(text.split('data: ', 1)[1].split('\n', 1)[0])
    assert created['response']['id'] == 'chatcmpl-1'
    assert bridge.finish() == []


def test_web_search_call_does_not_force_tool_use_stop_reason():
    """server tool 的搜索由上游解决，客户端拿不出 tool_result。

    返回 stop_reason: tool_use 会让客户端傻等一个永远不会来的结果。
    """
    message = responses_to_anthropic_message({
        'id': 'resp_1',
        'status': 'completed',
        'output': [
            {'type': 'web_search_call', 'id': 'ws_1', 'action': {'query': 'coati gateway'}},
            {'type': 'message', 'content': [{'type': 'output_text', 'text': '找到了'}]},
        ],
        'usage': {'input_tokens': 12, 'output_tokens': 4},
    })
    assert message['stop_reason'] == 'end_turn'
    assert message['content'][0] == {
        'type': 'server_tool_use',
        # Anthropic 要求 ^srvtoolu_[a-zA-Z0-9_]+$，Responses 的 ws_ 前缀 id 不合规。
        'id': 'srvtoolu_ws_1',
        'name': 'web_search',
        'input': {'query': 'coati gateway'},
    }


def test_web_search_call_prefers_the_plural_queries_field():
    """Responses 的 action.query 已被 SDK 标记废弃，正式字段是复数 queries 数组。"""
    message = responses_to_anthropic_message({
        'id': 'resp_q', 'status': 'completed',
        'output': [{
            'type': 'web_search_call', 'id': 'ws_q', 'status': 'completed',
            'action': {'type': 'search', 'query': 'old', 'queries': ['new query']},
        }],
    })
    assert message['content'][0]['input'] == {'query': 'new query'}


def test_web_search_call_emits_the_paired_result_block():
    """只给 server_tool_use 而没有紧跟的结果块，客户端会显示成「什么都没搜到」。"""
    message = responses_to_anthropic_message({
        'id': 'resp_s', 'status': 'completed',
        'output': [{
            'type': 'web_search_call', 'id': 'ws_s', 'status': 'completed',
            'action': {
                'type': 'search', 'queries': ['coati'],
                'sources': [{'type': 'url', 'url': 'https://example.com/a'}],
            },
        }],
    })
    use, result = message['content'][0], message['content'][1]
    assert result['type'] == 'web_search_tool_result'
    assert result['tool_use_id'] == use['id']
    assert isinstance(result['content'], list)
    assert result['content'][0] == {
        'type': 'web_search_result', 'url': 'https://example.com/a',
        'title': 'https://example.com/a',
    }


def test_failed_web_search_call_becomes_an_error_object_not_a_list():
    message = responses_to_anthropic_message({
        'id': 'resp_f', 'status': 'completed',
        'output': [{
            'type': 'web_search_call', 'id': 'ws_f', 'status': 'failed',
            'action': {'type': 'search', 'queries': ['boom']},
        }],
    })
    result = message['content'][1]
    assert result['content'] == {
        'type': 'web_search_tool_result_error', 'error_code': 'unavailable',
    }
    assert message['stop_reason'] == 'end_turn'


def test_real_function_call_still_sets_tool_use_stop_reason():
    """客户端工具仍必须置 tool_use：那个 tool_result 确实要客户端来给。"""
    message = responses_to_anthropic_message({
        'id': 'resp_2',
        'status': 'completed',
        'output': [
            {'type': 'web_search_call', 'id': 'ws_2', 'action': {'query': 'x'}},
            {'type': 'function_call', 'call_id': 'fc_1', 'name': 'Bash', 'arguments': '{"cmd":"ls"}'},
        ],
        'usage': {'input_tokens': 5, 'output_tokens': 2},
    })
    assert message['stop_reason'] == 'tool_use'


# ─── OpenAI Chat 入站 → Anthropic 上游 ────────────────────────────────────────

def test_parallel_tool_results_are_merged_into_one_user_turn():
    """OpenAI 每个工具结果是一条独立 tool 消息，Anthropic 要求角色交替。

    不合并的话，并行工具调用会产出连续多条 user 消息，被上游判成非法。
    """
    body = openai_to_anthropic_body({
        'model': 'm',
        'messages': [
            {'role': 'user', 'content': '查两件事'},
            {'role': 'assistant', 'content': None, 'tool_calls': [
                {'id': 'c1', 'type': 'function',
                 'function': {'name': 'a', 'arguments': '{}'}},
                {'id': 'c2', 'type': 'function',
                 'function': {'name': 'b', 'arguments': '{}'}},
            ]},
            {'role': 'tool', 'tool_call_id': 'c1', 'content': '结果一'},
            {'role': 'tool', 'tool_call_id': 'c2', 'content': '结果二'},
        ],
    })
    assert [msg['role'] for msg in body['messages']] == ['user', 'assistant', 'user']
    results = body['messages'][2]['content']
    assert [part['tool_use_id'] for part in results] == ['c1', 'c2']


def test_empty_content_messages_are_dropped():
    """Anthropic 不接受空 content 数组，而 OpenAI 端的空串消息很常见。"""
    body = openai_to_anthropic_body({
        'model': 'm',
        'messages': [
            {'role': 'user', 'content': ''},
            {'role': 'user', 'content': 'hi'},
        ],
    })
    assert body['messages'] == [
        {'role': 'user', 'content': [{'type': 'text', 'text': 'hi'}]},
    ]


def test_reasoning_content_becomes_text_not_an_unsigned_thinking_block():
    """thinking 块的 signature 是必填的，而 reasoning_content 没有对应物。

    合成一个签不出名的 thinking 块会被上游判成非法请求；降级成文本不丢内容。
    """
    body = openai_to_anthropic_body({
        'model': 'm',
        'messages': [{'role': 'assistant', 'content': '答案', 'reasoning_content': '推理过程'}],
    })
    blocks = body['messages'][0]['content']
    assert all(block['type'] != 'thinking' for block in blocks)
    assert blocks[0] == {'type': 'text', 'text': '推理过程'}


def test_tool_choice_is_dropped_when_there_are_no_tools():
    """tool_choice 不能脱离 tools 单独出现，否则上游判非法请求。"""
    body = openai_to_anthropic_body({
        'model': 'm', 'tool_choice': 'auto',
        'messages': [{'role': 'user', 'content': 'hi'}],
    })
    assert 'tool_choice' not in body

    responses_body = anthropic_to_responses_body({
        'model': 'm', 'tool_choice': {'type': 'auto'}, 'max_tokens': 16,
        'messages': [{'role': 'user', 'content': 'hi'}],
    })
    assert 'tool_choice' not in responses_body

    chat_to_responses = openai_to_responses_body({
        'model': 'm', 'tool_choice': 'auto',
        'messages': [{'role': 'user', 'content': 'hi'}],
    })
    assert 'tool_choice' not in chat_to_responses


def test_response_format_is_refused_rather_than_silently_dropped():
    """Anthropic 没有结构化输出参数。静默丢弃会让客户端拿到散文而毫无提示。"""
    with pytest.raises(ProtocolBridgeError, match='response_format'):
        openai_to_anthropic_body({
            'model': 'm',
            'response_format': {'type': 'json_object'},
            'messages': [{'role': 'user', 'content': 'hi'}],
        })
    # type=text 与不填等价，不该报错。
    assert openai_to_anthropic_body({
        'model': 'm', 'response_format': {'type': 'text'},
        'messages': [{'role': 'user', 'content': 'hi'}],
    })['messages']


def test_tool_call_only_assistant_turn_makes_no_empty_responses_item():
    body = openai_to_responses_body({
        'model': 'm',
        'messages': [{'role': 'assistant', 'content': None, 'tool_calls': [
            {'id': 'c1', 'type': 'function', 'function': {'name': 'a', 'arguments': '{}'}},
        ]}],
    })
    assert [item['type'] for item in body['input']] == ['function_call']


def test_web_search_options_maps_to_the_responses_native_tool():
    """Responses 有内置 web_search，字段能一一对上，忠实映射而不是丢弃。"""
    body = openai_to_responses_body({
        'model': 'm', 'messages': [{'role': 'user', 'content': 'hi'}],
        'web_search_options': {
            'search_context_size': 'high',
            'user_location': {'type': 'approximate',
                              'approximate': {'city': 'Hangzhou', 'country': 'CN'}},
        },
    })
    assert body['tools'] == [{
        'type': 'web_search', 'search_context_size': 'high',
        'user_location': {'city': 'Hangzhou', 'country': 'CN'},
    }]


def test_web_search_options_is_refused_for_anthropic_upstreams():
    """Anthropic 的搜索是 server tool，Chat 入站没有那套闭环，硬映射会退化成静默失效。"""
    with pytest.raises(ProtocolBridgeError, match='web_search_options'):
        openai_to_anthropic_body({
            'model': 'm', 'messages': [{'role': 'user', 'content': 'hi'}],
            'web_search_options': {'search_context_size': 'high'},
        })


def test_tool_result_blocks_are_flattened_for_responses_output():
    """Responses 的 function_call_output.output 不认 Anthropic 的 {'type': 'text'} 块。

    实测上游会回 Invalid 'output[0].type': 'text'。
    """
    body = anthropic_to_responses_body({
        'model': 'm', 'max_tokens': 64,
        'messages': [
            {'role': 'assistant', 'content': [
                {'type': 'tool_use', 'id': 'c1', 'name': 'web_search', 'input': {'query': 'x'}},
            ]},
            {'role': 'user', 'content': [
                {'type': 'tool_result', 'tool_use_id': 'c1',
                 'content': [{'type': 'text', 'text': '搜索结果正文'}]},
            ]},
        ],
    })
    outputs = [item for item in body['input'] if item['type'] == 'function_call_output']
    assert outputs == [{'type': 'function_call_output', 'call_id': 'c1', 'output': '搜索结果正文'}]


def test_server_tool_use_ids_are_normalised_to_anthropic_shape():
    """Anthropic 强制 ^srvtoolu_[a-zA-Z0-9_]+$，比普通 tool_use 更严（不允许连字符）。

    上游给的 id 一律不满足：Chat 是 call_abc-123，Responses 是 ws_00112233。
    """
    assert server_tool_use_id('call_abc-123') == 'srvtoolu_call_abc_123'
    assert server_tool_use_id('ws_00112233aabb') == 'srvtoolu_ws_00112233aabb'
    # 已经合规的原样保留（幂等）。
    assert server_tool_use_id('srvtoolu_01WYG3ziw53') == 'srvtoolu_01WYG3ziw53'
    # 空值也要产出一个合法 id。
    generated = server_tool_use_id('')
    assert re.fullmatch(r'srvtoolu_[a-zA-Z0-9_]+', generated)


def test_end_user_identity_survives_every_conversion():
    """三套协议对终端用户标识的叫法不同，但都有；上游靠它做滥用检测与归因。

    Chat/Responses 是顶层 user，Anthropic 是 metadata.user_id。
    """
    chat = {'model': 'm', 'messages': [{'role': 'user', 'content': 'hi'}], 'user': 'u-42'}
    assert openai_to_anthropic_body(chat)['metadata'] == {'user_id': 'u-42'}
    assert openai_to_responses_body(chat)['user'] == 'u-42'

    anthropic = {'model': 'm', 'max_tokens': 16, 'metadata': {'user_id': 'u-42'},
                 'messages': [{'role': 'user', 'content': 'hi'}]}
    assert anthropic_to_openai_body(anthropic)['user'] == 'u-42'
    assert anthropic_to_responses_body(anthropic)['user'] == 'u-42'

    responses = {'model': 'm', 'user': 'u-42',
                 'input': [{'type': 'message', 'role': 'user', 'content': 'hi'}]}
    assert responses_to_openai_body(responses)['user'] == 'u-42'
    assert responses_to_anthropic_body(responses)['metadata'] == {'user_id': 'u-42'}


def test_no_user_identity_means_no_injected_field():
    body = openai_to_anthropic_body({'model': 'm', 'messages': [{'role': 'user', 'content': 'hi'}]})
    assert 'metadata' not in body


def test_mid_conversation_system_message_becomes_a_developer_input():
    """Anthropic 允许 messages 里出现 role:system（Claude Code 用它下发操作指令）。

    Responses 侧的等价角色是 developer——实测上游对 role:system 一律拒绝，
    无论内容类型给什么。而输入内容只接受 input_text/input_image/input_file，
    output_text 是输出侧类型，放进输入会被判「Invalid content type」。
    """
    body = anthropic_to_responses_body({
        'model': 'm', 'max_tokens': 64,
        'messages': [
            {'role': 'user', 'content': '说一句话。'},
            {'role': 'system', 'content': '简短回答。'},
            {'role': 'assistant', 'content': [{'type': 'text', 'text': '好的。'}]},
        ],
    })
    shapes = [
        (item['role'], [c['type'] for c in item['content']])
        for item in body['input'] if item.get('type') == 'message'
    ]
    assert shapes == [
        ('user', ['input_text']),
        ('developer', ['input_text']),
        # 只有 assistant 的历史消息才允许 output_text。
        ('assistant', ['output_text']),
    ]


def test_no_input_item_ever_carries_output_text_for_a_non_assistant_role():
    body = anthropic_to_responses_body({
        'model': 'm', 'max_tokens': 64,
        'messages': [
            {'role': 'system', 'content': [{'type': 'text', 'text': 'a'}]},
            {'role': 'user', 'content': [{'type': 'text', 'text': 'b'}]},
        ],
    })
    for item in body['input']:
        if item.get('type') != 'message' or item['role'] == 'assistant':
            continue
        assert all(c['type'] != 'output_text' for c in item['content']), item


def test_responses_stream_uses_strict_event_shapes_and_sequence_numbers():
    bridge = OpenAIToResponsesStream('gpt')
    raw = bridge.feed({
        'id': 'chatcmpl-strict',
        'choices': [{'delta': {'content': 'ok'}, 'finish_reason': 'stop'}],
        'usage': {'prompt_tokens': 2, 'completion_tokens': 3},
    })
    events = [
        json.loads(line[6:]) for line in raw.decode().splitlines()
        if line.startswith('data: ')
    ]
    assert [event['sequence_number'] for event in events] == list(range(len(events)))
    created = events[0]['response']
    assert {
        'id', 'object', 'created_at', 'model', 'output',
        'parallel_tool_calls', 'tool_choice', 'tools',
    } <= created.keys()
    delta = next(event for event in events if event['type'] == 'response.output_text.delta')
    assert delta['logprobs'] == []
    completed = next(event for event in events if event['type'] == 'response.completed')
    assert completed['response']['usage'] == {
        'input_tokens': 2,
        'input_tokens_details': {'cache_write_tokens': 0, 'cached_tokens': 0},
        'output_tokens': 3,
        'output_tokens_details': {'reasoning_tokens': 0},
        'total_tokens': 5,
    }


def test_anthropic_stream_always_emits_terminal_usage():
    bridge = OpenAIToAnthropicStream('gpt')
    raw = bridge.feed({
        'choices': [{'delta': {}, 'finish_reason': 'stop'}],
    })
    events = [
        json.loads(line[6:]) for line in raw.decode().splitlines()
        if line.startswith('data: ')
    ]
    delta = next(event for event in events if event['type'] == 'message_delta')
    assert delta['usage'] == {'output_tokens': 0}


def test_responses_developer_items_become_top_level_anthropic_system():
    body = responses_to_anthropic_body({
        'model': 'claude',
        'instructions': 'global rule',
        'input': [
            {'type': 'message', 'role': 'user',
             'content': [{'type': 'input_text', 'text': 'hello'}]},
            {'type': 'message', 'role': 'developer',
             'content': [{'type': 'input_text', 'text': 'never reveal secrets'}]},
        ],
    })
    assert body['system'] == 'global rule\nnever reveal secrets'
    assert body['messages'] == [{
        'role': 'user', 'content': [{'type': 'text', 'text': 'hello'}],
    }]


def test_unsigned_responses_reasoning_is_downgraded_to_anthropic_text():
    body = responses_to_anthropic_body({
        'model': 'claude',
        'input': [{
            'type': 'reasoning',
            'summary': [{'type': 'summary_text', 'text': 'internal plan'}],
        }],
    })
    assert body['messages'] == [{
        'role': 'assistant', 'content': [{'type': 'text', 'text': 'internal plan'}],
    }]


def test_anthropic_tool_result_stays_before_residual_user_text():
    messages = anthropic_to_openai_body({
        'model': 'gpt',
        'messages': [{
            'role': 'user',
            'content': [
                {'type': 'tool_result', 'tool_use_id': 'call_1', 'content': 'done'},
                {'type': 'text', 'text': 'now summarize'},
            ],
        }],
    })['messages']
    assert messages == [
        {'role': 'tool', 'tool_call_id': 'call_1', 'content': 'done'},
        {'role': 'user', 'content': 'now summarize'},
    ]


def test_responses_refusal_is_preserved_as_visible_text():
    payload = responses_to_anthropic_message({
        'id': 'resp-refusal',
        'status': 'completed',
        'output': [{
            'type': 'message',
            'content': [{'type': 'refusal', 'refusal': '不能帮助你'}],
        }],
    })
    assert payload['content'] == [{'type': 'text', 'text': '不能帮助你'}]

    bridge = ResponsesToOpenAIStream('gpt')
    raw = bridge.feed({
        'type': 'response.refusal.done',
        'refusal': '不能帮助你',
    }, event='response.refusal.done')
    assert '不能帮助你' in raw.decode()
