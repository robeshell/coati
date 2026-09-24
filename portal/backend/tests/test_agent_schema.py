# -*- coding: utf-8 -*-
"""Agent 域输入规范回归测试。"""

import json
from datetime import datetime, timezone

import pytest
from flask import Flask

from backend.app.agent.schema.auth import normalize_pat_payload, normalize_pat_update_payload
from backend.app.agent.schema.common import AgentValidationError
from backend.app.agent.schema.credential import normalize_credential_payload, normalize_proxy_url
from backend.app.agent.schema.route import normalize_route_payload
from backend.app.agent.schema.model_profile import normalize_model_profile_payload
from backend.app.agent.schema.usage import normalize_quota_payload, normalize_usage_event, normalize_usage_filters
from backend.app.agent.service.auth_service import device_confirmation_message
from backend.app.agent.api.bootstrap import build_agent_bootstrap
from backend.app.agent.service.credential_crypto import (
    ENCRYPTED_PREFIX,
    api_key_fingerprint,
    api_key_hint,
    decrypt_api_key,
    encrypt_api_key,
)
from backend.app.agent.time_utils import local_bucket_iso, local_day_start_utc, utc_iso


def test_credential_normalizes_url_and_boolean():
    payload = normalize_credential_payload({
        'name': ' DeepSeek 主用 ', 'base_url': 'https://api.deepseek.com/v1/',
        'api_key': ' secret ', 'enabled': 'false', 'weight': '120',
    })
    assert payload['name'] == 'DeepSeek 主用'
    assert payload['base_url'] == 'https://api.deepseek.com/v1'
    assert payload['api_key'] == 'secret'
    assert payload['enabled'] is False
    assert payload['weight'] == 120
    assert 'provider' not in payload
    assert payload['upstream_protocol'] == 'openai-chat'
    assert payload['default_model'] == ''


def test_credential_normalizes_models_and_routing_fields_but_ignores_legacy_tags():
    payload = normalize_credential_payload({
        'name': 'DeepSeek 备用',
        'base_url': 'https://api.deepseek.com',
        'api_key': 'secret',
        'supported_models': ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-pro'],
        'tags': ['production', 'cn'],
        'priority': '200',
        'request_timeout_seconds': '45',
    })
    assert json.loads(payload['models_json']) == ['deepseek-v4-pro', 'deepseek-v4-flash']
    assert 'multimodal_models_json' not in payload
    assert 'tags_json' not in payload
    assert payload['priority'] == 200
    assert payload['request_timeout_seconds'] == 45


def test_model_profile_normalizes_capability_fields():
    assert normalize_model_profile_payload({
        'model_name': ' deepseek-v4-pro ',
        'context_window': '1000000',
        'max_output_tokens': '16384',
    }) == {
        'model_name': 'deepseek-v4-pro',
        'context_window': 1_000_000,
        'max_output_tokens': 16_384,
        'enabled': True,
        'note': None,
    }


def test_model_profile_rejects_invalid_context_window():
    with pytest.raises(AgentValidationError):
        normalize_model_profile_payload({'model_name': 'qwen-coder', 'context_window': 0})


def test_credential_normalizes_model_prefix_and_extra_headers():
    payload = normalize_credential_payload({
        'name': 'OpenRouter',
        'base_url': 'https://openrouter.ai/api/v1',
        'api_key': 'secret',
        'model_prefix': ' mine ',
        'extra_headers': {'HTTP-Referer': 'https://coati.local', 'X-Title': 'COATI'},
    })
    assert payload['model_prefix'] == 'mine'
    assert json.loads(payload['extra_headers_json']) == {
        'HTTP-Referer': 'https://coati.local', 'X-Title': 'COATI',
    }


def test_credential_rejects_blocked_extra_headers():
    with pytest.raises(AgentValidationError):
        normalize_credential_payload({
            'name': 'bad',
            'base_url': 'https://api.deepseek.com',
            'api_key': 'secret',
            'extra_headers': {'Authorization': 'Bearer stolen'},
        })


def test_credential_key_is_encrypted_and_can_be_decrypted():
    app = Flask(__name__)
    app.config['AGENT_CREDENTIAL_ENCRYPTION_KEY'] = 'test-only-encryption-key'
    raw_key = 'sk-this-is-a-sensitive-key'
    with app.app_context():
        encrypted = encrypt_api_key(raw_key)
        assert encrypted.startswith(ENCRYPTED_PREFIX)
        assert raw_key not in encrypted
        assert decrypt_api_key(encrypted) == raw_key
        assert api_key_hint(raw_key) == 'sk-t…-key'
        assert len(api_key_fingerprint(raw_key)) == 64


@pytest.mark.parametrize('url', ['javascript:alert(1)', 'api.example.com/v1', 'ftp://example.com'])
def test_credential_rejects_unsafe_url(url):
    with pytest.raises(AgentValidationError):
        normalize_credential_payload({'name': 'bad', 'base_url': url, 'api_key': 'key'})


def test_credential_normalizes_http_proxy_without_exposing_auth_hint():
    payload = normalize_credential_payload({
        'name': '带代理渠道',
        'base_url': 'https://api.example.com/v1',
        'api_key': 'key',
        'proxy_url': 'http://proxy-user:proxy-pass@192.168.1.100:7890/',
    })
    assert payload['proxy_url'] == 'http://proxy-user:proxy-pass@192.168.1.100:7890'
    assert normalize_proxy_url('https://192.168.1.100:8443') == 'https://192.168.1.100:8443'


@pytest.mark.parametrize('proxy_url', ['socks5://127.0.0.1:1080', 'proxy.local:7890', 'http://127.0.0.1:70000'])
def test_credential_rejects_unsupported_proxy(proxy_url):
    with pytest.raises(AgentValidationError):
        normalize_credential_payload({
            'name': 'bad', 'base_url': 'https://api.example.com', 'api_key': 'key',
            'proxy_url': proxy_url,
        })


def test_route_partial_update_only_contains_submitted_fields():
    assert normalize_route_payload({'enabled': False}, partial=True) == {'enabled': False}


def test_usage_rejects_negative_tokens():
    with pytest.raises(AgentValidationError):
        normalize_usage_event({'prompt_tokens': -1})


def test_usage_cache_fields_keep_missing_as_none():
    payload = normalize_usage_event({'prompt_tokens': 100, 'completion_tokens': 20})
    assert payload['cache_read_tokens'] is None
    assert payload['cache_write_tokens'] is None
    assert payload['cache_miss_tokens'] is None


def test_usage_filters_only_support_page_controls_and_validate_status():
    filters = normalize_usage_filters({
        'days': '30', 'user_id': '2', 'status': 'ok', 'model': ' coati-coding ',
    })
    assert filters['days'] == 30
    assert filters['user_id'] == 2
    assert filters['model'] == 'coati-coding'
    assert set(filters) == {'days', 'user_id', 'pat_id', 'status', 'model'}
    assert normalize_usage_filters({})['model'] is None
    with pytest.raises(AgentValidationError):
        normalize_usage_filters({'status': 'unknown'})
    with pytest.raises(AgentValidationError):
        normalize_usage_filters({'model': 'x' * 129})


def test_usage_event_supports_request_trace_metadata():
    payload = normalize_usage_event({
        'request_id': 'req_123', 'parent_request_id': 'req_parent',
        'model': 'coati-coding', 'upstream_model': 'deepseek-v4-pro',
        'session_id': 'sess_123', 'client_request_id': 'logical_123',
        'step_index': '4', 'retry_index': '1',
        'route_id': '2', 'http_status': '502', 'error_summary': '上游不可达',
        'attempt_count': '2', 'fallback_used': 'true', 'status': 'upstream_error',
        'context_tokens_estimate': '1200', 'context_bytes': '4800',
        'message_count': '8', 'tool_count': '3', 'image_count': '1',
        'tool_result_bytes': '3000', 'largest_message_bytes': '2500',
        'cache_read_tokens': '600', 'cache_write_tokens': '100', 'cache_miss_tokens': '500',
    })
    assert payload['request_id'] == 'req_123'
    assert payload['parent_request_id'] == 'req_parent'
    assert payload['session_id'] == 'sess_123'
    assert payload['client_request_id'] == 'logical_123'
    assert payload['step_index'] == 4
    assert payload['retry_index'] == 1
    assert payload['upstream_model'] == 'deepseek-v4-pro'
    assert payload['route_id'] == 2
    assert payload['http_status'] == 502
    assert payload['attempt_count'] == 2
    assert payload['fallback_used'] is True
    assert payload['context_tokens_estimate'] == 1200
    assert payload['tool_result_bytes'] == 3000
    assert payload['cache_read_tokens'] == 600


def test_quota_payload_supports_inherit_unlimited_and_custom_limit():
    assert normalize_quota_payload({'daily_token_quota': None}) == {'daily_token_quota': None}
    assert normalize_quota_payload({'daily_token_quota': '0'}) == {'daily_token_quota': 0}
    assert normalize_quota_payload({'daily_token_quota': '100000'}) == {'daily_token_quota': 100000}
    with pytest.raises(AgentValidationError):
        normalize_quota_payload({})
    with pytest.raises(AgentValidationError):
        normalize_quota_payload({'daily_token_quota': -1})


def test_pat_expiry_is_bounded():
    with pytest.raises(AgentValidationError):
        normalize_pat_payload({'name': 'too-long', 'expires_days': 3651})


def test_pat_payload_supports_runtime_scopes_and_note():
    payload = normalize_pat_payload({
        'name': 'CLI', 'token_type': 'personal', 'scopes': ['chat', 'profile', 'chat'],
        'note': 'release pipeline', 'expires_days': '90',
    })
    assert payload['token_type'] == 'personal'
    assert payload['scopes'] == ['chat', 'profile']
    assert payload['note'] == 'release pipeline'
    with pytest.raises(AgentValidationError):
        normalize_pat_payload({'scopes': ['admin']})
    with pytest.raises(AgentValidationError):
        normalize_pat_payload({'token_type': 'automation'})


def test_pat_payload_defaults_to_only_runtime_scopes():
    assert normalize_pat_payload({'name': 'CLI'})['scopes'] == ['chat', 'profile']


def test_pat_payload_defaults_to_permanent_expiry():
    assert normalize_pat_payload({'name': 'CLI'})['expires_days'] is None
    assert normalize_pat_payload({'name': 'CLI', 'expires_days': ''})['expires_days'] is None


def test_pat_update_payload_only_accepts_name_and_expiry():
    assert normalize_pat_update_payload({'name': 'Cursor', 'expires_days': '30'}) == {
        'name': 'Cursor', 'expires_days': 30,
    }
    assert normalize_pat_update_payload({'name': 'Cursor', 'expires_days': ''}) == {
        'name': 'Cursor', 'expires_days': None,
    }
    with pytest.raises(AgentValidationError):
        normalize_pat_update_payload({'name': ' '})
    with pytest.raises(AgentValidationError):
        normalize_pat_update_payload({'name': 'Cursor', 'expires_days': 3651})


def test_route_payload_supports_fallback_and_description():
    payload = normalize_route_payload({
        'model_name': 'coati-coding', 'description': '团队默认路由',
        'fallback_enabled': 'true', 'enabled': True,
    })
    assert payload['fallback_enabled'] is True
    assert payload['description'] == '团队默认路由'


@pytest.mark.parametrize(('status', 'message'), [
    ('confirmed', '该登录请求已确认，请返回发起登录的应用继续'),
    ('consumed', '该登录请求已经完成，无需重复授权'),
    ('expired', '用户码已过期，请重新发起登录'),
    ('unknown', '当前登录请求无法确认，请重新发起登录'),
])
def test_device_status_is_presented_in_chinese(status, message):
    assert device_confirmation_message(status) == message


def test_agent_timestamp_serialization_marks_naive_database_values_as_utc():
    assert utc_iso(datetime(2026, 8, 20, 13, 50, 41)) == '2026-08-20T13:50:41Z'


def test_agent_daily_quota_uses_shanghai_natural_day_boundary():
    now = datetime(2026, 8, 20, 21, 29, tzinfo=timezone.utc)  # 上海时间次日 05:29
    assert local_day_start_utc(now) == datetime(2026, 8, 20, 16, 0)


def test_agent_trend_bucket_contains_business_timezone_offset():
    assert local_bucket_iso(datetime(2026, 8, 21, 5, 0)) == '2026-08-21T05:00:00+08:00'


def test_bootstrap_advertises_desktop_update_feed():
    payload = build_agent_bootstrap({
        'AGENT_PUBLIC_API_BASE': 'https://api.example',
        'AGENT_DESKTOP_UPDATE_URL': 'https://cdn.example/coati',
        'AGENT_PLUGIN_ALLOWLIST': '@coati/one, @coati/two',
        'AGENT_MIN_CLI_VERSION': '1.2.0',
    }, ['deepseek-v4-pro'], {'used_tokens': 10})
    assert payload['desktop_update_url'] == 'https://cdn.example/coati'
    assert payload['plugin_allowlist'] == ['@coati/one', '@coati/two']
    assert 'multimodal_models' not in payload


def test_bootstrap_prefers_company_release_platform_when_configured():
    payload = build_agent_bootstrap({
        'AGENT_DESKTOP_RELEASE_API_BASE': 'https://appv.example',
        'AGENT_DESKTOP_RELEASE_IDENTIFIER': 'cn.net.coatiode',
    }, [], {}, gateway={'status': 'no_credentials', 'message': '未配置模型账号'})
    assert payload['desktop_update'] == {
        'provider': 'company-release',
        'feed_url': '/api/agent/desktop-updates/{platform}',
    }
    assert payload['gateway']['status'] == 'no_credentials'
