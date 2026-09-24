# -*- coding: utf-8 -*-
"""Anthropic web_search server tool 的形状契约。

字段形状以官方 web search tool 文档为准，特别是「成功时 content 是列表、出错时
content 是单个对象」这条——官方 SDK 就是靠它分支的。
"""

import json

from backend.app.agent.service.server_tools import (
    WEB_SEARCH_CLIENT_TOOL,
    anthropic_message_to_sse,
    apply_web_search_tool,
    WEB_SEARCH_SUPPORT,
    gateway_web_search_tool,
    native_web_search_tool,
    protocol_supports_native_web_search,
    should_try_native_web_search,
    extract_web_search_tool,
    filter_sources,
    is_web_search_call,
    localized_query,
    normalize_server_tool_history,
    search_queries_from_input,
    web_search_error_block,
    web_search_tool_result_block,
)


# ─── 工具声明识别 ──────────────────────────────────────────────────────────────

def test_extract_recognizes_every_published_tool_version():
    # 官方有三个版本：20250305 基础搜索、20260209 动态过滤、20260318 响应裁剪。
    for tool_type in ('web_search_20250305', 'web_search_20260209', 'web_search_20260318'):
        config, body = extract_web_search_tool({
            'tools': [{'type': tool_type, 'name': 'web_search'}],
        })
        assert config is not None, tool_type
        assert config['type'] == tool_type
        assert not any(
            str(tool.get('type') or '').startswith('web_search_')
            for tool in body['tools']
        )


def test_extract_captures_parameters_and_only_strips():
    """摘掉不等于换掉：换成什么形状要等选路之后才知道。"""
    config, body = extract_web_search_tool({
        'tools': [
            {'name': 'Bash', 'input_schema': {'type': 'object'}},
            {
                'type': 'web_search_20250305',
                'name': 'web_search',
                'max_uses': 3,
                'allowed_domains': ['docs.anthropic.com'],
                'user_location': {'type': 'approximate', 'city': 'Hangzhou', 'country': 'CN'},
            },
        ],
    })
    assert config['max_uses'] == 3
    assert config['allowed_domains'] == ['docs.anthropic.com']
    assert config['user_location']['city'] == 'Hangzhou'
    assert [tool.get('name') for tool in body['tools']] == ['Bash']


def test_extract_returns_none_without_a_server_tool():
    config, body = extract_web_search_tool({'tools': [{'name': 'Bash'}]})
    assert config is None
    assert body['tools'] == [{'name': 'Bash'}]


def test_extract_does_not_hijack_a_client_tool_of_the_same_name():
    """客户端自己声明了 web_search 时它有自己的执行方，网关不能抢过来跑。"""
    _config, body = extract_web_search_tool({
        'tools': [
            {'name': 'web_search', 'input_schema': {'type': 'object'}},
            {'type': 'web_search_20250305', 'name': 'web_search'},
        ],
    })
    assert body['tools'] == [{'name': 'web_search', 'input_schema': {'type': 'object'}}]


# ─── 查询词解析 ────────────────────────────────────────────────────────────────

def test_query_parsing_accepts_official_and_observed_shapes():
    # 官方形状：单数 query。
    assert search_queries_from_input({'query': 'coati gateway'}) == ['coati gateway']
    # 实测 qwen3.8-flash 发出的形状：复数 queries，值还是个 JSON 字符串。
    assert search_queries_from_input(
        {'queries': '["Claude Code pricing page", "Claude Code pricing Anthropic official"]'},
    ) == ['Claude Code pricing page', 'Claude Code pricing Anthropic official']
    # 真数组同样要吃。
    assert search_queries_from_input({'queries': ['a', 'b']}) == ['a', 'b']


def test_query_parsing_handles_json_string_input_and_empties():
    assert search_queries_from_input('{"query": "hello"}') == ['hello']
    assert search_queries_from_input('plain text') == ['plain text']
    assert search_queries_from_input({}) == []
    assert search_queries_from_input({'query': '   '}) == []


def test_query_parsing_dedupes_across_aliases():
    assert search_queries_from_input({'query': 'a', 'queries': ['a', 'b']}) == ['a', 'b']


def test_localized_query_appends_location_terms():
    assert localized_query('weather', {'city': 'NYC', 'country': 'US'}) == 'weather (NYC, US)'
    assert localized_query('weather', None) == 'weather'


# ─── 结果与错误块形状 ──────────────────────────────────────────────────────────

def test_success_content_is_a_list_and_error_content_is_an_object():
    ok = web_search_tool_result_block('srvtoolu_1', [
        {'url': 'https://example.com', 'title': 'Example', 'snippet': 'hi', 'page_age': '2026-01-01'},
    ])
    assert isinstance(ok['content'], list)
    assert ok['tool_use_id'] == 'srvtoolu_1'
    item = ok['content'][0]
    assert item['type'] == 'web_search_result'
    assert item['url'] == 'https://example.com'
    assert item['page_age'] == '2026-01-01'
    assert item['encrypted_content']

    failed = web_search_error_block('srvtoolu_1', 'max_uses_exceeded')
    assert isinstance(failed['content'], dict)
    assert failed['content'] == {
        'type': 'web_search_tool_result_error',
        'error_code': 'max_uses_exceeded',
    }


def test_zero_results_is_an_empty_list_not_an_error():
    block = web_search_tool_result_block('srvtoolu_2', [])
    assert block['content'] == []


def test_unknown_error_code_falls_back_to_unavailable():
    assert web_search_error_block('x', 'wat')['content']['error_code'] == 'unavailable'


def test_is_web_search_call_only_matches_pending_tool_use():
    assert is_web_search_call({'type': 'tool_use', 'name': 'web_search'})
    assert not is_web_search_call({'type': 'tool_use', 'name': 'Bash'})
    # 上游自己跑完的 server_tool_use 不需要网关再执行一次。
    assert not is_web_search_call({'type': 'server_tool_use', 'name': 'web_search'})


# ─── 域名过滤 ──────────────────────────────────────────────────────────────────

def test_allowed_domains_keep_only_matching_hosts_and_subdomains():
    sources = [
        {'url': 'https://docs.anthropic.com/en/api'},
        {'url': 'https://www.anthropic.com/news'},
        {'url': 'https://example.com/'},
    ]
    kept = filter_sources(sources, {'allowed_domains': ['anthropic.com']})
    assert [item['url'] for item in kept] == [
        'https://docs.anthropic.com/en/api', 'https://www.anthropic.com/news',
    ]


def test_blocked_domains_drop_matching_hosts():
    sources = [{'url': 'https://spam.example.com/x'}, {'url': 'https://ok.org/y'}]
    kept = filter_sources(sources, {'blocked_domains': ['example.com']})
    assert [item['url'] for item in kept] == ['https://ok.org/y']


def test_domain_entries_may_carry_a_path():
    sources = [{'url': 'https://example.com/blog/post'}, {'url': 'https://example.com/shop'}]
    kept = filter_sources(sources, {'allowed_domains': ['example.com/blog']})
    assert [item['url'] for item in kept] == ['https://example.com/blog/post']


# ─── 多轮历史归一化 ────────────────────────────────────────────────────────────

def test_history_server_tool_blocks_are_flattened_for_upstream():
    """客户端会把上一轮的 server tool 块原样带回来；上游不认识这些 type。"""
    original = web_search_tool_result_block('srvtoolu_1', [
        {'url': 'https://example.com', 'title': 'Example', 'snippet': 'the answer is 42'},
    ])
    body = normalize_server_tool_history({
        'messages': [
            {'role': 'user', 'content': [{'type': 'text', 'text': 'q'}]},
            {'role': 'assistant', 'content': [
                {'type': 'server_tool_use', 'id': 'srvtoolu_1', 'name': 'web_search',
                 'input': {'query': 'the answer'}},
                original,
                {'type': 'text', 'text': 'It is 42.'},
            ]},
        ],
    })
    assistant = body['messages'][1]['content']
    assert all(part['type'] == 'text' for part in assistant)
    joined = '\n'.join(part['text'] for part in assistant)
    assert 'the answer' in joined
    assert 'https://example.com' in joined
    # encrypted_content 是网关自己签发的，正文能还原回来而不是只剩标题链接。
    assert 'the answer is 42' in joined
    assert 'It is 42.' in joined


def test_history_error_blocks_are_flattened_too():
    body = normalize_server_tool_history({
        'messages': [{'role': 'assistant', 'content': [
            web_search_error_block('srvtoolu_9', 'too_many_requests'),
        ]}],
    })
    assert 'too_many_requests' in body['messages'][0]['content'][0]['text']


def test_history_without_server_tool_blocks_is_untouched():
    payload = {'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': 'hi'}]}]}
    assert normalize_server_tool_history(payload)['messages'] == payload['messages']


# ─── 非流式响应铺成 SSE ────────────────────────────────────────────────────────

def _sse_events(raw):
    events = []
    for chunk in raw.decode('utf-8').split('\n\n'):
        if not chunk.strip():
            continue
        name = chunk.splitlines()[0].split('event: ', 1)[1]
        data = json.loads(chunk.splitlines()[1].split('data: ', 1)[1])
        events.append((name, data))
    return events


def test_message_is_laid_out_as_a_complete_anthropic_sse_stream():
    raw = anthropic_message_to_sse({
        'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'model': 'qwen3.8-flash',
        'content': [
            {'type': 'server_tool_use', 'id': 's1', 'name': 'web_search',
             'input': {'query': 'coati'}},
            web_search_tool_result_block('s1', [{'url': 'https://a.io', 'title': 'A'}]),
            {'type': 'text', 'text': 'done'},
        ],
        'stop_reason': 'end_turn',
        'usage': {'input_tokens': 3, 'output_tokens': 2, 'server_tool_use': {'web_search_requests': 1}},
    })
    events = _sse_events(raw)
    names = [name for name, _ in events]
    assert names[0] == 'message_start'
    assert names[-2:] == ['message_delta', 'message_stop']
    assert names.count('content_block_start') == 3
    assert names.count('content_block_stop') == 3

    starts = [data for name, data in events if name == 'content_block_start']
    # server_tool_use 的 input 先空着，再由 input_json_delta 补齐，与官方一致。
    assert starts[0]['content_block']['input'] == {}
    # 结果块整块随 content_block_start 下发。
    assert starts[1]['content_block']['content'][0]['url'] == 'https://a.io'

    partials = [
        data['delta']['partial_json'] for name, data in events
        if name == 'content_block_delta' and data['delta']['type'] == 'input_json_delta'
    ]
    assert json.loads(partials[0]) == {'query': 'coati'}

    final = dict(events[-2][1])
    assert final['delta']['stop_reason'] == 'end_turn'
    assert final['usage']['server_tool_use'] == {'web_search_requests': 1}


# ─── 按上游协议决定工具形状 ───────────────────────────────────────────────────

def test_native_declaration_per_upstream_protocol():
    config = {
        'type': 'web_search_20260209', 'max_uses': 3,
        'allowed_domains': ['docs.anthropic.com'],
        'user_location': {'type': 'approximate', 'city': 'Hangzhou', 'country': 'CN'},
    }
    anthropic = native_web_search_tool(config, 'anthropic-messages')
    assert anthropic['type'] == 'web_search_20260209'
    assert anthropic['max_uses'] == 3
    assert anthropic['allowed_domains'] == ['docs.anthropic.com']

    # Responses 原生工具：类型是 web_search，白名单在 filters 下，
    # user_location 没有 type 字段。
    responses = native_web_search_tool(
        {k: v for k, v in config.items() if k != 'max_uses'}, 'openai-responses',
    )
    assert responses['type'] == 'web_search'
    assert responses['filters'] == {'allowed_domains': ['docs.anthropic.com']}
    assert responses['user_location'] == {'city': 'Hangzhou', 'country': 'CN'}
    assert 'type' not in responses['user_location']

    # Chat 协议没有内置搜索形状。
    assert native_web_search_tool(config, 'openai-chat') is None


def test_native_is_declined_when_it_would_silently_drop_a_constraint():
    """Responses 原生工具既没有域名黑名单也没有 max_uses，带了就不能走原生。"""
    assert native_web_search_tool(
        {'blocked_domains': ['spam.com']}, 'openai-responses',
    ) is None
    assert native_web_search_tool({'max_uses': 2}, 'openai-responses') is None
    assert native_web_search_tool({}, 'openai-responses') == {'type': 'web_search'}


def test_gateway_substitute_matches_each_upstream_tool_format():
    anthropic = gateway_web_search_tool('anthropic-messages')
    assert anthropic['input_schema']['required'] == ['query']
    responses = gateway_web_search_tool('openai-responses')
    assert responses['type'] == 'function'
    assert responses['parameters']['required'] == ['query']
    chat = gateway_web_search_tool('openai-chat')
    assert chat['function']['parameters']['required'] == ['query']


def test_apply_injects_native_shape_and_the_sources_include():
    body = apply_web_search_tool(
        {'model': 'x'}, {'type': 'web_search_20250305'}, 'openai-responses', native=True,
    )
    assert body['tools'] == [{'type': 'web_search'}]
    # 来源要显式 include 才会随 web_search_call 回来。
    assert body['include'] == ['web_search_call.action.sources']


def test_apply_injects_the_substitute_when_the_upstream_cannot_execute():
    body = apply_web_search_tool(
        {'model': 'x'}, {'type': 'web_search_20250305'}, 'anthropic-messages', native=False,
    )
    assert body['tools'][0]['name'] == 'web_search'
    assert body['tools'][0]['input_schema']['required'] == ['query']
    assert 'include' not in body


def test_not_offering_strips_the_injected_tool_and_repoints_tool_choice():
    """闭环收尾轮不再提供搜索，撤掉声明后 tool_choice 不能还指着它。"""
    body = apply_web_search_tool(
        {'tools': [{'name': 'web_search'}, {'name': 'Bash'}],
         'tool_choice': {'type': 'tool', 'name': 'web_search'}},
        {'type': 'web_search_20250305'}, 'anthropic-messages', native=False, offer=False,
    )
    assert [tool['name'] for tool in body['tools']] == ['Bash']
    # tool_choice 还指着撤掉的工具会被上游判成非法请求。
    assert body['tool_choice'] == {'type': 'auto'}


# ─── 账号轴：运行时观测，而不是厂商声明 ───────────────────────────────────────

def test_protocol_axis_is_about_the_protocol_only():
    config = {'type': 'web_search_20250305'}
    assert protocol_supports_native_web_search('anthropic-messages', config)
    assert protocol_supports_native_web_search('openai-responses', config)
    # Chat 协议没有内置搜索形状。
    assert not protocol_supports_native_web_search('openai-chat', config)


def test_unprobed_account_uses_the_gateway_tool_not_native():
    """未探明的账号先用普通工具，别赌。

    原生探测的回包里没有工具活动时，无法区分「上游忽略了声明」和「模型觉得
    不用搜」——赌错的表现就是同一个请求换把账号结果就不一样。
    """
    WEB_SEARCH_SUPPORT.clear()
    config = {'type': 'web_search_20250305'}
    assert WEB_SEARCH_SUPPORT.executes(7) is None
    assert not should_try_native_web_search('anthropic-messages', 7, config)
    # 确认会执行之后才走原生。
    WEB_SEARCH_SUPPORT.record(7, True)
    assert should_try_native_web_search('anthropic-messages', 7, config)
    WEB_SEARCH_SUPPORT.clear()


def test_an_account_observed_not_to_execute_is_not_tried_again():
    """DashScope 的 Anthropic 兼容入口：协议对得上，但它只会把工具打回来。"""
    WEB_SEARCH_SUPPORT.clear()
    config = {'type': 'web_search_20250305'}
    WEB_SEARCH_SUPPORT.record(7, False)
    assert not should_try_native_web_search('anthropic-messages', 7, config)
    WEB_SEARCH_SUPPORT.clear()


def test_protocol_without_a_native_shape_is_never_tried():
    WEB_SEARCH_SUPPORT.clear()
    WEB_SEARCH_SUPPORT.record(7, True)  # 即使已确认会执行
    assert not should_try_native_web_search(
        'openai-chat', 7, {'type': 'web_search_20250305'},
    )
    WEB_SEARCH_SUPPORT.clear()


def test_config_the_protocol_cannot_express_also_blocks_native():
    """Responses 没有域名黑名单：带了就必须退回闭环，不能悄悄丢掉约束。"""
    WEB_SEARCH_SUPPORT.clear()
    WEB_SEARCH_SUPPORT.record(7, True)
    assert not should_try_native_web_search(
        'openai-responses', 7, {'blocked_domains': ['spam.com']},
    )
    WEB_SEARCH_SUPPORT.clear()


def test_client_tool_of_the_same_name_blocks_every_injection():
    config, _body = extract_web_search_tool({
        'tools': [
            {'name': 'web_search', 'input_schema': {'type': 'object'}},
            {'type': 'web_search_20250305', 'name': 'web_search'},
        ],
    })
    assert config['client_tool_conflict'] is True
    body = apply_web_search_tool(
        {'tools': [{'name': 'web_search', 'input_schema': {'type': 'object'}}]},
        config, 'anthropic-messages', native=False,
    )
    assert body['tools'] == [{'name': 'web_search', 'input_schema': {'type': 'object'}}]


def test_client_tool_definition_is_never_mutated():
    tool = gateway_web_search_tool('anthropic-messages')
    tool['description'] = 'mutated'
    assert WEB_SEARCH_CLIENT_TOOL['description'] != 'mutated'


# ─── web_fetch ────────────────────────────────────────────────────────────────

from backend.app.agent.service.server_tools import (  # noqa: E402
    extract_server_tools,
    fetch_url_from_input,
    native_web_fetch_tool,
    web_fetch_error_block,
    web_fetch_result_block,
)


def test_extract_recognizes_every_published_web_fetch_version():
    for tool_type in ('web_fetch_20250910', 'web_fetch_20260209', 'web_fetch_20260309'):
        configs, rejected, body = extract_server_tools({
            'tools': [{'type': tool_type, 'name': 'web_fetch'}],
        })
        assert 'web_fetch' in configs, tool_type
        assert configs['web_fetch']['type'] == tool_type
        assert rejected == []
        assert body['tools'] == []


def test_extract_captures_web_fetch_parameters():
    configs, _rejected, _body = extract_server_tools({
        'tools': [{
            'type': 'web_fetch_20250910', 'name': 'web_fetch', 'max_uses': 2,
            'allowed_domains': ['docs.claude.com'], 'max_content_tokens': 5000,
            'citations': {'enabled': True},
        }],
    })
    cfg = configs['web_fetch']
    assert cfg['max_uses'] == 2
    assert cfg['allowed_domains'] == ['docs.claude.com']
    assert cfg['max_content_tokens'] == 5000
    assert cfg['citations'] == {'enabled': True}


def test_both_server_tools_can_be_declared_together():
    configs, _rejected, body = extract_server_tools({
        'tools': [
            {'name': 'Bash', 'input_schema': {'type': 'object'}},
            {'type': 'web_search_20250305', 'name': 'web_search'},
            {'type': 'web_fetch_20250910', 'name': 'web_fetch'},
        ],
    })
    assert set(configs) == {'web_search', 'web_fetch'}
    assert [tool['name'] for tool in body['tools']] == ['Bash']


def test_unsupported_server_tools_are_flagged_for_rejection_not_forwarded():
    """静默转发一个谁都不会执行的工具，正是 web_search 当初的坑。"""
    configs, rejected, body = extract_server_tools({
        'tools': [
            {'type': 'code_execution_20250522', 'name': 'code_execution'},
            {'type': 'tool_search_tool_bm25_20251119', 'name': 'tool_search'},
        ],
    })
    assert configs == {}
    assert rejected == ['code_execution_20250522', 'tool_search_tool_bm25_20251119']
    # 绝不能留在转发给上游的 tools 里。
    assert body['tools'] == []


def test_web_fetch_success_content_is_an_object_not_a_list():
    """与 web_search 不同：这边成功也是对象，靠 type 而不是 list/object 区分。"""
    block = web_fetch_result_block('srvtoolu_1', {
        'url': 'https://claude.com/pricing', 'title': 'Pricing',
        'text': '每月 20 美元起。', 'retrieved_at': '2026-08-31T00:00:00Z',
    })
    assert block['type'] == 'web_fetch_tool_result'
    assert block['tool_use_id'] == 'srvtoolu_1'
    content = block['content']
    assert isinstance(content, dict)
    assert content['type'] == 'web_fetch_result'
    assert content['url'] == 'https://claude.com/pricing'
    assert content['retrieved_at'] == '2026-08-31T00:00:00Z'
    # 正文包在 DocumentBlock 的 PlainTextSource 里。
    document = content['content']
    assert document['type'] == 'document'
    assert document['title'] == 'Pricing'
    assert document['source'] == {
        'type': 'text', 'media_type': 'text/plain', 'data': '每月 20 美元起。',
    }


def test_web_fetch_error_uses_its_own_error_code_set():
    assert web_fetch_error_block('x', 'url_not_allowed')['content'] == {
        'type': 'web_fetch_tool_result_error', 'error_code': 'url_not_allowed',
    }
    # web_search 的错误码不属于这一套，落回 unavailable。
    assert web_fetch_error_block('x', 'query_too_long')['content']['error_code'] == 'unavailable'


def test_fetch_url_parsing_tolerates_the_shapes_models_actually_emit():
    assert fetch_url_from_input({'url': 'https://a.io'}) == 'https://a.io'
    assert fetch_url_from_input({'urls': '["https://a.io"]'}) == 'https://a.io'
    assert fetch_url_from_input('{"url": "https://a.io"}') == 'https://a.io'
    assert fetch_url_from_input({}) is None


def test_web_fetch_has_no_native_shape_outside_anthropic_messages():
    cfg = {'type': 'web_fetch_20250910'}
    assert native_web_fetch_tool(cfg, 'anthropic-messages')['name'] == 'web_fetch'
    # OpenAI Responses 没有内置 web_fetch，只能网关代跑。
    assert native_web_fetch_tool(cfg, 'openai-responses') is None
    assert native_web_fetch_tool(cfg, 'openai-chat') is None


def test_web_fetch_history_blocks_are_flattened_with_their_text():
    from backend.app.agent.service.server_tools import normalize_server_tool_history as norm
    body = norm({'messages': [{'role': 'assistant', 'content': [
        {'type': 'server_tool_use', 'id': 's1', 'name': 'web_fetch',
         'input': {'url': 'https://a.io'}},
        web_fetch_result_block('s1', {'url': 'https://a.io', 'title': 'A', 'text': '正文在此'}),
    ]}]})
    joined = '\n'.join(part['text'] for part in body['messages'][0]['content'])
    assert 'https://a.io' in joined
    assert '正文在此' in joined


# ─── 纯搜索请求的短路 ─────────────────────────────────────────────────────────

from backend.app.agent.service.server_tools import search_only_query  # noqa: E402


def _search_only_body(text, tools=None, messages=None):
    return {
        'model': 'm', 'max_tokens': 1024,
        'messages': messages or [{'role': 'user', 'content': text}],
        'tools': tools or [],
    }


_SEARCH_CFG = {'web_search': {'type': 'web_search_20250305'}}


def test_claude_code_search_subrequest_is_recognised():
    """Claude Code 的 WebSearch 会为搜索单独发一个子请求，正文是固定引导语。"""
    assert search_only_query(
        _search_only_body('Perform a web search for the query: Claude Code pricing'),
        _SEARCH_CFG,
    ) == 'Claude Code pricing'


def test_a_normal_question_is_never_short_circuited():
    """只看「单条消息 + 只有搜索工具」会把正常对话一起截胡。

    用户问「Claude Code 多少钱？」要的是模型的回答，不是一串链接。
    """
    assert search_only_query(_search_only_body('Claude Code 多少钱？'), _SEARCH_CFG) is None


def test_other_client_tools_block_the_short_circuit():
    """还带着别的工具，说明客户端指望模型能调它们。"""
    assert search_only_query(
        _search_only_body(
            'Perform a web search for the query: x',
            tools=[{'name': 'Bash', 'input_schema': {'type': 'object'}}],
        ),
        _SEARCH_CFG,
    ) is None


def test_multi_turn_conversations_are_not_short_circuited():
    assert search_only_query(
        _search_only_body('', messages=[
            {'role': 'user', 'content': 'hi'},
            {'role': 'assistant', 'content': 'hello'},
            {'role': 'user', 'content': 'Perform a web search for the query: x'},
        ]),
        _SEARCH_CFG,
    ) is None


def test_web_fetch_in_the_same_request_blocks_the_short_circuit():
    configs = {'web_search': {'type': 'web_search_20250305'},
               'web_fetch': {'type': 'web_fetch_20250910'}}
    assert search_only_query(
        _search_only_body('Perform a web search for the query: x'), configs,
    ) is None


def test_leaked_tool_call_markers_are_recognised():
    from backend.app.agent.service.server_tools import has_leaked_tool_call_text
    assert has_leaked_tool_call_text([
        {'type': 'text', 'text': 'I will search.\n<tool_call>\n<function=web_search>'},
    ])
    # 正常回答不该被误判。
    assert not has_leaked_tool_call_text([
        {'type': 'text', 'text': '按席位计费，每月 20 美元起。'},
    ])
    assert not has_leaked_tool_call_text([{'type': 'thinking', 'thinking': '<tool_call>'}])
