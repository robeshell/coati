# -*- coding: utf-8 -*-
"""Agent Provider Adapter 注册表与 OpenAI 兼容实现回归测试。"""

import json
from types import SimpleNamespace

import pytest

from backend.app.agent.service import provider_adapters
from backend.app.agent.constants import (
    UPSTREAM_ANTHROPIC_MESSAGES,
    UPSTREAM_OPENAI_CHAT,
    legacy_upstream_protocol,
)
from backend.app.agent.service.provider_adapters import (
    ProviderAdapterError,
    get_provider_adapter,
    provider_catalog,
)


def test_provider_catalog_exposes_available_and_reserved_adapters():
    catalog = {item['code']: item for item in provider_catalog()}
    assert catalog['deepseek']['available'] is True
    assert catalog['deepseek']['default_model'] == ''
    # 画像只描述厂商，不再声明协议能力——那是 upstream_protocol 的职责。
    assert 'capabilities' not in catalog['deepseek']
    assert catalog['anthropic']['status'] == 'available'
    assert catalog['gemini']['status'] == 'reserved'
    assert 'custom' not in catalog


def test_legacy_protocol_defaults_preserve_deepseek_chat_traffic():
    assert legacy_upstream_protocol('deepseek', 'https://api.deepseek.com') == UPSTREAM_OPENAI_CHAT
    assert legacy_upstream_protocol('anthropic', 'https://api.anthropic.com') == UPSTREAM_ANTHROPIC_MESSAGES
    assert legacy_upstream_protocol('openai-compatible', 'https://relay.example/anthropic') == UPSTREAM_ANTHROPIC_MESSAGES


def test_deepseek_adapter_builds_openai_compatible_request():
    adapter = get_provider_adapter('deepseek')
    request = adapter.build_chat_request(
        base_url='https://api.deepseek.com/',
        api_key='sk-test',
        model='deepseek-v4-pro',
        body={'messages': [{'role': 'user', 'content': 'hello'}], 'stream': False},
    )
    assert request.full_url == 'https://api.deepseek.com/chat/completions'
    assert request.get_header('Authorization') == 'Bearer sk-test'
    payload = json.loads(request.data.decode('utf-8'))
    assert payload['model'] == 'deepseek-v4-pro'
    assert payload['messages'][0]['content'] == 'hello'


def test_stream_request_forces_upstream_usage_event():
    adapter = get_provider_adapter('deepseek')
    request = adapter.build_chat_request(
        base_url='https://api.deepseek.com',
        api_key='sk-test',
        model='deepseek-v4-pro',
        body={'messages': [{'role': 'user', 'content': 'hello'}], 'stream': True},
    )
    payload = json.loads(request.data.decode('utf-8'))
    assert payload['stream_options'] == {'include_usage': True}


def test_usage_normalizes_prompt_cache_fields():
    adapter = get_provider_adapter('deepseek')
    usage = adapter.usage_from_response({
        'usage': {
            'prompt_tokens': 100,
            'completion_tokens': 20,
            'prompt_cache_hit_tokens': 70,
            'prompt_cache_miss_tokens': 30,
        },
    })
    assert usage == {
        'prompt_tokens': 100,
        'completion_tokens': 20,
        'cache_read_tokens': 70,
        'cache_miss_tokens': 30,
    }


@pytest.mark.parametrize('payload, expected', [
    (
        {
            'usage': {
                'prompt_tokens': 100,
                'completion_tokens': 20,
                'prompt_tokens_details': {'cached_tokens': 70},
            },
        },
        {
            'prompt_tokens': 100, 'completion_tokens': 20,
            'cache_read_tokens': 70, 'cache_miss_tokens': 30,
        },
    ),
    (
        {
            'usage': {
                'input_tokens': 100,
                'output_tokens': 20,
                'cache_read_input_tokens': 70,
                'cache_creation_input_tokens': 30,
            },
        },
        {
            'prompt_tokens': 100, 'completion_tokens': 20,
            'cache_read_tokens': 70, 'cache_write_tokens': 30,
            'cache_miss_tokens': 100,
        },
    ),
    (
        {
            'usageMetadata': {
                'promptTokenCount': 100,
                'candidatesTokenCount': 20,
                'cachedContentTokenCount': 70,
            },
        },
        {
            'prompt_tokens': 100, 'completion_tokens': 20,
            'cache_read_tokens': 70, 'cache_miss_tokens': 30,
        },
    ),
    (
        {
            'response': {
                'usage': {
                    'input_tokens': 100,
                    'output_tokens': 20,
                    'cacheMissInputTokens': 30,
                },
            },
        },
        {'prompt_tokens': 100, 'completion_tokens': 20, 'cache_miss_tokens': 30},
    ),
])
def test_usage_normalizes_common_provider_cache_shapes(payload, expected):
    assert get_provider_adapter('openai-compatible').usage_from_response(payload) == expected


def test_usage_preserves_explicit_zero_and_does_not_invent_cache_miss():
    adapter = get_provider_adapter('openai-compatible')
    assert adapter.usage_from_response({
        'usage': {
            'input_tokens': 100,
            'output_tokens': 20,
            'input_tokens_details': {'cached_tokens': 0},
        },
    }) == {
        'prompt_tokens': 100,
        'completion_tokens': 20,
        'cache_read_tokens': 0,
    }


def test_unknown_cache_read_field_stays_partial_without_protocol_semantics():
    adapter = get_provider_adapter('openai-compatible')
    assert adapter.usage_from_response({
        'usage': {
            'prompt_tokens': 100,
            'completion_tokens': 20,
            'cache_read_tokens': 70,
        },
    }) == {
        'prompt_tokens': 100,
        'completion_tokens': 20,
        'cache_read_tokens': 70,
    }


def test_known_adapter_can_derive_miss_from_prompt_total_and_cache_write():
    adapter = get_provider_adapter('openai')
    assert adapter.usage_from_response({
        'usage': {
            'prompt_tokens': 100,
            'completion_tokens': 20,
            'cache_read_tokens': 70,
            'cache_write_tokens': 10,
        },
    }) == {
        'prompt_tokens': 100,
        'completion_tokens': 20,
        'cache_read_tokens': 70,
        'cache_write_tokens': 10,
        'cache_miss_tokens': 20,
    }


def test_usage_normalizes_anthropic_cache_creation_breakdown():
    adapter = get_provider_adapter('openai-compatible')
    assert adapter.usage_from_response({
        'usage': {
            'input_tokens': 100,
            'output_tokens': 20,
            'cache_read_input_tokens': 70,
            'cache_creation': {'ephemeral_5m_input_tokens': 30},
        },
    }) == {
        'prompt_tokens': 100,
        'completion_tokens': 20,
        'cache_read_tokens': 70,
        'cache_write_tokens': 30,
        'cache_miss_tokens': 100,
    }


def test_stream_usage_normalizes_nested_usage_metadata():
    adapter = get_provider_adapter('openai-compatible')
    assert adapter.usage_from_stream_event({
        'response': {
            'usageMetadata': {
                'promptTokenCount': 100,
                'candidatesTokenCount': 20,
                'cachedContentTokenCount': 70,
            },
        },
    }) == {
        'prompt_tokens': 100,
        'completion_tokens': 20,
        'cache_read_tokens': 70,
        'cache_miss_tokens': 30,
    }


@pytest.mark.parametrize('provider', ['gemini'])
def test_reserved_adapter_fails_closed(provider):
    adapter = get_provider_adapter(provider)
    with pytest.raises(ProviderAdapterError, match='Adapter 尚未启用'):
        adapter.assert_available()


def test_unknown_provider_is_rejected():
    with pytest.raises(ProviderAdapterError, match='不支持的服务商'):
        get_provider_adapter('unknown-provider')


def test_deepseek_discover_models_rejects_empty_balance(monkeypatch):
    calls = []

    def fake_get(url, headers=None, timeout=None):
        calls.append(url)
        if url.endswith('/models'):
            return SimpleNamespace(
                status_code=200,
                json=lambda: {'data': [{'id': 'deepseek-v4-pro'}]},
                text='ok',
            )
        return SimpleNamespace(
            status_code=200,
            json=lambda: {
                'is_available': False,
                'balance_infos': [{'currency': 'CNY', 'total_balance': '0.00'}],
            },
            text='ok',
        )

    monkeypatch.setattr(provider_adapters.requests, 'get', fake_get)
    adapter = get_provider_adapter('deepseek')
    with pytest.raises(ProviderAdapterError, match='余额不足'):
        adapter.discover_models(
            base_url='https://api.deepseek.com', api_key='sk-test', timeout=5,
        )
    assert any(url.endswith('/user/balance') for url in calls)


def test_deepseek_discover_models_skips_missing_balance_endpoint(monkeypatch):
    def fake_get(url, headers=None, timeout=None):
        if url.endswith('/models'):
            return SimpleNamespace(
                status_code=200,
                json=lambda: {'data': [{'id': 'deepseek-v4-pro'}]},
                text='ok',
            )
        return SimpleNamespace(status_code=404, json=lambda: {}, text='not found')

    monkeypatch.setattr(provider_adapters.requests, 'get', fake_get)
    adapter = get_provider_adapter('deepseek')
    models = adapter.discover_models(
        base_url='https://api.deepseek.com', api_key='sk-test', timeout=5,
    )
    assert models == ['deepseek-v4-pro']


def _models_response(*, status_code, payload=None, text='', json_error=False):
    def _json():
        if json_error:
            raise ValueError('No JSON')
        return payload

    return SimpleNamespace(status_code=status_code, json=_json, text=text)


def test_discover_models_tolerates_missing_or_non_json_endpoint(monkeypatch):
    adapter = get_provider_adapter('openai-compatible')

    monkeypatch.setattr(
        provider_adapters.requests, 'get',
        lambda *args, **kwargs: _models_response(status_code=200, json_error=True, text='<html>nginx</html>'),
    )
    assert adapter.discover_models(base_url='https://relay.example/v1', api_key='sk', timeout=5) == []

    monkeypatch.setattr(
        provider_adapters.requests, 'get',
        lambda *args, **kwargs: _models_response(status_code=404, payload={'error': 'not found'}, text='not found'),
    )
    assert adapter.discover_models(base_url='https://relay.example/v1', api_key='sk', timeout=5) == []

    monkeypatch.setattr(
        provider_adapters.requests, 'get',
        lambda *args, **kwargs: _models_response(status_code=200, payload={'data': []}, text='[]'),
    )
    assert adapter.discover_models(base_url='https://relay.example/v1', api_key='sk', timeout=5) == []


def test_discover_models_forwards_user_agent_and_custom_headers(monkeypatch):
    captured = {}

    def fake_get(url, headers=None, timeout=None):
        captured['url'] = url
        captured['headers'] = headers
        captured['timeout'] = timeout
        return _models_response(status_code=200, payload={'data': [{'id': 'gpt-4o'}]}, text='ok')

    monkeypatch.setattr(provider_adapters.requests, 'get', fake_get)
    adapter = get_provider_adapter('openai-compatible')

    assert adapter.discover_models(
        base_url='https://relay.example/v1',
        api_key='sk',
        timeout=5,
        extra_headers={'User-Agent': 'claude-cli/2.1.161', 'X-Provider': 'cc-switch'},
    ) == ['gpt-4o']
    assert captured['headers']['User-Agent'] == 'claude-cli/2.1.161'
    assert captured['headers']['X-Provider'] == 'cc-switch'


def test_discover_models_forwards_channel_proxy(monkeypatch):
    captured = {}

    def fake_get(url, **kwargs):
        captured.update(kwargs)
        return _models_response(status_code=200, payload={'data': [{'id': 'gpt-4o'}]}, text='ok')

    monkeypatch.setattr(provider_adapters.requests, 'get', fake_get)
    adapter = get_provider_adapter('openai-compatible')
    assert adapter.discover_models(
        base_url='https://relay.example/v1', api_key='sk', timeout=5,
        proxy_url='http://192.168.1.100:7890',
    ) == ['gpt-4o']
    assert captured['proxies'] == {
        'http': 'http://192.168.1.100:7890',
        'https': 'http://192.168.1.100:7890',
    }


def test_discover_models_falls_back_to_v1_and_accepts_common_shapes(monkeypatch):
    calls = []

    def fake_get(url, headers=None, timeout=None):
        calls.append(url)
        if url == 'https://relay.example/models':
            return _models_response(status_code=404, payload={'error': 'not found'}, text='not found')
        return _models_response(status_code=200, payload={'models': ['gpt-4o', {'name': 'claude-3-7-sonnet'}]}, text='ok')

    monkeypatch.setattr(provider_adapters.requests, 'get', fake_get)
    adapter = get_provider_adapter('openai-compatible')

    assert adapter.discover_models(base_url='https://relay.example', api_key='sk', timeout=5) == [
        'claude-3-7-sonnet', 'gpt-4o',
    ]
    assert calls == ['https://relay.example/models', 'https://relay.example/v1/models']


def test_discover_models_still_rejects_unauthorized(monkeypatch):
    adapter = get_provider_adapter('openai-compatible')
    monkeypatch.setattr(
        provider_adapters.requests, 'get',
        lambda *args, **kwargs: _models_response(
            status_code=401, payload={'error': {'message': 'invalid'}}, text='unauthorized',
        ),
    )
    with pytest.raises(ProviderAdapterError, match='HTTP 401'):
        adapter.discover_models(base_url='https://relay.example/v1', api_key='sk', timeout=5)


def test_deepseek_web_search_builds_anthropic_messages_request():
    adapter = get_provider_adapter('deepseek')
    request = adapter.build_web_search_request(
        base_url='https://api.deepseek.com/v1',
        api_key='sk-test',
        model='deepseek-v4-flash',
        query='Node.js LTS',
    )
    assert request.full_url == 'https://api.deepseek.com/anthropic/v1/messages'
    payload = json.loads(request.data.decode('utf-8'))
    assert payload['model'] == 'deepseek-v4-flash'
    assert payload['tools'][0]['type'] == 'web_search_20250305'
    assert 'Node.js LTS' in payload['messages'][0]['content'][0]['text']


def test_deepseek_web_search_parses_tool_result_and_citations():
    adapter = get_provider_adapter('deepseek')
    sources = adapter.parse_web_search_response({
        'content': [
            {
                'type': 'web_search_tool_result',
                'content': [
                    {'type': 'web_search_result', 'url': 'https://nodejs.org/en', 'title': 'Node.js', 'page_age': '2026-01-01'},
                    {'type': 'web_search_result', 'url': 'https://nodejs.org/en', 'title': 'dup'},
                    {'type': 'web_search_result', 'url': 'https://example.com/drop', 'title': 'drop'},
                ],
            },
            {
                'type': 'text',
                'text': 'answer',
                'citations': [
                    {'url': 'https://nodejs.org/en', 'cited_text': 'JavaScript runtime'},
                ],
            },
        ],
        'usage': {'input_tokens': 11, 'output_tokens': 22},
    }, 1)
    assert sources == [{
        'url': 'https://nodejs.org/en',
        'title': 'Node.js',
        'snippet': 'JavaScript runtime',
        'publishedAt': '2026-01-01',
    }]
    usage = adapter.usage_from_web_search_response({
        'usage': {'input_tokens': 11, 'output_tokens': 22},
    })
    assert usage == {'prompt_tokens': 11, 'completion_tokens': 22}


def test_deepseek_web_search_rejects_missing_result_blocks():
    adapter = get_provider_adapter('deepseek')
    with pytest.raises(ProviderAdapterError, match='未返回网页搜索结果'):
        adapter.parse_web_search_response({'content': [{'type': 'text', 'text': 'no search'}]}, 5)


def test_anthropic_messages_url_by_provider():
    deepseek = get_provider_adapter('deepseek')
    compat = get_provider_adapter('openai-compatible')
    assert deepseek.anthropic_messages_url('https://api.deepseek.com/v1') == 'https://api.deepseek.com/anthropic/v1/messages'
    assert compat.anthropic_messages_url('https://relay.example/v1') == 'https://relay.example/v1/messages'
    assert compat.anthropic_messages_url('https://relay.example') == 'https://relay.example/v1/messages'


def test_build_anthropic_request_forwards_beta_headers():
    adapter = get_provider_adapter('deepseek')
    request = adapter.build_anthropic_request(
        base_url='https://api.deepseek.com',
        api_key='sk-test',
        model='deepseek-v4-pro',
        body={'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 32},
        request_headers={'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools-2024-04-04'},
    )
    assert request.full_url == 'https://api.deepseek.com/anthropic/v1/messages'
    payload = json.loads(request.data.decode('utf-8'))
    assert payload['model'] == 'deepseek-v4-pro'
    assert payload['max_tokens'] == 32
    headers = {key.lower(): value for key, value in request.header_items()}
    assert headers['authorization'] == 'Bearer sk-test'
    assert headers['x-api-key'] == 'sk-test'
    assert headers['anthropic-version'] == '2023-06-01'
    assert headers['anthropic-beta'] == 'tools-2024-04-04'


def _anthropic_payload(body, provider='deepseek'):
    request = get_provider_adapter(provider).build_anthropic_request(
        base_url='https://api.deepseek.com', api_key='sk-test',
        model='deepseek-v4-pro', body=body,
    )
    return json.loads(request.data.decode('utf-8'))


def test_adaptive_thinking_downgrade_carries_a_valid_budget():
    """ThinkingConfigEnabled.budget_tokens 是必填的（≥1024 且 < max_tokens）。

    只写 {'type': 'enabled'} 会把一个原本合法的请求改成非法请求。
    """
    payload = _anthropic_payload({'thinking': {'type': 'adaptive'}, 'max_tokens': 8192})
    assert payload['thinking']['type'] == 'enabled'
    budget = payload['thinking']['budget_tokens']
    assert 1024 <= budget < 8192


def test_adaptive_thinking_is_disabled_when_max_tokens_cannot_hold_a_budget():
    payload = _anthropic_payload({'thinking': {'type': 'adaptive'}, 'max_tokens': 32})
    assert payload['thinking'] == {'type': 'disabled'}


def test_adaptive_thinking_downgrade_keeps_the_display_field():
    payload = _anthropic_payload({
        'thinking': {'type': 'adaptive', 'display': 'omitted'}, 'max_tokens': 4096,
    })
    assert payload['thinking']['display'] == 'omitted'


def test_explicit_thinking_config_is_forwarded_untouched():
    thinking = {'type': 'enabled', 'budget_tokens': 2048}
    assert _anthropic_payload({'thinking': thinking, 'max_tokens': 8192})['thinking'] == thinking


def test_redacted_thinking_blocks_survive_to_the_upstream():
    """redacted_thinking 是官方合法块，且多轮里必须原样回传。

    剥掉它会破坏扩展思考 + 工具调用的签名链，让原生 Anthropic 账号报错。
    """
    content = [
        {'type': 'thinking', 'thinking': 'secret', 'signature': '0188-uuid'},
        {'type': 'redacted_thinking', 'data': 'hidden'},
        {'type': 'text', 'text': 'hello'},
    ]
    payload = _anthropic_payload({
        'max_tokens': 32, 'messages': [{'role': 'assistant', 'content': content}],
    })
    assert payload['messages'][0]['content'] == content


def test_openai_adapter_builds_responses_request_without_store():
    adapter = get_provider_adapter('openai')
    request = adapter.build_responses_request(
        base_url='https://api.openai.com/v1',
        api_key='sk-test',
        model='gpt-4o',
        body={'input': 'hello', 'store': True, 'stream': False},
    )
    assert request.full_url == 'https://api.openai.com/v1/responses'
    payload = json.loads(request.data.decode('utf-8'))
    assert payload['model'] == 'gpt-4o'
    assert payload['store'] is False
    assert payload['input'] == 'hello'


def test_web_search_request_shape_is_protocol_generic_not_vendor_specific():
    """搜索请求就是「Anthropic Messages + 内置搜索工具」，与厂商无关。

    以前这个形状只挂在 DeepSeek 画像上，还靠一个厂商能力位把门；能不能真的
    执行取决于上游端点的行为，画像答不了，改由网关按实际回包观测。
    """
    for code in ('openai-compatible', 'deepseek', 'anthropic'):
        request = get_provider_adapter(code).build_web_search_request(
            base_url='https://relay.example/v1', api_key='sk', model='m', query='q',
        )
        payload = json.loads(request.data.decode('utf-8'))
        assert payload['tools'][0]['type'] == 'web_search_20250305'


def test_anthropic_adapter_builds_the_search_request_at_its_own_endpoint():
    adapter = get_provider_adapter('anthropic')
    request = adapter.build_web_search_request(
        base_url='https://api.anthropic.com', api_key='sk-ant',
        model='claude-opus-5', query='coati gateway', max_uses=2,
    )
    assert request.full_url == 'https://api.anthropic.com/v1/messages'
    payload = json.loads(request.data.decode('utf-8'))
    assert payload['tools'][0] == {
        'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 2,
    }


def test_adapters_no_longer_carry_a_capability_matrix():
    """能力判断已经全部迁到 upstream_protocol，画像只保留真·厂商差异。

    capabilities 里那七个键当年只剩 web_search 还有人读，而那一条本身就是
    协议能力被错挂在厂商轴上；一并清掉，避免再有人往这里加选路判据。
    """
    for code in ('deepseek', 'openai', 'openai-compatible', 'anthropic', 'gemini'):
        adapter = get_provider_adapter(code)
        assert not hasattr(adapter, 'capabilities')
        assert 'capabilities' not in adapter.catalog_item()


def test_responses_upstream_uses_its_own_builtin_search_shape():
    """Responses 上游走内置 web_search，不是 Anthropic 的 server tool 声明。

    实测阿里云 Token Plan 只认 {'type': 'web_search'}，而且必须显式声明才触发；
    include 用来把来源 URL 带回来。
    """
    request = get_provider_adapter('openai-compatible').build_web_search_request(
        base_url='https://relay.example/compatible-mode/v1', api_key='sk',
        model='qwen3.8-flash', query='coati gateway', protocol='openai-responses',
    )
    assert request.full_url == 'https://relay.example/compatible-mode/v1/responses'
    payload = json.loads(request.data.decode('utf-8'))
    assert payload['tools'] == [{'type': 'web_search'}]
    assert payload['include'] == ['web_search_call.action.sources']


def test_responses_web_search_sources_are_parsed_from_the_call_action():
    sources = get_provider_adapter('openai-compatible').parse_web_search_response({
        'output': [
            {'type': 'reasoning'},
            {'type': 'web_search_call', 'action': {
                'type': 'search', 'queries': ['a'],
                'sources': [
                    {'type': 'url', 'url': 'https://a.io'},
                    {'type': 'url', 'url': 'https://a.io'},
                ],
            }},
            {'type': 'web_search_call', 'action': {
                'type': 'search', 'sources': [{'type': 'url', 'url': 'https://b.io'}],
            }},
        ],
    }, 5, protocol='openai-responses')
    # 跨多次调用去重；来源没有标题时回落到 URL。
    assert sources == [
        {'url': 'https://a.io', 'title': 'https://a.io'},
        {'url': 'https://b.io', 'title': 'https://b.io'},
    ]


def test_responses_upstream_without_search_results_is_reported():
    with pytest.raises(ProviderAdapterError, match='未返回网页搜索结果'):
        get_provider_adapter('openai-compatible').parse_web_search_response(
            {'output': [{'type': 'message'}]}, 5, protocol='openai-responses',
        )


def test_web_fetch_is_refused_on_protocols_without_a_fetch_tool():
    """Responses 侧没有可用的内置抓取工具，实测 web_fetch/url_context 都不触发。"""
    with pytest.raises(ProviderAdapterError, match='网页抓取工具'):
        get_provider_adapter('openai-compatible').build_web_fetch_request(
            base_url='https://relay.example/compatible-mode/v1', api_key='sk',
            model='qwen3.8-flash', url='https://a.io', protocol='openai-responses',
        )


def test_responses_search_harvests_open_page_urls_when_sources_are_absent():
    """各家 Responses 实现不一：有的不给 action.sources，只给 open_page 的 url。

    那同样是模型实际读过的页面（实测 DeepSeek 就是这样）。
    """
    sources = get_provider_adapter('openai-compatible').parse_web_search_response({
        'output': [
            {'type': 'web_search_call', 'action': {'type': 'search', 'queries': ['x']}},
            {'type': 'web_search_call', 'action': {'type': 'open_page', 'url': 'https://a.io/p'}},
            {'type': 'web_search_call', 'action': {'type': 'open_page', 'url': 'https://b.io/q'}},
        ],
    }, 5, protocol='openai-responses')
    assert [s['url'] for s in sources] == ['https://a.io/p', 'https://b.io/q']


def test_responses_search_without_any_usable_source_is_reported_not_empty():
    """搜了但一条来源都取不到，应让调度换下一个候选，而不是回空成功。"""
    with pytest.raises(ProviderAdapterError, match='没有可用来源'):
        get_provider_adapter('openai-compatible').parse_web_search_response({
            'output': [{'type': 'web_search_call', 'action': {'type': 'search', 'queries': ['x']}}],
        }, 5, protocol='openai-responses')


def test_responses_search_strips_upstream_call_anchors_and_dedupes():
    """同一页面被打开两次时，内部调用锚点会让去重失效（实测 DeepSeek 会加）。"""
    sources = get_provider_adapter('openai-compatible').parse_web_search_response({
        'output': [
            {'type': 'web_search_call',
             'action': {'type': 'open_page', 'url': 'https://a.io/p#ws_call_id=call_01_x'}},
            {'type': 'web_search_call',
             'action': {'type': 'open_page', 'url': 'https://a.io/p#ws_call_id=call_02_y'}},
        ],
    }, 5, protocol='openai-responses')
    assert sources == [{'url': 'https://a.io/p', 'title': 'https://a.io/p'}]


def test_effort_gives_way_to_an_explicit_thinking_budget():
    """Anthropic 允许 output_config.effort 与 thinking 并存，兼容入口不一定。

    实测阿里云 MaaS 把两者映射成 reasoning_effort / thinking_budget 后直接 400，
    而 Claude Code 在长 prompt 触发思考时两个都会发。两者表达同一个意图，
    thinking 更具体（给的是明确预算），让 effort 让路。
    """
    payload = _anthropic_payload({
        'max_tokens': 4096,
        'output_config': {'effort': 'medium'},
        'thinking': {'type': 'enabled', 'budget_tokens': 1024},
    })
    assert 'output_config' not in payload
    assert payload['thinking'] == {'type': 'enabled', 'budget_tokens': 1024}


def test_effort_is_kept_when_thinking_is_off():
    payload = _anthropic_payload({
        'max_tokens': 4096, 'output_config': {'effort': 'high'},
    })
    assert payload['output_config'] == {'effort': 'high'}


def test_output_config_keeps_its_other_fields():
    payload = _anthropic_payload({
        'max_tokens': 4096,
        'output_config': {'effort': 'medium', 'other': 'keep'},
        'thinking': {'type': 'enabled', 'budget_tokens': 1024},
    })
    assert payload['output_config'] == {'other': 'keep'}
