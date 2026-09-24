# -*- coding: utf-8 -*-
"""LLM 网关行为回归测试。

覆盖 AgentGatewayService 的模型路由解析、fallback 链、配额预扣与限额注入、
流式/非流式记账、错误分类与重试、凭据健康标记，以及 usage / credential /
route 服务的核心边界。沿用 test_agent_flow_safety.py 的 sqlite in-memory 模式。
注意：所有 DB 操作需在同一个 app context 内完成（Flask-SQLAlchemy 会话按
app context 作用域隔离）。
"""

import io
import json
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace
from urllib import error as urlerror

import pytest
from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text

from backend.app.agent.model import build_agent_models
from backend.app.agent.service import credential_service
from backend.app.agent.service import model_profile_catalog
from backend.app.agent.service import provider_adapters
from backend.app.agent.service.credential_crypto import encrypt_api_key
from backend.app.agent.service.credential_service import AgentCredentialError, AgentCredentialService
from backend.app.agent.service.gateway_service import (
    AgentGatewayError, AgentGatewayService, classify_connection_error, classify_upstream_http,
    context_metadata, request_trace_metadata, urlopen_with_transient_retry,
)
from backend.app.agent.service.gateway_service import urlrequest as gateway_urlrequest
from backend.app.agent.service.protocol_bridge import ProtocolBridgeError
from backend.app.agent.service.route_service import AgentRouteError, AgentRouteService
from backend.app.agent.service.server_tools import WEB_SEARCH_SUPPORT
from backend.app.agent.service.session_affinity_service import AgentSessionAffinityService
from backend.app.agent.service.usage_service import AgentUsageError, AgentUsageService


@pytest.fixture()
def agent_db():
    app = Flask(__name__)
    app.config.update(
        SQLALCHEMY_DATABASE_URI='sqlite://',
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        AGENT_DAILY_TOKEN_QUOTA=100,
        AGENT_QUOTA_DEFAULT_MAX_OUTPUT_TOKENS=2048,
        AGENT_TIMEZONE='Asia/Shanghai',
        AGENT_CREDENTIAL_ENCRYPTION_KEY='test-only-encryption-key',
        AGENT_CREDENTIAL_FAILURE_THRESHOLD=3,
        AGENT_CREDENTIAL_COOLDOWN_SECONDS=60,
        AGENT_CREDENTIAL_UNHEALTHY_RETRY_SECONDS=300,
        AGENT_GATEWAY_MAX_ATTEMPTS=3,
        AGENT_LITELLM_AUTO_SYNC_ENABLED=False,
    )
    db = SQLAlchemy(app)

    class Admin(db.Model):
        __tablename__ = 'admin_users'
        id = db.Column(db.Integer, primary_key=True)
        username = db.Column(db.String(100), nullable=False)

        def to_dict(self):
            return {'id': self.id, 'username': self.username}

    models = {'Admin': Admin, **build_agent_models(db)}
    # 服务端工具的观测结果是进程级的，账号 id 在各用例间会重复，必须清干净。
    WEB_SEARCH_SUPPORT.clear()
    with app.app_context():
        db.create_all()
        db.session.add(Admin(id=1, username='tester'))
        db.session.commit()
        yield app, db, models
        db.session.remove()
    WEB_SEARCH_SUPPORT.clear()


# ─── 测试辅助 ──────────────────────────────────────────────────────────────────

def _add_credential(
    db, models, *, name=None, provider='deepseek', base_url='https://api.deepseek.com',
    upstream_protocol='openai-chat',
    priority=100, weight=100, enabled=True, models_json=None, cooldown_until=None,
    default_model='deepseek-v4-pro', scope='platform', owner_user_id=None,
    model_prefix='', extra_headers_json=None, model_capabilities_json=None,
):
    """写入一条 AgentLlmCredential（api_key 按生产方式加密存储）。"""
    row = models['AgentLlmCredential'](
        name=name or f'cred-{uuid.uuid4().hex[:6]}',
        provider=provider,
        upstream_protocol=upstream_protocol,
        base_url=base_url,
        api_key=encrypt_api_key(f'sk-test-{uuid.uuid4().hex[:8]}'),
        api_key_hint='sk…test',
        key_fingerprint=f'fp-{uuid.uuid4().hex}',
        models_json=models_json or '["deepseek-v4-pro", "deepseek-v4-flash"]',
        model_capabilities_json=model_capabilities_json or '{}',
        tags_json='[]',
        default_model=default_model,
        priority=priority,
        weight=weight,
        request_timeout_seconds=30,
        enabled=enabled,
        cooldown_until=cooldown_until,
        scope=scope,
        owner_user_id=owner_user_id,
        model_prefix=model_prefix or '',
        extra_headers_json=extra_headers_json or '{}',
    )
    db.session.add(row)
    db.session.commit()
    return row


def _add_route(db, models, *, model_name, credential_id=None, upstream_model=None,
               vision_model=None, fallback_enabled=False, enabled=True):
    row = models['AgentRouteConfig'](
        model_name=model_name,
        credential_id=credential_id,
        upstream_model=upstream_model,
        vision_model=vision_model,
        fallback_enabled=fallback_enabled,
        enabled=enabled,
        weight=100,
    )
    db.session.add(row)
    db.session.commit()
    return row


class FakeUpstreamResponse:
    """模拟 urlopen 返回的上游响应；同时兼容流式 read(size) 与非流式 read()。"""

    def __init__(self, chunks, headers=None):
        self._chunks = list(chunks)
        self.headers = headers or {'Content-Type': 'application/json'}
        self.closed = False

    def read(self, size=None):
        if not self._chunks:
            return b''
        if size is None:
            data = b''.join(self._chunks)
            self._chunks = []
            return data
        return self._chunks.pop(0)

    def close(self):
        self.closed = True


def _ok_json(usage=None, content='Hi'):
    return json.dumps({
        'id': 'chatcmpl-test',
        'object': 'chat.completion',
        'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': content}}],
        'usage': usage or {'prompt_tokens': 10, 'completion_tokens': 20},
    }).encode('utf-8')


def _gateway(db, models):
    return AgentGatewayService(db, models)


def _user():
    return SimpleNamespace(id=1, username='tester')


# ─── resolve_routes：路由解析 ──────────────────────────────────────────────────

def test_resolve_routes_caps_attempts_by_config(agent_db):
    app, _db, _models = agent_db
    app.config['AGENT_GATEWAY_MAX_ATTEMPTS'] = 2
    creds = [
        SimpleNamespace(
            id=i, provider='deepseek', base_url=f'https://api.deepseek.com/{i}',
            default_model='deepseek-v4-pro', request_timeout_seconds=30,
        )
        for i in range(1, 6)
    ]

    class Credentials:
        def candidates(self, **kwargs):
            return creds

        @staticmethod
        def secret(row):
            return f'key-{row.id}'

    service = AgentGatewayService.__new__(AgentGatewayService)
    service.route_crud = SimpleNamespace(get_enabled_by_model=lambda _: None)
    service.credential_crud = SimpleNamespace(get=lambda _: None)
    service.credentials = Credentials()
    with app.app_context():
        resolved = service.resolve_routes(None)
    assert len(resolved) == 2


def test_resolve_routes_uses_separate_selection_pool(agent_db):
    app, _db, _models = agent_db
    app.config['AGENT_GATEWAY_MAX_ATTEMPTS'] = 2
    app.config['AGENT_GATEWAY_SELECTION_POOL_SIZE'] = 7
    calls = []
    creds = [
        SimpleNamespace(
            id=i, provider='deepseek', base_url=f'https://api.deepseek.com/{i}',
            default_model='deepseek-v4-pro', request_timeout_seconds=30,
        )
        for i in range(1, 8)
    ]

    class Credentials:
        def candidates(self, **kwargs):
            calls.append(kwargs)
            return creds

        @staticmethod
        def secret(row):
            return f'key-{row.id}'

    service = AgentGatewayService.__new__(AgentGatewayService)
    service.route_crud = SimpleNamespace(get_enabled_by_model=lambda _: None)
    service.credential_crud = SimpleNamespace(get=lambda _: None)
    service.credentials = Credentials()
    with app.app_context():
        resolved = service.resolve_routes(None)
    assert len(resolved) == 2
    assert calls[0]['limit'] == 7


def test_session_affinity_smooth_order_considers_active_requests():
    candidates = [
        SimpleNamespace(id=1, priority=100, weight=100),
        SimpleNamespace(id=2, priority=100, weight=100),
    ]
    ordered = AgentSessionAffinityService._smooth_order(
        candidates,
        {'counts': {1: 0, 2: 0}, 'last_credential_id': None},
        {1: 2, 2: 0},
    )
    assert [row.id for row in ordered] == [2, 1]


def test_new_session_order_uses_global_binding_load(agent_db):
    """不同用户的新会话不能都因各自负载为 0 而命中同一个账号。"""
    app, db, models = agent_db
    with app.app_context():
        first = _add_credential(db, models, name='first')
        second = _add_credential(db, models, name='second')
        service = AgentSessionAffinityService(db, models)
        model_key = 'pool:deepseek-v4-pro:deepseek-v4-pro'
        first_context = service.resolve(1, 'user-one-session', model_key)
        service.bind(first_context, first.id)

        second_context = service.resolve(2, 'user-two-session', model_key)
        ordered = service.order_initial_candidates(
            second_context,
            [first, second],
        )

    assert [row.id for row in ordered] == [second.id, first.id]


def test_session_affinity_binding_is_first_writer_wins(agent_db):
    app, db, models = agent_db
    with app.app_context():
        service = AgentSessionAffinityService(db, models)
        context = service.resolve(1, 'session-race', 'pool:deepseek-v4-pro:deepseek-v4-pro')
        first = service.bind(context, 11)
        second = service.bind(context, 22)

    assert first.credential_id == 11
    assert second.credential_id == 11
    with app.app_context():
        row = models['AgentSessionAffinity'].query.one()
        assert row.credential_id == 11


def test_session_affinity_uses_existing_concurrent_binding_before_upstream(agent_db):
    app, _db, _models = agent_db
    service = AgentGatewayService.__new__(AgentGatewayService)
    service._bind_route_session = lambda _route: SimpleNamespace(credential_id=1)
    routes = [
        {'credential_id': 2, '_session_affinity': {'hit': False}},
        {'credential_id': 1, '_session_affinity': {'hit': False}},
    ]

    with app.app_context():
        resolved = service._canonicalize_session_routes(
            routes,
            lookup_model='deepseek-v4-pro',
            display_model=None,
            upstream_override=None,
            user=_user(),
            session_id='session-race',
        )

    assert [route['credential_id'] for route in resolved] == [1, 2]


def test_usage_active_credential_loads_counts_recent_reserved_requests(agent_db):
    app, db, models = agent_db
    with app.app_context():
        db.session.add_all([
            models['AgentUsageEvent'](
                request_id='req-active-1', user_id=1, credential_id=7,
                model='m', status='reserved', created_at=datetime.utcnow(),
            ),
            models['AgentUsageEvent'](
                request_id='req-active-2', user_id=1, credential_id=7,
                model='m', status='reserved', created_at=datetime.utcnow(),
            ),
            models['AgentUsageEvent'](
                request_id='req-done', user_id=1, credential_id=7,
                model='m', status='ok', created_at=datetime.utcnow(),
            ),
        ])
        db.session.commit()
        loads = AgentUsageService(db, models).active_credential_loads([7, 8])
    assert loads == {7: 2}


def test_reserve_without_quota_creates_cross_worker_activity_record(agent_db):
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 0
    with app.app_context():
        service = AgentUsageService(db, models)
        reservation = service.reserve_quota(
            1, 'req-unlimited-active',
            {'messages': [{'role': 'user', 'content': 'hello'}], 'max_tokens': 32},
            'deepseek-v4-pro',
        )
        assert reservation['completion_limit'] is None
        assert service.bind_credential('req-unlimited-active', 9) is True
        row = models['AgentUsageEvent'].query.filter_by(
            request_id='req-unlimited-active',
        ).one()
        assert row.status == 'reserved'
        assert row.credential_id == 9
        assert service.active_credential_loads([9]) == {9: 1}


def test_resolve_routes_503_when_only_unavailable_adapters(agent_db):
    app, _db, _models = agent_db
    reserved = SimpleNamespace(
        id=1, provider='gemini', base_url='https://generativelanguage.googleapis.com',
        default_model='claude', request_timeout_seconds=30,
    )

    class Credentials:
        def candidates(self, **kwargs):
            return [reserved]

        @staticmethod
        def secret(row):
            return 'key'

    service = AgentGatewayService.__new__(AgentGatewayService)
    service.route_crud = SimpleNamespace(get_enabled_by_model=lambda _: None)
    service.credential_crud = SimpleNamespace(get=lambda _: None)
    service.credentials = Credentials()
    with app.app_context():
        with pytest.raises(AgentGatewayError) as exc_info:
            service.resolve_routes(None)
    assert exc_info.value.status_code == 503
    assert '尚未启用' in exc_info.value.message


def test_resolve_routes_wraps_bound_credential_failure_as_gateway_error(agent_db):
    app, _db, _models = agent_db
    route = SimpleNamespace(
        id=9, credential_id=99, fallback_enabled=False,
        upstream_model=None, upstream_base=None,
    )

    class Credentials:
        def candidates(self, **kwargs):
            if kwargs.get('credential_id'):
                raise AgentCredentialError('指定的模型账号不可用', 503)
            raise AssertionError('不应走到自动选择分支')

        @staticmethod
        def secret(row):
            return 'key'

    service = AgentGatewayService.__new__(AgentGatewayService)
    service.route_crud = SimpleNamespace(get_enabled_by_model=lambda _: route)
    service.credential_crud = SimpleNamespace(get=lambda _: None)
    service.credentials = Credentials()
    with app.app_context():
        with pytest.raises(AgentGatewayError) as exc_info:
            service.resolve_routes('coati-coding')
    assert exc_info.value.status_code == 503
    assert '指定的模型账号不可用' in exc_info.value.message


def test_resolve_routes_uses_env_credential_when_configured(agent_db):
    app, db, models = agent_db
    app.config['AGENT_LLM_KEY'] = 'sk-env'
    app.config['AGENT_LLM_BASE'] = 'https://env.example'
    app.config['AGENT_LLM_MODEL'] = 'deepseek-v4-pro'
    with app.app_context():
        resolved = _gateway(db, models).resolve_routes(None)
    assert len(resolved) == 1
    assert resolved[0]['base'] == 'https://env.example'
    assert resolved[0]['key'] == 'sk-env'
    assert resolved[0]['model'] == 'deepseek-v4-pro'


# ─── chat_completions：非流式 ─────────────────────────────────────────────────

def test_chat_completions_success_records_usage_and_health(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['request'] = request
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        cred = _add_credential(db, models, priority=200)
        parsed, http_status, request_id = _gateway(db, models).chat_completions(
            _user(), {'messages': [{'role': 'user', 'content': 'hello'}]},
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
        cred_row = db.session.get(models['AgentLlmCredential'], cred.id)

    assert http_status == 200
    assert parsed['choices'][0]['message']['content'] == 'Hi'
    assert parsed['usage']['completion_tokens'] == 20
    assert request_id.startswith('req_')
    # 发给上游的请求必须带上实际模型名
    payload = json.loads(captured['request'].data.decode('utf-8'))
    assert payload['model'] == 'deepseek-v4-pro'
    assert row.status == 'ok'
    assert row.total_tokens == 30
    assert row.prompt_tokens == 10
    assert row.completion_tokens == 20
    assert row.http_status == 200
    assert row.attempt_count == 1
    assert row.fallback_used is False
    assert row.credential_id == cred.id
    assert row.model == 'deepseek-v4-pro'
    assert row.cache_read_tokens is None
    assert row.cache_write_tokens is None
    assert row.cache_miss_tokens is None
    assert cred_row.health_status == 'healthy'
    assert cred_row.consecutive_failures == 0


def test_chat_completions_records_context_shape_and_client_trace_headers(agent_db, monkeypatch):
    app, db, models = agent_db
    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda request, timeout=None: FakeUpstreamResponse([
            _ok_json(usage={
                'prompt_tokens': 100,
                'completion_tokens': 20,
                'prompt_cache_hit_tokens': 70,
                'prompt_cache_miss_tokens': 30,
            }),
        ]),
    )
    with app.app_context():
        _add_credential(db, models, priority=200)
        _parsed, _status, request_id = _gateway(db, models).chat_completions(
            _user(),
            {
                'messages': [
                    {'role': 'system', 'content': 'system'},
                    {'role': 'user', 'content': 'secret prompt'},
                    {'role': 'tool', 'content': 'large tool result'},
                ],
                'tools': [{'type': 'function', 'function': {'name': 'lookup'}}],
            },
            request_headers={
                'X-COATI-Session-ID': 'sess_test',
                'X-COATI-Request-ID': 'logical_test',
                'X-COATI-Step': '7',
                'X-COATI-Retry': '1',
            },
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()

    assert row.session_id == 'sess_test'
    assert row.client_request_id == 'logical_test'
    assert row.step_index == 7
    assert row.retry_index == 1
    assert row.context_tokens_estimate > 0
    assert row.context_bytes > 0
    assert row.message_count == 3
    assert row.tool_count == 1
    assert row.tool_result_bytes > 0
    assert row.largest_message_bytes >= row.tool_result_bytes
    assert row.cache_read_tokens == 70
    assert row.cache_miss_tokens == 30
    assert not hasattr(row, 'prompt')


def test_context_metadata_counts_nested_anthropic_and_responses_tool_results(agent_db):
    app, _db, _models = agent_db

    class UsageStub:
        @staticmethod
        def estimate_tokens(value):
            return len(json.dumps(value, ensure_ascii=False))

    with app.app_context():
        anthropic = context_metadata({
            'messages': [{
                'role': 'user',
                'content': [{
                    'type': 'tool_result', 'tool_use_id': 'tool_1',
                    'content': [{'type': 'text', 'text': 'search result'}],
                }],
            }],
        }, UsageStub())
        responses = context_metadata({
            'input': [{
                'type': 'function_call_output', 'call_id': 'call_1',
                'output': 'search result',
            }],
        }, UsageStub())

    assert anthropic['tool_result_bytes'] > 0
    assert responses['tool_result_bytes'] > 0


def test_anthropic_history_keeps_server_tool_result_observability(agent_db, monkeypatch):
    app, db, models = agent_db

    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda request, timeout=None: FakeUpstreamResponse([
            json.dumps({
                'id': 'msg-history', 'type': 'message', 'role': 'assistant',
                'content': [{'type': 'text', 'text': '继续回答'}],
                'stop_reason': 'end_turn',
                'usage': {'input_tokens': 20, 'output_tokens': 4},
            }).encode('utf-8'),
        ]),
    )

    with app.app_context():
        _add_credential(
            db, models, provider='openai-compatible',
            base_url='https://relay.example',
            upstream_protocol='anthropic-messages',
            models_json='["qwen3.8-flash"]', default_model='qwen3.8-flash',
        )
        _payload, status, request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': 'qwen3.8-flash', 'max_tokens': 64,
                'messages': [
                    {
                        'role': 'assistant',
                        'content': [{
                            'type': 'server_tool_use', 'id': 'srvtoolu_old',
                            'name': 'web_search', 'input': {'query': 'old query'},
                        }],
                    },
                    {
                        'role': 'user',
                        'content': [{
                            'type': 'web_search_tool_result',
                            'tool_use_id': 'srvtoolu_old',
                            'content': [{'type': 'web_search_result',
                                         'url': 'https://a.io', 'title': 'A'}],
                        }],
                    },
                ],
            },
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()

    assert status == 200
    assert row.tool_result_bytes > 0


def test_request_trace_metadata_recognizes_common_session_signals(agent_db):
    app, _db, _models = agent_db
    with app.app_context():
        header_metadata = request_trace_metadata(
            {'Session_id': 'codex-session'},
            {'prompt_cache_key': 'body-session'},
        )
        assert header_metadata['session_id'] == 'codex-session'
        assert header_metadata['session_source'] == 'header'
        body_metadata = request_trace_metadata(
            {}, {'prompt_cache_key': 'prompt-cache-session'},
        )
        assert body_metadata['session_id'] == 'prompt-cache-session'
        assert body_metadata['session_source'] == 'body'
        assert request_trace_metadata(
            {}, {'conversation': {'id': 'conversation-session'}},
        )['session_id'] == 'conversation-session'


def test_request_trace_metadata_message_fingerprint_is_stable_and_opaque(agent_db):
    app, _db, _models = agent_db
    first = {
        'messages': [
            {'role': 'system', 'content': 'system rules'},
            {'role': 'user', 'content': 'private initial prompt'},
        ],
    }
    continued = {
        'messages': [
            *first['messages'],
            {'role': 'assistant', 'content': 'answer'},
            {'role': 'user', 'content': 'follow-up'},
        ],
    }
    with app.app_context():
        first_metadata = request_trace_metadata({}, first)
        continued_metadata = request_trace_metadata({}, continued)

    first_id = first_metadata['session_id']
    continued_id = continued_metadata['session_id']
    assert first_id == continued_id
    assert first_id.startswith('msg_')
    assert first_metadata['session_source'] == 'fingerprint'
    assert continued_metadata['session_source'] == 'fingerprint'
    assert 'private initial prompt' not in first_id


def test_personal_candidates_without_session_use_weighted_order(agent_db, monkeypatch):
    app, _db, _models = agent_db
    candidates = [
        SimpleNamespace(id=1, priority=100, weight=100),
        SimpleNamespace(id=2, priority=100, weight=100),
    ]
    service = AgentGatewayService.__new__(AgentGatewayService)
    service._active_credential_loads = lambda _ids, **_kwargs: {}
    monkeypatch.setattr(
        credential_service.random,
        'choices',
        lambda choices, weights, k: [choices[-1]],
    )
    with app.app_context():
        ordered = service._order_personal_candidates(candidates)
    assert [row.id for row in ordered] == [2, 1]


def test_session_affinity_keeps_same_credential_when_pool_order_changes(agent_db, monkeypatch):
    app, db, models = agent_db
    captured_hosts = []
    binding_seen_during_request = []

    def fake_urlopen(request, timeout=None):
        captured_hosts.append(request.host)
        binding_seen_during_request.append(models['AgentSessionAffinity'].query.one().credential_id)
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        first = _add_credential(db, models, base_url='https://first.example')
        second = _add_credential(db, models, base_url='https://second.example')
        orders = [[first.id, second.id], [second.id, first.id]]

        def changing_order(rows, affinity_key, limit=None):
            by_id = {row.id: row for row in rows}
            order = orders.pop(0)
            result = [by_id[item] for item in order if item in by_id]
            return result if limit is None else result[:limit]

        monkeypatch.setattr(
            AgentCredentialService, '_weighted_rendezvous_order', staticmethod(changing_order),
        )
        for _ in range(2):
            _gateway(db, models).chat_completions(
                _user(),
                {
                    'model': 'deepseek-v4-pro',
                    'messages': [{'role': 'user', 'content': 'hello'}],
                },
                request_headers={'X-COATI-Session-ID': 'session-sticky'},
            )
        binding = models['AgentSessionAffinity'].query.one()
        first_id = first.id

    assert captured_hosts == ['first.example', 'first.example']
    assert binding_seen_during_request == [first_id, first_id]
    assert binding.credential_id == first_id


def test_new_sessions_spread_before_sticky_binding(agent_db, monkeypatch):
    app, db, models = agent_db
    captured_hosts = []

    def fake_urlopen(request, timeout=None):
        captured_hosts.append(request.host)
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        first = _add_credential(db, models, base_url='https://first.example')
        second = _add_credential(db, models, base_url='https://second.example')
        first_id = first.id
        second_id = second.id
        service = _gateway(db, models)
        for session_id in ('session-spread-1', 'session-spread-2'):
            service.chat_completions(
                _user(),
                {
                    'model': 'deepseek-v4-pro',
                    'messages': [{'role': 'user', 'content': session_id}],
                },
                request_headers={'X-COATI-Session-ID': session_id},
            )

    assert captured_hosts == ['first.example', 'second.example']
    assert first_id != second_id


def test_session_affinity_rebinds_after_retryable_failure(agent_db, monkeypatch):
    app, db, models = agent_db
    captured_hosts = []
    observed_credential_ids = []

    def fake_urlopen(request, timeout=None):
        captured_hosts.append(request.host)
        observed_credential_ids.append(
            models['AgentUsageEvent'].query.filter_by(status='reserved').one().credential_id,
        )
        if len(captured_hosts) == 2:
            raise urlerror.HTTPError(
                request.full_url, 500, 'Internal Server Error',
                {}, io.BytesIO(b'{"error":"upstream down"}'),
            )
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        first = _add_credential(db, models, base_url='https://first.example')
        second = _add_credential(db, models, base_url='https://second.example')
        first_id = first.id
        second_id = second.id
        orders = [
            [first.id, second.id],
            [second.id, first.id],
            [first.id, second.id],
        ]

        def changing_order(rows, affinity_key, limit=None):
            by_id = {row.id: row for row in rows}
            order = orders.pop(0)
            result = [by_id[item] for item in order if item in by_id]
            return result if limit is None else result[:limit]

        monkeypatch.setattr(
            AgentCredentialService, '_weighted_rendezvous_order', staticmethod(changing_order),
        )
        for _ in range(3):
            _gateway(db, models).chat_completions(
                _user(),
                {
                    'model': 'deepseek-v4-pro',
                    'messages': [{'role': 'user', 'content': 'hello'}],
                },
                request_headers={'X-COATI-Session-ID': 'session-failover'},
            )
        binding = models['AgentSessionAffinity'].query.one()

    assert captured_hosts == [
        'first.example', 'first.example', 'second.example', 'second.example',
    ]
    assert observed_credential_ids == [first_id, first_id, second_id, second_id]
    assert binding.credential_id == second_id


def test_chat_completions_records_pat_and_list_summarizes_usage(agent_db, monkeypatch):
    from flask import g
    from backend.app.agent.service.auth_service import AgentAuthService
    from backend.app.agent.service.bearer import hash_token

    app, db, models = agent_db
    monkeypatch.setattr(gateway_urlrequest, 'urlopen', lambda *args, **kwargs: FakeUpstreamResponse([_ok_json()]))
    with app.app_context():
        _add_credential(db, models, priority=200)
        pat = models['AgentPat'](
            user_id=1, name='cursor', token_type='personal',
            token_prefix='coati_test', token_hash=hash_token('coati_test_key'),
        )
        db.session.add(pat)
        db.session.commit()
        pat_id = pat.id
        g.agent_pat = pat
        _parsed, _status, request_id = _gateway(db, models).chat_completions(
            _user(), {'messages': [{'role': 'user', 'content': 'hello'}]},
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
        listed = AgentAuthService(db, models).list_pats(1, token_type='personal')

    assert row.pat_id == pat_id
    assert listed['items'][0]['id'] == pat_id
    assert listed['items'][0]['tokens_7d'] == 30
    assert listed['items'][0]['requests_7d'] == 1


def test_chat_completions_quota_exceeded_returns_429(agent_db, monkeypatch):
    app, db, models = agent_db
    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda request, timeout=None: FakeUpstreamResponse([_ok_json()]),
    )
    with app.app_context():
        _add_credential(db, models, priority=200)
        service = _gateway(db, models)
        _parsed, _status, _request_id = service.chat_completions(
            _user(), {'messages': [{'role': 'user', 'content': 'hello'}], 'max_tokens': 10},
        )
        # 第二条请求提示词超过剩余配额（配额 100，第一条已用掉一部分）
        with pytest.raises(AgentUsageError) as exc_info:
            service.chat_completions(
                _user(), {
                    'messages': [{'role': 'user', 'content': 'x' * 3000}],
                    'max_tokens': 100_000,
                },
            )
        assert exc_info.value.status_code == 429
        assert exc_info.value.payload.get('request_id')
        assert models['AgentUsageEvent'].query.filter_by(status='quota_exceeded').count() == 1


def test_chat_completions_falls_back_on_5xx_and_records_attempts(agent_db, monkeypatch):
    app, db, models = agent_db
    calls = {'n': 0}

    def fake_urlopen(request, timeout=None):
        calls['n'] += 1
        if calls['n'] == 1:
            raise urlerror.HTTPError(
                request.full_url, 500, 'Internal Server Error',
                {}, io.BytesIO(b'{"error":"upstream down"}'),
            )
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        primary = _add_credential(db, models, priority=200)
        fallback = _add_credential(db, models, priority=100)
        parsed, http_status, request_id = _gateway(db, models).chat_completions(
            _user(), {'messages': [{'role': 'user', 'content': 'hello'}]},
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
        primary_row = db.session.get(models['AgentLlmCredential'], primary.id)
        fallback_row = db.session.get(models['AgentLlmCredential'], fallback.id)

    assert http_status == 200
    assert parsed['choices'][0]['message']['content'] == 'Hi'
    assert calls['n'] == 2
    assert row.status == 'ok'
    assert row.attempt_count == 2
    assert row.fallback_used is True
    assert row.credential_id == fallback.id
    assert '账号调用链：' in row.error_summary
    assert primary.name in row.error_summary
    assert fallback.name in row.error_summary
    assert 'HTTP 500' in row.error_summary
    # 主 Key 瞬时 5xx 换号成功，不应记为异常
    assert primary_row.consecutive_failures == 0
    assert primary_row.health_status in ('healthy', 'unknown')
    assert fallback_row.health_status == 'healthy'


def test_classify_connection_error_treats_ssl_eof_as_transient():
    exc = urlerror.URLError(
        '[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1016)',
    )
    transient, text = classify_connection_error(exc)
    assert transient is True
    assert 'UNEXPECTED_EOF' in text


def test_urlopen_with_transient_retry_retries_ssl_eof(agent_db, monkeypatch):
    app, db, models = agent_db
    calls = {'n': 0}

    def fake_urlopen(request, timeout=None):
        calls['n'] += 1
        if calls['n'] == 1:
            raise urlerror.URLError(
                '[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1016)',
            )
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(db, models, priority=200)
        parsed, http_status, _ = _gateway(db, models).chat_completions(
            _user(), {'messages': [{'role': 'user', 'content': 'hello'}]},
        )
    assert http_status == 200
    assert parsed['choices'][0]['message']['content'] == 'Hi'
    assert calls['n'] == 2


def test_urlopen_with_transient_retry_uses_channel_proxy(agent_db, monkeypatch):
    app, _db, _models = agent_db
    captured = {}
    sentinel = object()

    class FakeOpener:
        def open(self, request, timeout=None):
            captured['request'] = request
            captured['timeout'] = timeout
            return sentinel

    def fake_build_opener(handler):
        captured['proxies'] = handler.proxies
        return FakeOpener()

    monkeypatch.setattr(gateway_urlrequest, 'build_opener', fake_build_opener)
    with app.app_context():
        result = urlopen_with_transient_retry(
            object(), timeout=17, proxy_url='http://192.168.1.100:7890',
        )

    assert result is sentinel
    assert captured['timeout'] == 17
    assert captured['proxies'] == {
        'http': 'http://192.168.1.100:7890',
        'https': 'http://192.168.1.100:7890',
    }


def test_chat_completions_ssl_eof_falls_back_without_marking_primary(agent_db, monkeypatch):
    app, db, models = agent_db
    calls = {'n': 0}
    ssl_eof = '[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1016)'

    def fake_urlopen(request, timeout=None):
        calls['n'] += 1
        if calls['n'] <= 2:
            raise urlerror.URLError(ssl_eof)
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        primary = _add_credential(db, models, priority=200)
        fallback = _add_credential(db, models, priority=100)
        parsed, http_status, request_id = _gateway(db, models).chat_completions(
            _user(), {'messages': [{'role': 'user', 'content': 'hello'}]},
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
        primary_row = db.session.get(models['AgentLlmCredential'], primary.id)
        fallback_row = db.session.get(models['AgentLlmCredential'], fallback.id)

    assert http_status == 200
    assert parsed['choices'][0]['message']['content'] == 'Hi'
    assert calls['n'] == 3
    assert row.fallback_used is True
    assert row.credential_id == fallback.id
    assert primary_row.consecutive_failures == 0
    assert primary_row.health_status in ('healthy', 'unknown')
    assert fallback_row.health_status == 'healthy'


def test_classify_upstream_http_treats_billing_as_immediate_retry():
    assert classify_upstream_http(402, '{"message":"Insufficient Balance"}') == (True, True)
    assert classify_upstream_http(400, '{"message":"Insufficient Balance"}') == (True, True)
    assert classify_upstream_http(400, '{"error":{"message":"bad request"}}') == (False, False)
    assert classify_upstream_http(500, 'upstream down') == (True, False)
    assert classify_upstream_http(429, 'rate limit reached') == (True, False)
    assert classify_upstream_http(
        429, '{"code":"insufficient_quota","message":"Allocated quota exceeded"}',
    ) == (True, False)


def test_chat_completions_single_account_429_passthrough_keeps_retryable(
    agent_db, monkeypatch,
):
    """唯一账号被临时限流时，保留 429 给客户端，下一次重试仍能再次选中它。"""
    app, db, models = agent_db
    calls = {'n': 0}
    rate_limit_body = (
        b'{"code":"insufficient_quota","message":"Allocated quota exceeded",'
        b'"type":"insufficient_quota"}'
    )

    def fake_urlopen(request, timeout=None):
        calls['n'] += 1
        raise urlerror.HTTPError(
            request.full_url, 429, 'Too Many Requests',
            {}, io.BytesIO(rate_limit_body),
        )

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        cred = _add_credential(
            db, models,
            name='qwen-single-account',
            provider='openai-compatible',
            base_url='https://dashscope.example/apps/anthropic',
            default_model='qwen3.8-flash',
            models_json='["qwen3.8-flash"]',
        )
        service = _gateway(db, models)
        request_headers = {'X-COATI-Session-ID': 'qwen-retry-session'}
        first, first_status, first_request_id = service.chat_completions(
            _user(),
            {'model': 'qwen3.8-flash', 'messages': [{'role': 'user', 'content': 'hello'}]},
            request_headers=request_headers,
        )
        second, second_status, second_request_id = service.chat_completions(
            _user(),
            {'model': 'qwen3.8-flash', 'messages': [{'role': 'user', 'content': 'retry'}]},
            request_headers=request_headers,
        )
        db.session.expire_all()
        fresh = db.session.get(models['AgentLlmCredential'], cred.id)

    assert first_status == 429
    assert second_status == 429
    assert first['code'] == 'insufficient_quota'
    assert second['code'] == 'insufficient_quota'
    assert first_request_id != second_request_id
    assert calls['n'] == 2
    assert fresh.cooldown_until is None
    assert fresh.consecutive_failures == 0
    assert fresh.last_error_at is not None


def test_chat_completions_falls_back_on_402_and_cools_down_empty_key(agent_db, monkeypatch):
    app, db, models = agent_db
    calls = {'n': 0}
    empty_body = b'{"code":"invalid_request_error","message":"Insufficient Balance","type":"unknown_error"}'

    def fake_urlopen(request, timeout=None):
        calls['n'] += 1
        if calls['n'] == 1:
            raise urlerror.HTTPError(
                request.full_url, 402, 'Payment Required',
                {}, io.BytesIO(empty_body),
            )
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        primary = _add_credential(db, models, priority=200)
        fallback = _add_credential(db, models, priority=100)
        parsed, http_status, request_id = _gateway(db, models).chat_completions(
            _user(), {'messages': [{'role': 'user', 'content': 'hello'}]},
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
        primary_row = db.session.get(models['AgentLlmCredential'], primary.id)
        fallback_row = db.session.get(models['AgentLlmCredential'], fallback.id)

    assert http_status == 200
    assert parsed['choices'][0]['message']['content'] == 'Hi'
    assert calls['n'] == 2
    assert row.status == 'ok'
    assert row.attempt_count == 2
    assert row.fallback_used is True
    assert row.credential_id == fallback.id
    assert primary_row.consecutive_failures == 1
    assert primary_row.health_status == 'cooldown'
    assert primary_row.cooldown_until is not None
    assert primary_row.cooldown_until > datetime.utcnow() + timedelta(minutes=20)
    assert fallback_row.health_status == 'healthy'


def test_chat_completions_4xx_passthrough_does_not_mark_failure(agent_db, monkeypatch):
    app, db, models = agent_db

    def fake_urlopen(request, timeout=None):
        raise urlerror.HTTPError(
            request.full_url, 400, 'Bad Request',
            {}, io.BytesIO(b'{"error":{"message":"bad request"}}'),
        )

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        cred = _add_credential(db, models, priority=200)
        parsed, http_status, request_id = _gateway(db, models).chat_completions(
            _user(), {'messages': [{'role': 'user', 'content': 'hello'}]},
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
        cred_row = db.session.get(models['AgentLlmCredential'], cred.id)

    assert http_status == 400
    assert parsed['error']['message'] == 'bad request'
    assert row.status == 'upstream_error'
    assert row.http_status == 400
    assert row.attempt_count == 1
    # 4xx 不属于可重试错误，不应污染健康状态
    assert cred_row.consecutive_failures == 0
    assert cred_row.health_status == 'unknown'


def test_chat_completions_raises_after_all_attempts_fail(agent_db, monkeypatch):
    app, db, models = agent_db

    def fake_urlopen(request, timeout=None):
        raise urlerror.URLError('connection refused')

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(db, models, priority=200)
        _add_credential(db, models, priority=100)
        with pytest.raises(AgentGatewayError) as exc_info:
            _gateway(db, models).chat_completions(
                _user(), {'messages': [{'role': 'user', 'content': 'hello'}]},
            )
        rows = models['AgentUsageEvent'].query.all()

    assert exc_info.value.status_code == 502
    assert exc_info.value.payload.get('request_id')
    final = rows[-1]
    assert final.status == 'upstream_error'
    assert final.http_status == 502
    assert final.attempt_count == 2
    assert final.error_summary and '上游不可达' in final.error_summary


def test_chat_completions_applies_completion_limit_from_quota(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['request'] = request
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(db, models, priority=200)
        svc_usage = AgentUsageService(db, models)
        body = {'messages': [{'role': 'user', 'content': 'hello'}], 'max_tokens': 100_000}
        prompt_estimate = svc_usage.estimate_tokens({
            'messages': body['messages'], 'tools': None, 'response_format': None,
        })
        expected_limit = 100 - prompt_estimate  # 配额 100 减去提示词预估值
        _gateway(db, models).chat_completions(_user(), body)

    payload = json.loads(captured['request'].data.decode('utf-8'))
    assert payload['max_tokens'] == expected_limit
    assert payload['max_tokens'] < 100_000


def test_chat_completions_routing_error_when_no_credentials(agent_db, monkeypatch):
    app, db, models = agent_db
    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda request, timeout=None: FakeUpstreamResponse([_ok_json()]),
    )
    with app.app_context():
        with pytest.raises(AgentGatewayError) as exc_info:
            _gateway(db, models).chat_completions(
                _user(), {'messages': [{'role': 'user', 'content': 'hello'}]},
            )
        assert exc_info.value.status_code == 503
        assert exc_info.value.payload.get('request_id')
        row = models['AgentUsageEvent'].query.filter_by(status='routing_error').one()
    assert row.error_summary and '未配置模型账号' in row.error_summary


def test_auto_route_uses_coati_auto_binding_not_target_model_route(agent_db, monkeypatch):
    """coati-auto 必须走自己的绑定 Key，不能改写成目标模型名后再找同名路由。"""
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['payload'] = json.loads(request.data.decode('utf-8'))
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    app, db, models = agent_db
    with app.app_context():
        auto_cred = _add_credential(db, models, name='auto-key', priority=100)
        other = _add_credential(db, models, name='other-key', priority=200)
        auto_id = auto_cred.id
        _add_route(
            db, models, model_name='coati-auto', credential_id=auto_id,
            upstream_model='deepseek-v4-pro', vision_model='deepseek-v4-flash',
        )
        _add_route(db, models, model_name='deepseek-v4-pro', credential_id=other.id)
        parsed, http_status, request_id = _gateway(db, models).chat_completions(
            _user(), {'model': 'coati-auto', 'messages': [{'role': 'user', 'content': 'hello'}]},
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()

    assert http_status == 200
    assert parsed['choices'][0]['message']['content'] == 'Hi'
    assert captured['payload']['model'] == 'deepseek-v4-pro'
    assert row.credential_id == auto_id
    assert row.model == 'coati-auto'
    assert row.upstream_model == 'deepseek-v4-pro'


def test_auto_route_image_sends_vision_model(agent_db, monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['payload'] = json.loads(request.data.decode('utf-8'))
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    app, db, models = agent_db
    with app.app_context():
        cred = _add_credential(db, models)
        _add_route(
            db, models, model_name='coati-auto', credential_id=cred.id,
            upstream_model='deepseek-v4-pro', vision_model='deepseek-v4-flash',
        )
        _gateway(db, models).chat_completions(
            _user(), {
                'model': 'coati-auto',
                'messages': [{
                    'role': 'user',
                    'content': [
                        {'type': 'text', 'text': '看图'},
                        {'type': 'image_url', 'image_url': {'url': 'https://example.com/a.png'}},
                    ],
                }],
            },
        )
    assert captured['payload']['model'] == 'deepseek-v4-flash'


def test_auto_route_missing_config_records_routing_error(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(db, models)
        with pytest.raises(AgentGatewayError) as exc_info:
            _gateway(db, models).chat_completions(
                _user(), {'model': 'coati-auto', 'messages': [{'role': 'user', 'content': 'hello'}]},
            )
        assert exc_info.value.status_code == 503
        assert '未配置' in exc_info.value.message
        row = models['AgentUsageEvent'].query.filter_by(status='routing_error').one()
    assert row.model == 'coati-auto'


def test_request_protocol_error_finalizes_reserved_usage(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(
            db, models, upstream_protocol='anthropic-messages',
            models_json='["glm-5"]', default_model='glm-5',
        )
        with pytest.raises(AgentGatewayError, match='多候选') as exc_info:
            _gateway(db, models).chat_completions(
                _user(), {
                    'model': 'glm-5', 'n': 2, 'max_tokens': 16,
                    'messages': [{'role': 'user', 'content': 'hello'}],
                },
            )
        row = models['AgentUsageEvent'].query.filter_by(
            request_id=exc_info.value.payload['request_id'],
        ).one()
        reserved_count = models['AgentUsageEvent'].query.filter_by(status='reserved').count()

    assert exc_info.value.status_code == 400
    assert row.status == 'protocol_error'
    assert '多候选' in row.error_summary
    assert reserved_count == 0


# ─── chat_completions：流式 ────────────────────────────────────────────────────

def test_chat_completions_streaming_records_usage_from_sse(agent_db, monkeypatch):
    app, db, models = agent_db
    chunks = [
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n'.encode('utf-8'),
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n'.encode('utf-8'),
        b'data: {"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\n',
        b'data: [DONE]\n\n',
    ]
    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda request, timeout=None: FakeUpstreamResponse(
            chunks, headers={'Content-Type': 'text/event-stream'},
        ),
    )
    with app.app_context():
        with app.test_request_context():
            cred = _add_credential(db, models, priority=200)
            response = _gateway(db, models).chat_completions(
                _user(), {'messages': [{'role': 'user', 'content': 'hello'}], 'stream': True},
            )
            data = response.get_data()
            request_id = response.headers.get('X-Agent-Request-Id')
            cred_id = cred.id
            row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()

    assert '你'.encode('utf-8') in data
    assert '好'.encode('utf-8') in data
    assert request_id.startswith('req_')
    assert row.status == 'ok'
    assert row.prompt_tokens == 3
    assert row.completion_tokens == 5
    assert row.total_tokens == 8
    assert row.cache_read_tokens is None
    assert row.cache_write_tokens is None
    assert row.cache_miss_tokens is None
    assert row.http_status == 200
    assert row.credential_id == cred_id


def test_chat_completions_streaming_keeps_utf8_split_across_chunks(agent_db, monkeypatch):
    """上游按 TCP 切片时可能切断多字节汉字；不能 errors=replace 成 U+FFFD。"""
    app, db, models = agent_db
    char = '码'.encode('utf-8')
    chunks = [
        b'data: {"choices":[{"delta":{"content":"' + char[:1],
        char[1:] + b'"}}]}\n\n',
        b'data: [DONE]\n\n',
    ]
    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda request, timeout=None: FakeUpstreamResponse(
            chunks, headers={'Content-Type': 'text/event-stream'},
        ),
    )
    with app.app_context():
        with app.test_request_context():
            _add_credential(db, models)
            response = _gateway(db, models).chat_completions(
                _user(), {'messages': [{'role': 'user', 'content': 'hello'}], 'stream': True},
            )
            data = response.get_data()
    assert '码'.encode('utf-8') in data
    assert b'\xef\xbf\xbd' not in data


def test_chat_completions_streaming_client_disconnect_records_client_error(agent_db, monkeypatch):
    app, db, models = agent_db
    chunks = [
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n'.encode('utf-8'),
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n'.encode('utf-8'),
    ]
    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda request, timeout=None: FakeUpstreamResponse(
            chunks, headers={'Content-Type': 'text/event-stream'},
        ),
    )
    with app.app_context():
        with app.test_request_context():
            _add_credential(db, models, priority=200)
            response = _gateway(db, models).chat_completions(
                _user(), {'messages': [{'role': 'user', 'content': 'hello'}], 'stream': True},
            )
            request_id = response.headers.get('X-Agent-Request-Id')
            stream = response.response
            next(stream)  # 消费一块后客户端中断
            stream.close()
            row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
    assert row.status == 'client_error'
    assert row.error_summary == '客户端中断流式响应'
    assert row.completion_tokens > 0


def test_chat_completions_streaming_upstream_break_records_stream_error(agent_db, monkeypatch):
    app, db, models = agent_db

    class FailingStream(FakeUpstreamResponse):
        def __init__(self):
            super().__init__([b'data: {"choices":[]}\n\n'])
            self.reads = 0

        def read(self, size=None):
            self.reads += 1
            if self.reads > 1:
                raise OSError('connection reset by peer')
            return super().read(size)

    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda request, timeout=None: FailingStream(),
    )
    with app.app_context():
        with app.test_request_context():
            cred = _add_credential(db, models, priority=200)
            response = _gateway(db, models).chat_completions(
                _user(), {'messages': [{'role': 'user', 'content': 'hello'}], 'stream': True},
            )
            request_id = response.headers.get('X-Agent-Request-Id')
            with pytest.raises(OSError):
                response.get_data()
            row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
            cred_row = db.session.get(models['AgentLlmCredential'], cred.id)
    assert row.status == 'stream_error'
    assert row.error_summary == 'connection reset by peer'
    assert cred_row.consecutive_failures == 1


def test_anthropic_stream_break_estimates_emitted_completion_tokens(agent_db, monkeypatch):
    app, db, models = agent_db

    class FailingAnthropicStream(FakeUpstreamResponse):
        def __init__(self):
            super().__init__([
                b'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","usage":{"input_tokens":2}}}\n\n',
                'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"已经输出的内容"}}\n\n'.encode('utf-8'),
            ], headers={'Content-Type': 'text/event-stream'})
            self.reads = 0

        def read(self, size=None):
            self.reads += 1
            if self.reads > 2:
                raise OSError('anthropic stream reset')
            return super().read(size)

    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda request, timeout=None: FailingAnthropicStream(),
    )
    with app.app_context():
        with app.test_request_context():
            _add_credential(
                db, models, upstream_protocol='anthropic-messages',
                models_json='["glm-5"]', default_model='glm-5',
            )
            response = _gateway(db, models).chat_completions(
                _user(), {
                    'model': 'glm-5', 'stream': True, 'max_tokens': 16,
                    'messages': [{'role': 'user', 'content': 'hello'}],
                },
            )
            request_id = response.headers['X-Agent-Request-Id']
            with pytest.raises(OSError, match='anthropic stream reset'):
                response.get_data()
            row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()

    assert row.status == 'stream_error'
    assert row.prompt_tokens == 2
    assert row.completion_tokens > 0


def test_anthropic_error_event_is_recorded_as_stream_error(agent_db, monkeypatch):
    app, db, models = agent_db
    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda request, timeout=None: FakeUpstreamResponse([
            b'event: error\n',
            b'data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n',
        ], headers={'Content-Type': 'text/event-stream'}),
    )
    with app.app_context():
        with app.test_request_context():
            cred = _add_credential(
                db, models, upstream_protocol='anthropic-messages',
                models_json='["glm-5"]', default_model='glm-5',
            )
            response = _gateway(db, models).chat_completions(
                _user(), {
                    'model': 'glm-5', 'stream': True, 'max_tokens': 16,
                    'messages': [{'role': 'user', 'content': 'hello'}],
                },
            )
            request_id = response.headers['X-Agent-Request-Id']
            with pytest.raises(ProtocolBridgeError, match='overloaded'):
                response.get_data()
            row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
            credential = db.session.get(models['AgentLlmCredential'], cred.id)

    assert row.status == 'stream_error'
    assert 'overloaded' in row.error_summary
    assert credential.health_status != 'healthy'


# ─── usage_service：用量与配额 ────────────────────────────────────────────────

def test_estimate_tokens_handles_various_shapes(agent_db):
    app, db, models = agent_db
    with app.app_context():
        service = AgentUsageService(db, models)
        assert service.estimate_tokens(None) == 0
        assert service.estimate_tokens('') == 0
        assert service.estimate_tokens([]) == 0
        assert service.estimate_tokens({}) == 0
        # 非空输入按 UTF-8 字节数/4 向上取整，且至少为 1
        assert service.estimate_tokens('hello') == 2
        assert service.estimate_tokens({'role': 'user', 'content': 'hi'}) >= 1


def test_reserve_quota_clamps_completion_tokens(agent_db):
    app, db, models = agent_db
    with app.app_context():
        db.session.add(models['AgentUserQuota'](user_id=1, daily_token_quota=2_000_000))
        db.session.commit()
        service = AgentUsageService(db, models)
        # 超出 1e6 上限
        service.reserve_quota(1, 'req-big', {'messages': [], 'max_tokens': 2_000_000}, None)
        row = models['AgentUsageEvent'].query.filter_by(request_id='req-big').one()
        assert row.completion_tokens == 1_000_000
        # 低于 1 的下限
        service.reserve_quota(1, 'req-tiny', {'messages': [], 'max_tokens': -5}, None)
        row = models['AgentUsageEvent'].query.filter_by(request_id='req-tiny').one()
        assert row.completion_tokens == 1
        # 未指定时使用配置默认值
        service.reserve_quota(1, 'req-default', {'messages': []}, None)
        row = models['AgentUsageEvent'].query.filter_by(request_id='req-default').one()
        assert row.completion_tokens == 2048


def test_reserve_quota_rejects_non_integer_max_tokens(agent_db):
    app, db, models = agent_db
    with app.app_context():
        service = AgentUsageService(db, models)
        with pytest.raises(AgentUsageError, match='最大输出 Token 必须是整数'):
            service.reserve_quota(1, 'req-bad', {'messages': [], 'max_tokens': 'abc'}, None)


def test_record_rejects_duplicate_request_id(agent_db):
    app, db, models = agent_db
    with app.app_context():
        service = AgentUsageService(db, models)
        service.record(1, request_id='req-dup', model='m', prompt_tokens=1, completion_tokens=1, status='ok')
        with pytest.raises(AgentUsageError) as exc_info:
            service.record(1, request_id='req-dup', model='m', prompt_tokens=1, completion_tokens=1, status='ok')
        assert exc_info.value.status_code == 409
        assert models['AgentUsageEvent'].query.count() == 1


def test_tokens_today_ignores_reserved_events(agent_db):
    app, db, models = agent_db
    with app.app_context():
        db.session.add(models['AgentUserQuota'](user_id=1, daily_token_quota=5000))
        db.session.commit()
        service = AgentUsageService(db, models)
        service.reserve_quota(1, 'req-res', {'messages': [{'role': 'user', 'content': 'x' * 500}], 'max_tokens': 100}, None)
        service.record(1, request_id='req-ok', model='m', prompt_tokens=4, completion_tokens=6, status='ok')
        assert service.tokens_today(1) == 10


def test_quota_summary_exhaustion_and_assert(agent_db):
    app, db, models = agent_db
    with app.app_context():
        service = AgentUsageService(db, models)
        service.crud.set_quota(1, 5)
        service.record(1, request_id='req-use', model='m', prompt_tokens=3, completion_tokens=3, status='ok')
        summary = service.quota_summary(1)
        assert summary['daily_quota'] == 5
        assert summary['used_today'] == 6
        assert summary['exhausted'] is True
        assert summary['remaining'] == 0
        with pytest.raises(AgentUsageError, match='今日 Token 配额已用尽'):
            service.assert_quota(1)


# ─── credential_service：Key 池选取与健康 ─────────────────────────────────────

def test_candidates_orders_by_priority_and_excludes_cooldown(agent_db, monkeypatch):
    app, db, models = agent_db
    monkeypatch.setattr(
        credential_service.random, 'choices',
        lambda population, weights, k=1: [population[0]],
    )
    with app.app_context():
        high = _add_credential(db, models, priority=200, weight=100)
        low = _add_credential(db, models, priority=100, weight=100)
        cooling = _add_credential(
            db, models, priority=300, weight=100,
            cooldown_until=datetime.utcnow() + timedelta(minutes=5),
        )
        service = AgentCredentialService(db, models)
        picked = service.candidates(preferred_model='deepseek-v4-pro')
        ids = [row.id for row in picked]
        assert ids == [high.id, low.id]
        assert cooling.id not in ids


def test_candidates_weighted_rendezvous_is_stable_and_honors_weight(agent_db):
    app, db, models = agent_db
    with app.app_context():
        light = _add_credential(db, models, priority=100, weight=1)
        heavy = _add_credential(db, models, priority=100, weight=5)
        service = AgentCredentialService(db, models)

        stable = [
            service.candidates(affinity_key='same-session', limit=1)[0].id
            for _ in range(5)
        ]
        counts = {light.id: 0, heavy.id: 0}
        for index in range(1000):
            selected = service.candidates(
                affinity_key=f'session-{index}', limit=1,
            )[0]
            counts[selected.id] += 1

    assert len(set(stable)) == 1
    assert counts[heavy.id] > counts[light.id] * 3


def test_candidates_uses_env_fallback_when_no_credentials(agent_db):
    app, db, models = agent_db
    app.config['AGENT_LLM_KEY'] = 'sk-env'
    app.config['AGENT_LLM_BASE'] = 'https://env.example'
    app.config['AGENT_LLM_MODEL'] = 'deepseek-v4-pro'
    with app.app_context():
        service = AgentCredentialService(db, models)
        picked = service.candidates()
    assert len(picked) == 1
    assert picked[0].id is None
    assert picked[0].base_url == 'https://env.example'
    assert picked[0].api_key == 'sk-env'


def test_candidates_prefers_healthy_over_unhealthy(agent_db, monkeypatch):
    app, db, models = agent_db
    monkeypatch.setattr(
        credential_service.random, 'choices',
        lambda population, weights, k=1: [population[0]],
    )
    with app.app_context():
        sick = _add_credential(db, models, priority=200)
        sick.health_status = 'unhealthy'
        sick.last_error_at = datetime.utcnow()
        well = _add_credential(db, models, priority=100)
        well.health_status = 'healthy'
        db.session.commit()
        picked = AgentCredentialService(db, models).candidates()
    assert [row.id for row in picked] == [well.id]


def test_candidates_retries_unhealthy_after_retry_window(agent_db, monkeypatch):
    app, db, models = agent_db
    monkeypatch.setattr(
        credential_service.random, 'choices',
        lambda population, weights, k=1: [population[0]],
    )
    with app.app_context():
        sick = _add_credential(db, models, priority=200)
        sick.health_status = 'unhealthy'
        sick.last_error_at = datetime.utcnow() - timedelta(minutes=6)
        well = _add_credential(db, models, priority=100)
        well.health_status = 'healthy'
        db.session.commit()
        picked = AgentCredentialService(db, models).candidates()
        ids = [row.id for row in picked]
    assert sick.id in ids
    assert well.id in ids


def test_candidates_uses_unhealthy_when_nothing_else_left(agent_db):
    app, db, models = agent_db
    with app.app_context():
        sick = _add_credential(db, models, priority=200)
        sick.health_status = 'unhealthy'
        db.session.commit()
        picked = AgentCredentialService(db, models).candidates()
    assert [row.id for row in picked] == [sick.id]


def test_candidates_bound_cooling_credential_raises_503(agent_db):
    app, db, models = agent_db
    with app.app_context():
        cooling = _add_credential(
            db, models, cooldown_until=datetime.utcnow() + timedelta(minutes=5),
        )
        service = AgentCredentialService(db, models)
        with pytest.raises(AgentCredentialError) as exc_info:
            service.candidates(credential_id=cooling.id)
    assert exc_info.value.status_code == 503
    assert '冷却' in exc_info.value.message
    assert '分钟后重试' in exc_info.value.message


def test_gateway_status_no_credentials(agent_db):
    app, db, models = agent_db
    with app.app_context():
        status = _gateway(db, models).gateway_status()
    assert status['status'] == 'no_credentials'
    assert '未配置模型账号' in status['message']


def test_gateway_status_all_cooldown(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(
            db, models,
            cooldown_until=datetime.utcnow() + timedelta(minutes=30),
        )
        status = _gateway(db, models).gateway_status()
    assert status['status'] == 'all_cooldown'
    assert '分钟后重试' in status['message']
    assert status.get('retry_after')


def test_non_json_switch_key_records_soft_failure_only(agent_db, monkeypatch):
    app, db, models = agent_db
    calls = 0

    def fake_urlopen(request, timeout=None):
        nonlocal calls
        calls += 1
        if calls == 1:
            return FakeUpstreamResponse([b'not-json'])
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        primary = _add_credential(db, models, priority=200)
        _add_credential(db, models, priority=100)
        parsed, http_status, _request_id = _gateway(db, models).chat_completions(
            _user(), {'messages': [{'role': 'user', 'content': 'hello'}]},
        )
        primary_row = db.session.get(models['AgentLlmCredential'], primary.id)

    assert http_status == 200
    assert parsed['choices'][0]['message']['content'] == 'Hi'
    # 切号位的可重试错误只软记账：留下观测与短窗降权，不进硬阈值。
    assert primary_row.last_error_at is not None
    assert primary_row.consecutive_failures == 0
    assert AgentCredentialService._unhealthy_in_penalty(primary_row) is True


def test_candidates_all_cooling_includes_retry_hint(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(
            db, models,
            cooldown_until=datetime.utcnow() + timedelta(minutes=12),
        )
        service = AgentCredentialService(db, models)
        with pytest.raises(AgentCredentialError) as exc_info:
            service.candidates()
    assert '分钟后重试' in exc_info.value.message


def test_resolve_routes_skips_cooling_bound_key_when_fallback_enabled(agent_db):
    app, db, models = agent_db
    with app.app_context():
        bound = _add_credential(
            db, models, priority=200,
            cooldown_until=datetime.utcnow() + timedelta(minutes=5),
        )
        spare = _add_credential(db, models, priority=100)
        db.session.add(models['AgentRouteConfig'](
            model_name='coati-coding', credential_id=bound.id,
            fallback_enabled=True, enabled=True, weight=100,
        ))
        db.session.commit()
        resolved = _gateway(db, models).resolve_routes('coati-coding')
    assert [item['credential_id'] for item in resolved] == [spare.id]


def test_resolve_routes_bound_cooling_without_fallback_is_503(agent_db):
    app, db, models = agent_db
    with app.app_context():
        bound = _add_credential(
            db, models, cooldown_until=datetime.utcnow() + timedelta(minutes=5),
        )
        db.session.add(models['AgentRouteConfig'](
            model_name='coati-coding', credential_id=bound.id,
            fallback_enabled=False, enabled=True, weight=100,
        ))
        db.session.commit()
        with pytest.raises(AgentGatewayError) as exc_info:
            _gateway(db, models).resolve_routes('coati-coding')
    assert exc_info.value.status_code == 503
    assert '冷却' in exc_info.value.message


def test_resolve_routes_rejects_bound_credential_model_mismatch(agent_db):
    app, db, models = agent_db
    with app.app_context():
        bound = _add_credential(db, models, models_json='["deepseek-v4-pro"]')
        db.session.add(models['AgentRouteConfig'](
            model_name='qwen-alias', upstream_model='qwen3.8-flash',
            credential_id=bound.id, fallback_enabled=False, enabled=True, weight=100,
        ))
        db.session.commit()
        with pytest.raises(AgentGatewayError) as exc_info:
            _gateway(db, models).resolve_routes('qwen-alias')
    assert exc_info.value.status_code == 503
    assert '不支持模型 qwen3.8-flash' in exc_info.value.message


def test_candidates_bound_disabled_credential_raises_503(agent_db):
    app, db, models = agent_db
    with app.app_context():
        disabled = _add_credential(db, models, priority=200, enabled=False)
        service = AgentCredentialService(db, models)
        with pytest.raises(AgentCredentialError) as exc_info:
            service.candidates(credential_id=disabled.id)
    assert exc_info.value.status_code == 503
    assert '指定的模型账号不可用' in exc_info.value.message


def test_mark_failure_reaches_cooldown_after_threshold(agent_db):
    app, db, models = agent_db
    with app.app_context():
        cred = _add_credential(db, models, priority=200)
        service = AgentCredentialService(db, models)
        observed_at = datetime.utcnow()
        for _ in range(3):
            service.mark_failure(cred, 'boom', observed_at=observed_at)
        db.session.expire(cred)
        assert cred.consecutive_failures == 3
        assert cred.health_status == 'cooldown'
        assert cred.cooldown_until is not None
        assert cred.cooldown_until > datetime.utcnow()


def test_credential_delete_preserves_usage_history(agent_db):
    app, db, models = agent_db
    with app.app_context():
        db.session.execute(text('PRAGMA foreign_keys=ON'))
        credential = _add_credential(db, models, enabled=False)
        db.session.add(models['AgentUsageEvent'](
            request_id='req-history-credential-delete',
            user_id=1,
            credential_id=credential.id,
            model='deepseek-v4-pro',
            status='ok',
        ))
        db.session.commit()

        AgentCredentialService(db, models).delete(credential.id)

        history = models['AgentUsageEvent'].query.filter_by(
            request_id='req-history-credential-delete',
        ).one()
        assert history.credential_id is None


def test_credential_delete_rejects_enabled_credential(agent_db):
    app, db, models = agent_db
    with app.app_context():
        credential = _add_credential(db, models, enabled=True)

        with pytest.raises(AgentCredentialError) as exc_info:
            AgentCredentialService(db, models).delete(credential.id)

        assert exc_info.value.status_code == 409
        assert '先停用' in exc_info.value.message
        assert db.session.get(models['AgentLlmCredential'], credential.id) is not None


def test_credential_copy_clones_configuration_and_resets_runtime_state(agent_db):
    app, db, models = agent_db
    with app.app_context():
        source = _add_credential(
            db, models,
            name='DeepSeek 主账号',
            enabled=False,
            models_json='["deepseek-chat", "deepseek-reasoner"]',
            default_model='deepseek-chat',
            model_prefix='company',
            extra_headers_json='{"X-Title":"COATI"}',
        )
        source.health_status = 'cooldown'
        source.consecutive_failures = 3
        source.last_error = '旧错误'
        source.last_used_at = datetime.utcnow()
        db.session.commit()

        payload = AgentCredentialService(db, models).copy(source.id)
        clone = db.session.get(models['AgentLlmCredential'], payload['id'])

        assert payload['name'] == 'DeepSeek 主账号（复制）'
        assert 'api_key' not in payload
        assert clone.api_key == source.api_key
        assert clone.key_fingerprint == source.key_fingerprint
        assert clone.models_json == source.models_json
        assert clone.default_model == source.default_model
        assert clone.model_prefix == source.model_prefix
        assert clone.extra_headers_json == source.extra_headers_json
        assert clone.enabled is False
        assert clone.health_status == 'unknown'
        assert clone.consecutive_failures == 0
        assert clone.last_error is None
        assert clone.last_used_at is None


# ─── route_service：模型路由校验 ───────────────────────────────────────────────

def test_route_list_summary_covers_all_routes_not_just_current_page(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_route(db, models, model_name='coati-one', enabled=True)
        _add_route(db, models, model_name='coati-two', enabled=False)
        payload = AgentRouteService(db, models).list_routes(page=1, per_page=1, include_summary=True)

    assert payload['total'] == 2
    assert payload['summary'] == {'total': 2, 'enabled': 1, 'disabled': 1, 'attention': 0}


def test_route_cannot_bind_disabled_credential(agent_db):
    app, db, models = agent_db
    with app.app_context():
        disabled = _add_credential(db, models, priority=200, enabled=False)
        service = AgentRouteService(db, models)
        with pytest.raises(AgentRouteError) as exc_info:
            service.create({
                'model_name': 'coati-coding', 'credential_id': disabled.id, 'enabled': True,
            })
    assert exc_info.value.status_code == 422
    assert '已停用的模型账号' in exc_info.value.message


def test_route_rejects_unsupported_explicit_upstream_model(agent_db):
    app, db, models = agent_db
    with app.app_context():
        credential = _add_credential(db, models, models_json='["deepseek-v4-pro"]')
        service = AgentRouteService(db, models)
        with pytest.raises(AgentRouteError) as exc_info:
            service.create({
                'model_name': 'qwen-alias',
                'upstream_model': 'qwen3.8-flash',
                'credential_id': credential.id,
                'enabled': True,
            })
    assert exc_info.value.status_code == 422
    assert '不支持实际模型' in exc_info.value.message


def test_route_cannot_bind_personal_credential(agent_db):
    app, db, models = agent_db
    with app.app_context():
        personal = _add_credential(
            db, models, scope='personal', owner_user_id=1,
            model_prefix='mine', models_json='["gpt-4"]', default_model='gpt-4',
        )
        service = AgentRouteService(db, models)
        with pytest.raises(AgentRouteError) as exc_info:
            service.create({
                'model_name': 'mine-route', 'credential_id': personal.id, 'enabled': True,
            })
    assert exc_info.value.status_code == 422
    assert '个人渠道' in exc_info.value.message


def test_personal_channel_delete_rejects_route_reference(agent_db):
    app, db, models = agent_db
    with app.app_context():
        personal = _add_credential(
            db, models, scope='personal', owner_user_id=1,
            model_prefix='mine', models_json='["gpt-4"]', default_model='gpt-4', enabled=False,
        )
        _add_route(db, models, model_name='legacy-personal-route', credential_id=personal.id)
        service = AgentCredentialService(db, models)
        with pytest.raises(AgentCredentialError) as exc_info:
            service.delete_personal(1, personal.id)
    assert exc_info.value.status_code == 409
    assert '解除路由绑定' in exc_info.value.message


def test_route_delete_rejects_enabled_route(agent_db):
    app, db, models = agent_db
    with app.app_context():
        route = _add_route(db, models, model_name='enabled-route', enabled=True)

        with pytest.raises(AgentRouteError) as exc_info:
            AgentRouteService(db, models).delete(route.id)

        assert exc_info.value.status_code == 409
        assert '先停用' in exc_info.value.message
        assert db.session.get(models['AgentRouteConfig'], route.id) is not None


def test_route_upstream_base_requires_bound_credential(agent_db):
    app, db, models = agent_db
    with app.app_context():
        service = AgentRouteService(db, models)
        with pytest.raises(AgentRouteError) as exc_info:
            service.create({
                'model_name': 'coati-coding', 'enabled': True,
                'upstream_base': 'https://evil.example/v1',
            })
    assert exc_info.value.status_code == 422
    assert '必须绑定一把 Key' in exc_info.value.message


def test_route_duplicate_model_name_rejected(agent_db):
    app, db, models = agent_db
    with app.app_context():
        cred = _add_credential(db, models, priority=200)
        service = AgentRouteService(db, models)
        service.create({'model_name': 'coati-coding', 'credential_id': cred.id, 'enabled': True})
        with pytest.raises(AgentRouteError) as exc_info:
            service.create({'model_name': 'coati-coding', 'credential_id': cred.id, 'enabled': True})
    assert exc_info.value.status_code == 409
    assert '模型名称已存在' in exc_info.value.message


# ─── default_model：网关默认模型 ──────────────────────────────────────────────

def test_default_model_returns_highest_priority_enabled_credential_default(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(db, models, name='low', priority=10, default_model='deepseek-v4-flash')
        _add_credential(db, models, name='high', priority=200, default_model='deepseek-v4-pro')
        assert _gateway(db, models).default_model() == 'deepseek-v4-pro'


def test_default_model_does_not_fall_back_to_provider_model(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(db, models, default_model=None)
        assert _gateway(db, models).default_model() is None


def test_default_model_skips_disabled_credentials(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(db, models, default_model='deepseek-v4-flash', enabled=False)
        _add_credential(db, models, default_model='deepseek-v4-pro')
        assert _gateway(db, models).default_model() == 'deepseek-v4-pro'


def test_default_model_none_without_enabled_credentials(agent_db):
    app, db, models = agent_db
    with app.app_context():
        assert _gateway(db, models).default_model() is None


def _ok_search_json():
    return json.dumps({
        'content': [
            {
                'type': 'web_search_tool_result',
                'content': [
                    {'type': 'web_search_result', 'url': 'https://nodejs.org/en', 'title': 'Node.js'},
                ],
            },
            {
                'type': 'text',
                'text': 'Node.js is a runtime.',
                'citations': [
                    {'url': 'https://nodejs.org/en', 'cited_text': 'JavaScript runtime'},
                ],
            },
        ],
        'usage': {'input_tokens': 12, 'output_tokens': 8},
    }).encode('utf-8')


def test_web_search_uses_configured_account_model_and_records_usage(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['request'] = request
        return FakeUpstreamResponse([_ok_search_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        cred = _add_credential(db, models, priority=200)
        payload, http_status, request_id = _gateway(db, models).web_search(_user(), 'Node.js LTS', 5)
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
        cred_row = db.session.get(models['AgentLlmCredential'], cred.id)

    assert http_status == 200
    assert payload['query'] == 'Node.js LTS'
    assert payload['sources'][0]['url'] == 'https://nodejs.org/en'
    assert payload['sources'][0]['snippet'] == 'JavaScript runtime'
    assert captured['request'].full_url == 'https://api.deepseek.com/anthropic/v1/messages'
    body = json.loads(captured['request'].data.decode('utf-8'))
    assert body['model'] == 'deepseek-v4-pro'
    assert body['tools'][0]['type'] == 'web_search_20250305'
    assert row.status == 'ok'
    assert row.prompt_tokens == 12
    assert row.completion_tokens == 8
    assert row.credential_id == cred.id
    assert cred_row.health_status == 'healthy'


def test_web_search_records_cache_usage_and_inbound_protocol(agent_db, monkeypatch):
    app, db, models = agent_db

    def fake_urlopen(request, timeout=None):
        return FakeUpstreamResponse([json.dumps({
            'content': [{
                'type': 'web_search_tool_result',
                'content': [{'type': 'web_search_result', 'url': 'https://a.io', 'title': 'A'}],
            }],
            'usage': {
                'prompt_tokens': 100,
                'completion_tokens': 5,
                'prompt_cache_hit_tokens': 20,
                'prompt_cache_write_tokens': 0,
                'prompt_cache_miss_tokens': 80,
            },
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(db, models)
        _payload, status, request_id = _gateway(db, models).web_search(
            _user(), 'cache-aware search', 5,
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()

    assert status == 200
    assert row.inbound_protocol == 'web-search'
    assert row.prompt_tokens == 100
    assert row.completion_tokens == 5
    assert row.cache_read_tokens == 20
    assert row.cache_write_tokens == 0
    assert row.cache_miss_tokens == 80


def test_web_search_rejects_empty_query(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(db, models)
        with pytest.raises(AgentGatewayError) as exc_info:
            _gateway(db, models).web_search(_user(), '  ')
    assert exc_info.value.status_code == 400


def test_web_search_503_without_any_credential(agent_db):
    app, db, models = agent_db
    with app.app_context():
        with pytest.raises(AgentGatewayError) as exc_info:
            _gateway(db, models).web_search(_user(), 'hello')
    assert exc_info.value.status_code == 503


def test_web_search_learns_that_an_account_does_not_search_and_skips_it(agent_db, monkeypatch):
    """会不会执行服务端搜索是试出来的，不是按厂商名预判的。

    第一次会真的打过去；上游 200 但回包里没有搜索结果，就记下这个账号不执行，
    之后不再浪费往返，也不能因此扣它的健康分——它只是不会搜，不是坏了。
    """
    app, db, models = agent_db
    calls = {'n': 0}

    def fake_urlopen(request, timeout=None):
        calls['n'] += 1
        return FakeUpstreamResponse([json.dumps({
            'content': [{'type': 'text', 'text': '我不会搜索。'}],
            'usage': {'input_tokens': 3, 'output_tokens': 1},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        # 这把账号有合法的 Anthropic 端点（协议对得上），但它不执行服务端搜索。
        cred = _add_credential(
            db, models, provider='openai-compatible',
            upstream_protocol='anthropic-messages',
            models_json='["gpt-4o"]', default_model='gpt-4o',
        )
        with pytest.raises(AgentGatewayError):
            _gateway(db, models).web_search(_user(), 'hello')
        first_round = calls['n']
        health_after = cred.health_status
        failures_after = cred.consecutive_failures

        # 已经探明不执行，第二次直接判定无可用账号，不再打上游。
        with pytest.raises(AgentGatewayError) as exc_info:
            _gateway(db, models).web_search(_user(), 'hello again')

    assert first_round >= 1
    assert calls['n'] == first_round
    assert exc_info.value.status_code == 503
    # 「不会搜」是能力问题不是健康问题，不能把一个好端端的对话账号冷却掉。
    assert failures_after == 0
    assert health_after != 'unhealthy"'.rstrip('"')


def test_web_search_falls_back_on_402(agent_db, monkeypatch):
    app, db, models = agent_db
    calls = {'n': 0}

    def fake_urlopen(request, timeout=None):
        calls['n'] += 1
        if calls['n'] == 1:
            raise urlerror.HTTPError(
                request.full_url, 402, 'Payment Required',
                {}, io.BytesIO(b'{"message":"Insufficient Balance"}'),
            )
        return FakeUpstreamResponse([_ok_search_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        primary = _add_credential(db, models, priority=200)
        fallback = _add_credential(db, models, priority=100)
        payload, http_status, request_id = _gateway(db, models).web_search(_user(), 'hello')
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
        primary_row = db.session.get(models['AgentLlmCredential'], primary.id)
        fallback_id = fallback.id
        assert http_status == 200
        assert payload['sources'][0]['url'] == 'https://nodejs.org/en'
        assert calls['n'] == 2
        assert row.attempt_count == 2
        assert row.fallback_used is True
        assert row.credential_id == fallback_id
        assert primary_row.health_status == 'cooldown'


def test_echo_client_model_rewrites_upstream_name():
    payload = {
        'type': 'message_start',
        'message': {'id': 'msg_1', 'model': 'deepseek-v4-pro'},
        'model': 'deepseek-v4-pro',
    }
    rewritten = AgentGatewayService._echo_client_model(payload, 'coati-auto')
    assert rewritten['model'] == 'coati-auto'
    assert rewritten['message']['model'] == 'coati-auto'


def test_anthropic_messages_forwards_to_provider_and_maps_unknown_model(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['request'] = request
        return FakeUpstreamResponse([json.dumps({
            'id': 'msg_test',
            'type': 'message',
            'role': 'assistant',
            'content': [{'type': 'text', 'text': 'Hi'}],
            'usage': {'input_tokens': 9, 'output_tokens': 4},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        cred = _add_credential(
            db, models, priority=200, upstream_protocol='anthropic-messages',
        )
        parsed, http_status, request_id = _gateway(db, models).anthropic_messages(
            _user(),
            {
                'model': 'claude-sonnet-4-6',
                'max_tokens': 64,
                'messages': [{'role': 'user', 'content': 'hello'}],
            },
            request_headers={'anthropic-version': '2023-06-01'},
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
        credential_id = cred.id
        usage_status = row.status
        prompt_tokens = row.prompt_tokens
        completion_tokens = row.completion_tokens
        used_credential_id = row.credential_id

    assert http_status == 200
    assert parsed['content'][0]['text'] == 'Hi'
    assert captured['request'].full_url == 'https://api.deepseek.com/anthropic/v1/messages'
    body = json.loads(captured['request'].data.decode('utf-8'))
    assert body['model'] == 'deepseek-v4-pro'
    assert usage_status == 'ok'
    assert prompt_tokens == 9
    assert completion_tokens == 4
    assert used_credential_id == credential_id


def test_qwen_anthropic_account_uses_dashscope_messages_endpoint(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['request'] = request
        return FakeUpstreamResponse([json.dumps({
            'id': 'msg_qwen', 'type': 'message', 'role': 'assistant',
            'model': 'qwen3.8-flash',
            'content': [{'type': 'text', 'text': 'ok'}],
            'usage': {'input_tokens': 3, 'output_tokens': 1},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(
            db, models, provider='openai-compatible',
            base_url='https://dashscope.aliyuncs.com/apps/anthropic',
            upstream_protocol='anthropic-messages',
            models_json='["qwen3.8-flash"]', default_model='qwen3.8-flash',
        )
        parsed, status, request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': 'qwen3.8-flash', 'max_tokens': 32,
                'messages': [{'role': 'user', 'content': 'hello'}],
            },
        )
        usage = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()

    assert status == 200
    assert parsed['content'][0]['text'] == 'ok'
    assert captured['request'].full_url == 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages'
    assert usage.inbound_protocol == 'anthropic'
    assert usage.upstream_protocol == 'anthropic-messages'


def test_openai_chat_can_forward_to_anthropic_upstream(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['request'] = request
        return FakeUpstreamResponse([json.dumps({
            'id': 'msg_from_anthropic',
            'type': 'message',
            'role': 'assistant',
            'model': 'glm-5',
            'content': [{'type': 'text', 'text': 'translated back'}],
            'stop_reason': 'end_turn',
            'usage': {'input_tokens': 8, 'output_tokens': 3},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(
            db, models, provider='openai-compatible',
            base_url='https://relay.example',
            upstream_protocol='anthropic-messages',
            models_json='["glm-5"]', default_model='glm-5',
        )
        parsed, status, request_id = _gateway(db, models).chat_completions(
            _user(), {
                'model': 'glm-5',
                'messages': [
                    {'role': 'system', 'content': 'be concise'},
                    {'role': 'user', 'content': 'hello'},
                ],
                'max_tokens': 64,
            },
        )
        usage = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()

    assert status == 200
    assert parsed['object'] == 'chat.completion'
    assert parsed['choices'][0]['message']['content'] == 'translated back'
    assert captured['request'].full_url == 'https://relay.example/v1/messages'
    body = json.loads(captured['request'].data.decode('utf-8'))
    assert body['system'] == [{'type': 'text', 'text': 'be concise'}]
    assert body['messages'] == [{
        'role': 'user',
        'content': [{'type': 'text', 'text': 'hello'}],
    }]
    assert body['max_tokens'] == 64
    assert usage.inbound_protocol == 'openai'
    assert usage.upstream_protocol == 'anthropic-messages'
    assert usage.prompt_tokens == 8
    assert usage.completion_tokens == 3


def test_openai_chat_stream_from_anthropic_upstream_is_converted(agent_db, monkeypatch):
    app, db, models = agent_db

    def fake_urlopen(request, timeout=None):
        chunks = [
            b'event: message_start\n',
            b'data: {"type":"message_start","message":{"id":"msg-stream","model":"glm"}}\n\n',
            b'event: content_block_start\n',
            b'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            b'event: content_block_delta\n',
            b'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed"}}\n\n',
            b'event: message_delta\n',
            b'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":4,"output_tokens":2}}\n\n',
            b'event: message_stop\n',
            b'data: {"type":"message_stop"}\n\n',
        ]
        return FakeUpstreamResponse(chunks, headers={'Content-Type': 'text/event-stream'})

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(
            db, models, provider='openai-compatible', base_url='https://relay.example',
            upstream_protocol='anthropic-messages', models_json='["glm-5"]',
            default_model='glm-5',
        )
        with app.test_request_context('/api/agent/v1/chat/completions'):
            response = _gateway(db, models).chat_completions(
                _user(), {'model': 'glm-5', 'stream': True,
                          'messages': [{'role': 'user', 'content': 'hello'}]},
            )
            streamed = response.get_data().decode('utf-8')

    assert response.status_code == 200
    assert '"object": "chat.completion.chunk"' in streamed
    assert '"content": "streamed"' in streamed
    assert '"finish_reason": "stop"' in streamed
    assert 'data: [DONE]' in streamed


def test_routing_allows_same_model_accounts_across_supported_upstream_protocols(agent_db):
    app, db, models = agent_db
    with app.app_context():
        incompatible = _add_credential(
            db, models, name='native-anthropic', priority=300,
            upstream_protocol='anthropic-messages',
        )
        compatible = _add_credential(
            db, models, name='chat-compatible', priority=100,
            upstream_protocol='openai-chat',
        )
        route = _gateway(db, models).resolve_routes(
            'deepseek-v4-pro', user=_user(), inbound_protocol='openai',
        )[0]

    # 协议转换由网关负责，账号池不应再把原生 Anthropic 账号排除在
    # OpenAI Chat 入站之外；优先级仍决定首选账号。
    assert route['credential_id'] == incompatible.id
    assert route['credential_id'] != compatible.id
    assert route['upstream_protocol'] == 'anthropic-messages'


def test_anthropic_messages_translates_when_provider_has_no_native_messages(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['request'] = request
        return FakeUpstreamResponse([_ok_json(
            usage={'prompt_tokens': 8, 'completion_tokens': 6},
            content='translated',
        )])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(
            db, models, provider='openai', base_url='https://api.openai.com/v1',
            models_json='["gpt-4o"]', default_model='gpt-4o', upstream_protocol='openai-chat',
        )
        parsed, http_status, _request_id = _gateway(db, models).anthropic_messages(
            _user(),
            {
                'model': 'claude-sonnet-4-6',
                'max_tokens': 32,
                'system': 'short',
                'messages': [{'role': 'user', 'content': 'hello'}],
            },
        )

    assert http_status == 200
    assert captured['request'].full_url == 'https://api.openai.com/v1/chat/completions'
    body = json.loads(captured['request'].data.decode('utf-8'))
    assert body['model'] == 'gpt-4o'
    assert body['messages'][0] == {'role': 'system', 'content': 'short'}
    assert parsed['type'] == 'message'
    assert parsed['model'] == 'claude-sonnet-4-6'
    assert parsed['content'][0]['text'] == 'translated'
    assert parsed['usage'] == {'input_tokens': 8, 'output_tokens': 6}


def test_openai_responses_translates_when_provider_has_no_native_responses(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['request'] = request
        return FakeUpstreamResponse([_ok_json(
            usage={'prompt_tokens': 7, 'completion_tokens': 3},
            content='from-chat',
        )])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(db, models, priority=200)
        parsed, http_status, _request_id = _gateway(db, models).openai_responses(
            _user(),
            {
                'model': 'claude-sonnet-4-6',
                'instructions': 'brief',
                'max_output_tokens': 32,
                'input': 'hello',
            },
        )

    assert http_status == 200
    assert captured['request'].full_url == 'https://api.deepseek.com/chat/completions'
    body = json.loads(captured['request'].data.decode('utf-8'))
    assert body['model'] == 'deepseek-v4-pro'
    assert body['messages'][0] == {'role': 'system', 'content': 'brief'}
    assert body['messages'][1] == {'role': 'user', 'content': 'hello'}
    assert parsed['object'] == 'response'
    assert parsed['model'] == 'claude-sonnet-4-6'
    assert parsed['output'][0]['content'][0]['text'] == 'from-chat'
    assert parsed['usage'] == {
        'input_tokens': 7,
        'input_tokens_details': {'cache_write_tokens': 0, 'cached_tokens': 0},
        'output_tokens': 3,
        'output_tokens_details': {'reasoning_tokens': 0},
        'total_tokens': 10,
    }


def test_openai_responses_forwards_when_provider_supports_native(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['request'] = request
        return FakeUpstreamResponse([json.dumps({
            'id': 'resp_native',
            'object': 'response',
            'status': 'completed',
            'model': 'gpt-4o',
            'output': [{'type': 'message', 'role': 'assistant', 'content': [
                {'type': 'output_text', 'text': 'native'},
            ]}],
            'usage': {'input_tokens': 2, 'output_tokens': 1},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(
            db, models, provider='openai', base_url='https://api.openai.com/v1',
            models_json='["gpt-4o"]', default_model='gpt-4o', upstream_protocol='openai-responses',
        )
        parsed, http_status, _request_id = _gateway(db, models).openai_responses(
            _user(),
            {'model': 'gpt-4o', 'input': 'hello', 'store': True},
        )

    assert http_status == 200
    assert captured['request'].full_url == 'https://api.openai.com/v1/responses'
    body = json.loads(captured['request'].data.decode('utf-8'))
    assert body['model'] == 'gpt-4o'
    assert body['store'] is False
    assert parsed['output'][0]['content'][0]['text'] == 'native'
    assert parsed['model'] == 'gpt-4o'


def test_responses_builtin_tool_skips_incompatible_account_for_native_upstream(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['request'] = request
        return FakeUpstreamResponse([json.dumps({
            'id': 'resp-search',
            'object': 'response',
            'status': 'completed',
            'model': 'gpt-4o',
            'output': [{'type': 'message', 'role': 'assistant', 'content': [
                {'type': 'output_text', 'text': 'searched'},
            ]}],
            'usage': {'input_tokens': 2, 'output_tokens': 1},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(
            db, models, name='chat-first', priority=300,
            upstream_protocol='openai-chat', models_json='["gpt-4o"]',
            default_model='gpt-4o',
        )
        native = _add_credential(
            db, models, name='responses-native', provider='openai', priority=200,
            base_url='https://api.openai.com/v1', upstream_protocol='openai-responses',
            models_json='["gpt-4o"]', default_model='gpt-4o',
        )
        native_id = native.id
        parsed, status, request_id = _gateway(db, models).openai_responses(
            _user(), {
                'model': 'gpt-4o', 'input': 'search', 'max_output_tokens': 16,
                'tools': [{'type': 'web_search_preview'}],
            },
        )
        usage = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()

    assert status == 200
    assert parsed['output'][0]['content'][0]['text'] == 'searched'
    assert captured['request'].full_url == 'https://api.openai.com/v1/responses'
    assert usage.credential_id == native_id
    assert usage.upstream_protocol == 'openai-responses'
    assert usage.attempt_count == 2
    assert usage.fallback_used is True


# ─── 个人渠道：前缀、自定义头、不回退、不占平台配额 ───────────────────────────

def test_personal_prefix_routes_to_personal_and_strips_prefix(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['request'] = request
        captured['url'] = request.full_url
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(db, models, name='company', models_json='["gpt-4"]', default_model='gpt-4')
        personal = _add_credential(
            db, models, name='mine', models_json='["gpt-4"]', default_model='gpt-4',
            scope='personal', owner_user_id=1, model_prefix='mine',
            extra_headers_json='{"X-Title":"COATI","HTTP-Referer":"https://coati.local"}',
        )
        parsed, http_status, _rid = _gateway(db, models).chat_completions(
            _user(), {'model': 'mine/gpt-4', 'messages': [{'role': 'user', 'content': 'hi'}]},
        )
        allowed = _gateway(db, models).allowed_models(_user())

    assert http_status == 200
    body = json.loads(captured['request'].data.decode('utf-8'))
    assert body['model'] == 'gpt-4'
    assert 'api.deepseek.com' in captured['url']
    headers = {k.lower(): v for k, v in captured['request'].header_items()}
    assert headers.get('x-title') == 'COATI'
    assert headers.get('http-referer') == 'https://coati.local'
    assert 'mine/gpt-4' in allowed
    assert personal is not None


def test_personal_channel_session_keeps_same_credential(agent_db, monkeypatch):
    app, db, models = agent_db
    captured_hosts = []

    def fake_urlopen(request, timeout=None):
        captured_hosts.append(request.host)
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(
            db, models, name='personal-a', base_url='https://personal-a.example/v1',
            models_json='["gpt-4"]', default_model='gpt-4',
            scope='personal', owner_user_id=1, model_prefix='mine',
        )
        _add_credential(
            db, models, name='personal-b', base_url='https://personal-b.example/v1',
            models_json='["gpt-4"]', default_model='gpt-4',
            scope='personal', owner_user_id=1, model_prefix='mine',
        )
        for _ in range(2):
            _gateway(db, models).chat_completions(
                _user(),
                {'model': 'mine/gpt-4', 'messages': [{'role': 'user', 'content': 'same'}]},
                request_headers={'X-COATI-Session-ID': 'personal-cache-session'},
            )

    assert len(captured_hosts) == 2
    assert captured_hosts[0] == captured_hosts[1]


def test_personal_cooldown_does_not_fallback_to_company(agent_db, monkeypatch):
    app, db, models = agent_db
    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('must not call upstream')),
    )
    with app.app_context():
        _add_credential(db, models, name='company', models_json='["gpt-4"]', default_model='gpt-4')
        _add_credential(
            db, models, name='mine', models_json='["gpt-4"]', default_model='gpt-4',
            scope='personal', owner_user_id=1, model_prefix='mine',
            cooldown_until=datetime.utcnow() + timedelta(hours=1),
        )
        with pytest.raises(AgentGatewayError) as exc:
            _gateway(db, models).chat_completions(
                _user(), {'model': 'mine/gpt-4', 'messages': [{'role': 'user', 'content': 'hi'}]},
            )
    assert exc.value.status_code == 502
    assert '个人渠道' in exc.value.message


def test_personal_channel_does_not_reserve_company_quota(agent_db, monkeypatch):
    app, db, models = agent_db
    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda *args, **kwargs: FakeUpstreamResponse([_ok_json()]),
    )

    def boom(*args, **kwargs):
        raise AssertionError('personal channel must not reserve company quota')

    monkeypatch.setattr(AgentUsageService, 'reserve_quota', boom)
    with app.app_context():
        _add_credential(
            db, models, models_json='["gpt-4"]', default_model='gpt-4',
            scope='personal', owner_user_id=1, model_prefix='mine',
        )
        parsed, http_status, _rid = _gateway(db, models).chat_completions(
            _user(), {'model': 'mine/gpt-4', 'messages': [{'role': 'user', 'content': 'hi'}]},
        )
    assert http_status == 200
    assert parsed['choices'][0]['message']['content'] == 'Hi'


def test_unprefixed_model_still_uses_company_pool(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['url'] = request.full_url
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        company = _add_credential(
            db, models, name='company', base_url='https://company.example/v1',
            models_json='["gpt-4"]', default_model='gpt-4',
        )
        _add_credential(
            db, models, name='mine', base_url='https://personal.example/v1',
            models_json='["gpt-4"]', default_model='gpt-4',
            scope='personal', owner_user_id=1, model_prefix='mine',
        )
        _gateway(db, models).chat_completions(
            _user(), {'model': 'gpt-4', 'messages': [{'role': 'user', 'content': 'hi'}]},
        )
    assert 'company.example' in captured['url']
    assert company is not None


def test_personal_without_prefix_does_not_intercept_company(agent_db, monkeypatch):
    app, db, models = agent_db
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured['url'] = request.full_url
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(
            db, models, name='company', base_url='https://company.example/v1',
            models_json='["gpt-4"]', default_model='gpt-4',
        )
        _add_credential(
            db, models, name='mine', base_url='https://personal.example/v1',
            models_json='["gpt-4"]', default_model='gpt-4',
            scope='personal', owner_user_id=1, model_prefix='',
        )
        allowed = _gateway(db, models).allowed_models(_user())
        _gateway(db, models).chat_completions(
            _user(), {'model': 'gpt-4', 'messages': [{'role': 'user', 'content': 'hi'}]},
        )
    assert 'company.example' in captured['url']
    assert 'gpt-4' in allowed
    assert 'personal.example' not in captured.get('url', '')


def test_model_profiles_use_unified_database_profile(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(
            db, models, name='provider-any',
            models_json='["model-a"]', default_model='model-a',
        )
        db.session.add(models['AgentModelProfile'](
            model_name='model-a', context_window=1_000_000, max_output_tokens=16_384,
        ))
        db.session.commit()
        profiles = _gateway(db, models).model_profiles(_user())

    assert profiles['model-a']['context_window'] == 1_000_000
    assert profiles['model-a']['max_output_tokens'] == 16_384
    assert profiles['model-a']['context_window_source'] == 'unified-model-profile'
    assert profiles['model-a']['compaction_threshold_ratio'] == 0.8


def test_model_profiles_are_shared_by_accounts_and_ignore_legacy_account_values(agent_db):
    app, db, models = agent_db
    with app.app_context():
        for name, window in (('large', 1_000_000), ('small', 131_072)):
            _add_credential(
                db, models, name=name,
                models_json='["model-a"]', default_model='model-a',
                model_capabilities_json=json.dumps({
                    'model-a': {'context_window': window, 'max_output_tokens': 8192},
                }),
            )
        db.session.add(models['AgentModelProfile'](
            model_name='model-a', context_window=262_144, max_output_tokens=4096,
        ))
        db.session.commit()
        profile = _gateway(db, models).model_profiles(_user())['model-a']

    assert profile['context_window'] == 262_144
    assert profile['max_output_tokens'] == 4096
    assert profile['context_window_source'] == 'unified-model-profile'


def test_model_profiles_do_not_read_legacy_account_capabilities(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(
            db, models, name='legacy-account',
            models_json='["model-a"]', default_model='model-a',
            model_capabilities_json=json.dumps({
                'model-a': {'context_window': 1_000_000, 'max_output_tokens': 16_384},
            }),
        )
        profile = _gateway(db, models).model_profiles(_user())['model-a']

    assert profile['context_window'] == 128_000
    assert profile['context_window_source'] == 'unknown-model-fallback'


def test_model_profiles_do_not_assume_deepseek_supports_one_million(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(
            db, models, name='deepseek-unknown-capability',
            models_json='["deepseek-v4-pro"]', default_model='deepseek-v4-pro',
        )
        profile = _gateway(db, models).model_profiles(_user())['deepseek-v4-pro']

    assert profile['context_window'] == 128_000
    assert profile['context_window_source'] == 'unknown-model-fallback'


def test_litellm_auto_fill_and_admin_override(agent_db, monkeypatch):
    app, db, models = agent_db
    app.config.update(
        AGENT_LITELLM_AUTO_SYNC_ENABLED=True,
        AGENT_LITELLM_MODEL_CATALOG_URL='https://catalog.test/model_prices.json',
        AGENT_LITELLM_SYNC_INTERVAL_SECONDS=86400,
    )

    class Response:
        def raise_for_status(self):
            return None

        @staticmethod
        def json():
            return {
                'model-a': {
                    'max_input_tokens': 1_000_000,
                    'max_output_tokens': 65_536,
                },
            }

    monkeypatch.setattr(model_profile_catalog.requests, 'get', lambda *args, **kwargs: Response())
    with app.app_context():
        _add_credential(
            db, models, name='litellm-source',
            models_json='["model-a"]', default_model='model-a',
        )
        service = _gateway(db, models)
        profile = service.model_profiles(_user())['model-a']
        row = models['AgentModelProfile'].query.filter_by(model_name='model-a').first()

        assert profile['context_window'] == 1_000_000
        assert profile['max_output_tokens'] == 65_536
        assert row.context_window_override is None
        assert row.litellm_context_window == 1_000_000

        row.context_window_override = 262_144
        db.session.commit()
        profile = service.model_profiles(_user())['model-a']

    assert profile['context_window'] == 262_144
    assert profile['max_output_tokens'] == 65_536


def test_auto_route_profile_takes_minimum_of_explicit_target_profiles(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(
            db, models, name='route-targets',
            models_json='["text-model", "vision-model"]', default_model='text-model',
        )
        _add_route(
            db, models, model_name='coati-auto', upstream_model='text-model',
            vision_model='vision-model',
        )
        db.session.add_all([
            models['AgentModelProfile'](model_name='text-model', context_window=1_000_000, max_output_tokens=8192),
            models['AgentModelProfile'](model_name='vision-model', context_window=262_144, max_output_tokens=8192),
        ])
        db.session.commit()
        profile = _gateway(db, models).model_profiles(_user())['coati-auto']

    assert profile['context_window'] == 262_144
    assert profile['context_window_source'] == 'minimum-unified-model-profile'


def test_create_personal_requires_model_prefix(agent_db):
    app, db, models = agent_db
    with app.app_context():
        with pytest.raises(AgentCredentialError) as exc:
            AgentCredentialService(db, models).create_personal(1, {
                'name': 'mine',
                'base_url': 'https://api.deepseek.com',
                'api_key': 'sk-test-personal',
                'supported_models': ['gpt-4'],
                'default_model': 'gpt-4',
            })
    assert exc.value.status_code == 400
    assert '前缀' in exc.value.message


# ─── 软记账降权与健康探测 ────────────────────────────────────────────────────────

def test_retryable_fallback_records_soft_failure(agent_db, monkeypatch):
    """500 + 有候选：主 Key 只软记账——留下观测痕迹，但不进硬阈值。"""
    app, db, models = agent_db
    calls = {'n': 0}

    def fake_urlopen(request, timeout=None):
        calls['n'] += 1
        if calls['n'] == 1:
            raise urlerror.HTTPError(
                request.full_url, 500, 'Internal Server Error',
                {}, io.BytesIO(b'upstream down'),
            )
        return FakeUpstreamResponse([_ok_json()])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        primary = _add_credential(db, models, priority=200)
        fallback = _add_credential(db, models, priority=100)
        parsed, http_status, request_id = _gateway(db, models).chat_completions(
            _user(), {'messages': [{'role': 'user', 'content': 'hello'}]},
        )
        primary_row = db.session.get(models['AgentLlmCredential'], primary.id)

    assert http_status == 200
    assert parsed['choices'][0]['message']['content'] == 'Hi'
    assert calls['n'] == 2
    # 软记账痕迹：观测时间与错误文案已写入。
    assert primary_row.last_error_at is not None
    assert 'HTTP 500' in (primary_row.last_error or '')
    # 但不触发任何硬惩罚：不累计失败数、不改健康状态、不进冷却。
    assert primary_row.consecutive_failures == 0
    assert primary_row.health_status != 'unhealthy'
    assert primary_row.health_status != 'cooldown'
    assert primary_row.cooldown_until is None


def test_soft_failure_penalty_window_and_recovery(agent_db):
    """软降权由时间窗口读时求值：窗口内降权，到期自动参战，成功满血复位。"""
    app, db, models = agent_db
    with app.app_context():
        row = _add_credential(db, models)
        row.health_status = 'healthy'          # 生产主场景：正常账号被软记账后仍应短窗降权
        db.session.commit()
        svc = AgentCredentialService(db, models)

        svc.mark_failure(row, 'HTTP 503: busy', soft=True)
        db.session.expire(row)
        fresh = db.session.get(models['AgentLlmCredential'], row.id)
        assert AgentCredentialService._unhealthy_in_penalty(fresh) is True

        # 关掉软窗口配置 → 立即不再降权（读时求值的意义）。
        app.config['AGENT_CREDENTIAL_SOFT_RETRY_SECONDS'] = 0
        assert AgentCredentialService._unhealthy_in_penalty(fresh) is False
        app.config['AGENT_CREDENTIAL_SOFT_RETRY_SECONDS'] = 120

        # 连续软失败永远不会进入硬冷却或累计阈值。
        for _ in range(4):
            svc.mark_failure(fresh, 'HTTP 503: busy', soft=True)
        db.session.expire(row)
        fresh = db.session.get(models['AgentLlmCredential'], row.id)
        assert fresh.consecutive_failures == 0
        assert fresh.health_status != 'cooldown'
        assert fresh.cooldown_until is None

        # 成功一次：观测清空、状态满血、惩罚解除——下一个真实请求就是探活。
        svc.mark_success(fresh, 25)
        db.session.expire(row)
        recovered = db.session.get(models['AgentLlmCredential'], row.id)
        assert recovered.health_status == 'healthy'
        assert recovered.last_error_at is None
        assert recovered.last_error is None
        assert AgentCredentialService._unhealthy_in_penalty(recovered) is False


def test_hard_threshold_still_reaches_cooldown(agent_db):
    """硬路径不受影响：普通 mark_failure 攒满阈值仍进入冷却。"""
    app, db, models = agent_db
    with app.app_context():
        row = _add_credential(db, models)
        svc = AgentCredentialService(db, models)
        for _ in range(3):
            svc.mark_failure(row, 'HTTP 500: boom')
            db.session.expire(row)
        cooled = db.session.get(models['AgentLlmCredential'], row.id)
        assert cooled.consecutive_failures == 3
        assert cooled.health_status == 'cooldown'
        assert cooled.cooldown_until is not None


def test_probe_stale_credentials_recovers_cooldown_account(agent_db, monkeypatch):
    """定时探测：健康账号跳过；冷却账号探测成功即提前复位；失败只软记账。"""
    app, db, models = agent_db
    with app.app_context():
        healthy = _add_credential(db, models, name='healthy', priority=400)
        healthy.health_status = 'healthy'
        cooling = _add_credential(
            db, models, name='cooling',
            cooldown_until=datetime.utcnow() + timedelta(minutes=25),
        )
        sick = _add_credential(db, models, name='sick')
        sick.health_status = 'unhealthy'
        sick.consecutive_failures = 2
        db.session.commit()

        svc = AgentCredentialService(db, models)

        def fake_probe(data, *, update_health):
            rid = int(data.get('credential_id'))
            if rid == cooling.id:
                return {'models': ['deepseek-v4-pro'], 'latency_ms': 11}
            raise AgentCredentialError('探测失败: 上游 502')

        monkeypatch.setattr(svc, '_probe_upstream', fake_probe)
        result = svc.probe_stale_credentials(limit=20, quiet_seconds=600)

        probed_ids = {item['id'] for item in result['items']}
        assert healthy.id not in probed_ids          # 健康账号不做无谓探测
        assert result['probed'] == 2                 # 仅冷却中 + 异常两个候选
        assert result['recovered'] == 1              # 冷却中的账号被确认恢复
        assert result['still_failing'] == 1

        db.session.expire_all()
        cooling_row = db.session.get(models['AgentLlmCredential'], cooling.id)
        assert cooling_row.health_status == 'healthy'
        assert cooling_row.cooldown_until is None
        assert cooling_row.last_checked_at is not None

        sick_row = db.session.get(models['AgentLlmCredential'], sick.id)
        assert sick_row.last_checked_at is not None
        # 软记账失败不延长任何硬惩罚。
        assert sick_row.consecutive_failures == 2
        assert sick_row.health_status == 'unhealthy'


def test_background_probe_does_not_overwrite_newer_real_failure(agent_db, monkeypatch):
    app, db, models = agent_db
    with app.app_context():
        row = _add_credential(db, models, name='probe-race')
        row.health_status = 'unhealthy'
        db.session.commit()
        svc = AgentCredentialService(db, models)

        def fake_probe(data, *, update_health):
            svc.mark_failure(row, '真实请求失败')
            return {'models': ['deepseek-v4-pro'], 'latency_ms': 9}

        monkeypatch.setattr(svc, '_probe_upstream', fake_probe)
        svc.probe_stale_credentials(limit=10, quiet_seconds=30)
        db.session.expire_all()
        fresh = db.session.get(models['AgentLlmCredential'], row.id)

        assert fresh.health_status == 'unhealthy'
        assert fresh.last_error == '真实请求失败'
        assert fresh.last_error_at is not None


def test_probe_stale_credentials_keeps_non_discoverable_account_unverified(agent_db, monkeypatch):
    app, db, models = agent_db
    with app.app_context():
        row = _add_credential(
            db, models, name='native-anthropic',
            upstream_protocol='anthropic-messages',
        )
        row.health_status = 'cooldown'
        row.cooldown_until = datetime.utcnow() + timedelta(minutes=10)
        db.session.commit()
        svc = AgentCredentialService(db, models)
        monkeypatch.setattr(
            svc, '_probe_upstream',
            lambda data, *, update_health: {
                'models': [], 'latency_ms': 0, 'model_discovery_supported': False,
            },
        )

        result = svc.probe_stale_credentials(limit=10, quiet_seconds=600)
        db.session.expire_all()
        fresh = db.session.get(models['AgentLlmCredential'], row.id)

    assert result['recovered'] == 0
    assert result['still_failing'] == 0
    assert result['unverified'] == 1
    assert fresh.health_status == 'cooldown'
    assert fresh.last_checked_at is not None


class _FakeModelsResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


def test_anthropic_account_discovers_models_but_is_not_marked_healthy(agent_db, monkeypatch):
    """/models 通了不代表 /v1/messages 能用——两个端点未必同源。

    所以 Anthropic 上游的模型列表只用来填清单，不作为健康判据。
    """
    app, db, models = agent_db
    with app.app_context():
        row = _add_credential(
            db, models, name='native-anthropic',
            upstream_protocol='anthropic-messages',
        )
        monkeypatch.setattr(
            provider_adapters.requests, 'get',
            lambda *a, **k: _FakeModelsResponse({'data': [
                {'id': 'claude-opus-5'}, {'id': 'claude-sonnet-5'},
            ]}),
        )
        result = AgentCredentialService(db, models).check(row.id)
        db.session.expire_all()
        fresh = db.session.get(models['AgentLlmCredential'], row.id)

    # 模型确实拉到了——此前这条协议被写死成「不支持发现」，白白挡掉了。
    assert result['model_count'] == 2
    # 但健康状态不能因此变成 healthy。
    assert result['verified'] is False
    assert result['health_status'] == 'unknown'
    assert fresh.health_status == 'unknown'
    assert fresh.last_checked_at is not None


def test_anthropic_account_without_a_models_endpoint_degrades_quietly(agent_db, monkeypatch):
    """兼容入口大多没有 /models（实测千问那条 404），返回空清单即可，不该报错。"""
    app, db, models = agent_db
    with app.app_context():
        row = _add_credential(
            db, models, name='no-models', upstream_protocol='anthropic-messages',
        )
        monkeypatch.setattr(
            provider_adapters.requests, 'get',
            lambda *a, **k: _FakeModelsResponse({'error': 'not found'}, status_code=404),
        )
        result = AgentCredentialService(db, models).check(row.id)
        db.session.expire_all()
        fresh = db.session.get(models['AgentLlmCredential'], row.id)

    assert result['model_count'] == 0
    assert result['verified'] is False
    assert fresh.health_status == 'unknown'


def test_default_model_includes_all_supported_upstream_protocols(agent_db):
    app, db, models = agent_db
    with app.app_context():
        _add_credential(
            db, models, name='native-anthropic', priority=300,
            default_model='anthropic-only', models_json='["anthropic-only"]',
            upstream_protocol='anthropic-messages',
        )
        chat = _add_credential(
            db, models, name='chat', priority=100,
            default_model='chat-only', models_json='["chat-only"]',
            upstream_protocol='openai-chat',
        )
        selected = _gateway(db, models).default_model(inbound_protocol='openai')

    assert selected == 'anthropic-only'


def test_summary_and_to_dict_distinguish_expired_cooldown(agent_db):
    app, db, models = agent_db
    with app.app_context():
        now = datetime.utcnow()
        _healthy = _add_credential(db, models, name='healthy-row')
        _healthy.health_status = 'healthy'
        active = _add_credential(
            db, models, name='active-cooling',
            cooldown_until=now + timedelta(minutes=5),
        )
        active.health_status = 'cooldown'
        expired = _add_credential(db, models, name='expired-cooling')
        expired.health_status = 'cooldown'
        expired.cooldown_until = now - timedelta(minutes=1)
        db.session.commit()

        summary = AgentCredentialService(db, models).crud.summary()
        assert summary['enabled'] == 3
        assert summary['healthy'] == 1
        assert summary['cooling'] == 1
        assert summary['recovering'] == 1
        # 新口径下"异常"卡 = 状态异常 + 冷却中 = 1（旧实现会把过期冷却也算进 unhealthy 得 2）。
        assert summary['unhealthy'] == 1
        assert summary['unknown'] == 0

        expired_dict = db.session.get(models['AgentLlmCredential'], expired.id).to_dict()
        active_dict = db.session.get(models['AgentLlmCredential'], active.id).to_dict()
        assert expired_dict['health_status'] == 'cooldown'
        assert expired_dict['cooldown_active'] is False
        assert active_dict['cooldown_active'] is True


# ─── web_search server tool ───────────────────────────────────────────────────
#
# 两条路径必须分清楚：
# 1. 上游自己会执行搜索（真 Anthropic、DeepSeek 的 Anthropic 入口）→ 原样透传，
#    网关不插手，结果块和 citations 都是上游签发的真货。
# 2. 上游不会执行（DashScope 的 Anthropic 兼容入口就是这样，它只会把 server
#    tool 当普通工具打回来）→ 网关自己闭环，搜索交给号池里有该能力的账号跑。

CONVERSATION_MODEL = 'qwen3.8-flash'
SEARCH_MODEL = 'deepseek-v4-pro'


def _is_search_request(body):
    """网关代跑搜索时由 adapter 构造的请求。

    按模型名区分是不够的：搜索会在多个候选账号间故障转移，转到对话那把账号
    时模型名就一样了。真正的特征是 adapter 那套固定形状——server tool 声明
    加上合成的提示词。
    """
    tools = body.get('tools') or []
    kind = str((tools[0] or {}).get('type') or '') if tools else ''
    if not (kind.startswith('web_search_') or kind.startswith('web_fetch_')):
        return False
    messages = body.get('messages') or []
    if len(messages) != 1:
        return False
    content = messages[0].get('content')
    text = content if isinstance(content, str) else ''.join(
        part.get('text', '') for part in (content or []) if isinstance(part, dict)
    )
    return text.startswith(('Perform a web search for the query:',
                            'Fetch the page at this URL:'))


def _anthropic_message(content, stop_reason='end_turn', usage=None, model=CONVERSATION_MODEL):
    return json.dumps({
        'id': 'msg_test', 'type': 'message', 'role': 'assistant', 'model': model,
        'content': content, 'stop_reason': stop_reason,
        'usage': usage or {'input_tokens': 10, 'output_tokens': 5},
    }).encode('utf-8')


def _search_result_payload(url='https://claude.com/pricing', title='Pricing'):
    return json.dumps({
        'content': [{
            'type': 'web_search_tool_result',
            'content': [{
                'type': 'web_search_result', 'url': url, 'title': title,
                'snippet': 'Seat pricing starts at $20/month.', 'page_age': '2026-08-01',
            }],
        }],
        'usage': {'input_tokens': 4, 'output_tokens': 2},
    }).encode('utf-8')


def _web_search_upstream(monkeypatch, conversation_turns, search_response=None):
    """按顺序回放对话轮次；搜索请求单独应答。返回收集到的上游 body 列表。"""
    captured = []
    turns = list(conversation_turns)

    def fake_urlopen(request, timeout=None):
        body = json.loads(request.data.decode('utf-8'))
        captured.append(body)
        if _is_search_request(body):
            if callable(search_response):
                return search_response()
            return FakeUpstreamResponse([search_response or _search_result_payload()])
        return FakeUpstreamResponse([turns.pop(0)])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    return captured


def _relay_credentials(db, models):
    """对话账号不会自己搜（openai-compatible 画像），搜索账号会（deepseek 画像）。

    两把账号的模型清单不重叠，选路才不会互串：对话按模型名解析到前者，
    搜索按 Provider 能力解析到后者。这就是生产里 qwen + 能力账号的拓扑。
    """
    conversation = _add_credential(
        db, models, name='dashscope-qwen', provider='openai-compatible',
        base_url='https://dashscope.aliyuncs.com/apps/anthropic',
        upstream_protocol='anthropic-messages',
        models_json=f'["{CONVERSATION_MODEL}"]', default_model=CONVERSATION_MODEL,
    )
    # 搜索候选按优先级挑（不看模型名），所以能搜的这把要排在前面，否则
    # 每次都会先在不能搜的那把上白打一发。对话仍按模型名路由，不受影响。
    search = _add_credential(
        db, models, name='search-capable', provider='deepseek', priority=300,
        base_url='https://api.deepseek.com', upstream_protocol='anthropic-messages',
        models_json=f'["{SEARCH_MODEL}"]', default_model=SEARCH_MODEL,
    )
    return conversation, search


def _native_credential(db, models):
    """会自己执行 server tool 的上游：Provider 画像声明了 web_search 能力。"""
    return _add_credential(
        db, models, name='native-anthropic', provider='anthropic',
        base_url='https://api.anthropic.com', upstream_protocol='anthropic-messages',
        models_json='["claude-opus-5"]', default_model='claude-opus-5',
    )


# ─── 路径 1：上游原生执行，网关不插手 ─────────────────────────────────────────

def test_native_upstream_keeps_the_server_tool_and_is_not_intercepted(agent_db, monkeypatch):
    """能自己搜的上游必须收到原封不动的 server tool 声明，结果原样透传。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    captured = []

    def fake_urlopen(request, timeout=None):
        captured.append(json.loads(request.data.decode('utf-8')))
        return FakeUpstreamResponse([json.dumps({
            'id': 'msg_native', 'type': 'message', 'role': 'assistant', 'model': 'claude-opus-5',
            'content': [
                {'type': 'text', 'text': '我查一下。'},
                {'type': 'server_tool_use', 'id': 'srvtoolu_real', 'name': 'web_search',
                 'input': {'query': 'Claude Code pricing'}},
                {'type': 'web_search_tool_result', 'tool_use_id': 'srvtoolu_real', 'content': [
                    {'type': 'web_search_result', 'url': 'https://claude.com/pricing',
                     'title': 'Pricing', 'encrypted_content': 'EqgfCioIARgBIiQ3'},
                ]},
                {'type': 'text', 'text': '按席位计费。',
                 'citations': [{'type': 'web_search_result_location',
                                'url': 'https://claude.com/pricing', 'cited_text': '$20'}]},
            ],
            'stop_reason': 'end_turn',
            'usage': {'input_tokens': 20, 'output_tokens': 8,
                      'server_tool_use': {'web_search_requests': 1}},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        cred = _native_credential(db, models)
        # 只有已确认会执行的账号才走原生。生产里这个结论来自 resolve_search_routes
        # 真的让它搜过一次。
        WEB_SEARCH_SUPPORT.record(cred.id, True)
        payload, status, _request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': 'claude-opus-5', 'max_tokens': 64,
                'messages': [{'role': 'user', 'content': '多少钱？'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 1}],
            },
        )

    assert status == 200
    # 只打了一次上游：没有网关闭环插进来。
    assert len(captured) == 1
    assert captured[0]['tools'] == [
        {'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 1},
    ]
    # 块的顺序、citations、上游签发的 encrypted_content 全部原样保留。
    assert [block['type'] for block in payload['content']] == [
        'text', 'server_tool_use', 'web_search_tool_result', 'text',
    ]
    assert payload['content'][2]['content'][0]['encrypted_content'] == 'EqgfCioIARgBIiQ3'
    assert payload['content'][3]['citations'][0]['cited_text'] == '$20'
    assert payload['usage']['server_tool_use'] == {'web_search_requests': 1, 'web_fetch_requests': 0}
    assert payload['stop_reason'] == 'end_turn'


def test_native_upstream_pause_turn_is_not_rewritten(agent_db, monkeypatch):
    """上游挂起长搜索时客户端要原样回传这条消息，stop_reason 不能被改成 end_turn。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000

    def fake_urlopen(request, timeout=None):
        return FakeUpstreamResponse([json.dumps({
            'id': 'msg_paused', 'type': 'message', 'role': 'assistant', 'model': 'claude-opus-5',
            'content': [{'type': 'server_tool_use', 'id': 's1', 'name': 'web_search',
                         'input': {'query': 'long one'}}],
            'stop_reason': 'pause_turn',
            'usage': {'input_tokens': 5, 'output_tokens': 1,
                      'server_tool_use': {'web_search_requests': 1}},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        cred = _native_credential(db, models)
        WEB_SEARCH_SUPPORT.record(cred.id, True)
        payload, status, _request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': 'claude-opus-5', 'max_tokens': 64,
                'messages': [{'role': 'user', 'content': 'hi'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search'}],
            },
        )

    assert status == 200
    assert payload['stop_reason'] == 'pause_turn'


def test_native_is_declined_when_the_protocol_cannot_honour_the_config(agent_db, monkeypatch):
    """Responses 原生工具没有域名黑名单：带了就必须退回闭环，不能悄悄丢掉约束。"""
    from backend.app.agent.service.server_tools import native_web_search_tool

    config = {'type': 'web_search_20250305', 'blocked_domains': ['spam.example.com']}
    assert native_web_search_tool(config, 'openai-responses') is None
    # Anthropic 原生形状能完整表达，照走原生。
    assert native_web_search_tool(config, 'anthropic-messages')['blocked_domains'] == [
        'spam.example.com',
    ]


# ─── 路径 2：上游不会执行，网关闭环 ───────────────────────────────────────────

def test_anthropic_messages_runs_web_search_server_side(agent_db, monkeypatch):
    """端到端验收：客户端拿到的是搜完的结果，不是一个没人执行的 tool_use。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    captured = _web_search_upstream(monkeypatch, [
        _anthropic_message(
            [
                {'type': 'thinking', 'thinking': '需要查一下'},
                {'type': 'tool_use', 'id': 'tu_1', 'name': 'web_search',
                 # 实测该网关后面的模型发出的就是这个复数 + JSON 字符串形状。
                 'input': {'queries': '["Claude Code pricing page"]'}},
            ],
            stop_reason='tool_use', usage={'input_tokens': 12, 'output_tokens': 6},
        ),
        _anthropic_message(
            [{'type': 'text', 'text': 'Claude Code 按席位计费。'}],
            usage={'input_tokens': 48, 'output_tokens': 9},
        ),
    ])

    with app.app_context():
        _relay_credentials(db, models)
        payload, status, request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 64,
                'messages': [{'role': 'user', 'content': 'Claude Code 多少钱？'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 1}],
            },
            request_headers={
                'X-COATI-Session-ID': 'sess-search',
                'X-COATI-Request-ID': 'logical-search',
                'X-COATI-Step': '3',
            },
        )
        rows = models['AgentUsageEvent'].query.order_by(
            models['AgentUsageEvent'].id,
        ).all()

    assert status == 200
    assert request_id
    blocks = payload['content']
    # 官方顺序：server_tool_use → 对应的 web_search_tool_result → 模型的结论。
    assert blocks[0]['type'] == 'server_tool_use'
    assert blocks[0]['name'] == 'web_search'
    assert blocks[0]['input'] == {'query': 'Claude Code pricing page'}
    assert blocks[1]['type'] == 'web_search_tool_result'
    assert blocks[1]['tool_use_id'] == blocks[0]['id']
    assert isinstance(blocks[1]['content'], list)
    assert blocks[1]['content'][0]['url'] == 'https://claude.com/pricing'
    assert blocks[-1] == {'type': 'text', 'text': 'Claude Code 按席位计费。'}
    # 客户端没有任何工具可执行，绝不能让它去等一个不会来的 tool_result。
    assert payload['stop_reason'] == 'end_turn'
    assert payload['usage']['server_tool_use'] == {'web_search_requests': 1, 'web_fetch_requests': 0}
    assert payload['usage']['input_tokens'] == 60

    conversation = [body for body in captured if not _is_search_request(body)]
    assert len(conversation) == 2
    # 未确认会执行的账号一律先用带明确 schema 的普通工具，不赌原生——
    # 赌错的表现就是同一个请求换把账号结果就不一样。
    for body in conversation:
        offered = body['tools'][0]
        assert offered['name'] == 'web_search'
        assert 'type' not in offered
        assert offered['input_schema']['required'] == ['query']
    # 第二轮必须带上搜索结果，否则模型只能瞎编。
    assert 'Seat pricing starts at $20/month.' in json.dumps(conversation[1]['messages'])

    conversation_rows = [row for row in rows if row.model == CONVERSATION_MODEL]
    search_rows = [row for row in rows if row.model == SEARCH_MODEL]
    assert len(conversation_rows) == 2
    assert len(search_rows) == 1
    root = conversation_rows[0]
    assert root.request_id == request_id
    assert root.parent_request_id is None
    assert conversation_rows[1].parent_request_id == root.request_id
    assert search_rows[0].parent_request_id == root.request_id
    for row in rows:
        assert row.session_id == 'sess-search'
        assert row.client_request_id == 'logical-search'
        assert row.step_index == 3


def test_web_search_shortcut_returns_and_records_the_search_request_id(agent_db, monkeypatch):
    """纯 WebSearch shortcut 也必须返回数据库里真实存在的请求 ID。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    _web_search_upstream(monkeypatch, [])

    with app.app_context():
        _relay_credentials(db, models)
        payload, status, request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL,
                'messages': [{
                    'role': 'user',
                    'content': 'Perform a web search for the query: Claude Code pricing',
                }],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 1}],
            },
            request_headers={
                'X-COATI-Session-ID': 'sess-shortcut',
                'X-COATI-Request-ID': 'logical-shortcut',
            },
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()

    assert status == 200
    assert payload['usage']['server_tool_use'] == {
        'web_search_requests': 1, 'web_fetch_requests': 0,
    }
    assert row.model == SEARCH_MODEL
    assert row.parent_request_id is None
    assert row.session_id == 'sess-shortcut'
    assert row.client_request_id == 'logical-shortcut'


def test_anthropic_messages_web_search_streams_the_same_blocks(agent_db, monkeypatch):
    """Claude Code 实际发的是流式请求，闭环结果必须也能按 SSE 下发。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    _web_search_upstream(monkeypatch, [
        _anthropic_message(
            [{'type': 'tool_use', 'id': 'tu_1', 'name': 'web_search',
              'input': {'query': 'Claude Code pricing'}}],
            stop_reason='tool_use',
        ),
        _anthropic_message([{'type': 'text', 'text': '按席位计费。'}]),
    ])

    with app.app_context():
        _relay_credentials(db, models)
        with app.test_request_context('/api/agent/v1/messages'):
            response = _gateway(db, models).anthropic_messages(
                _user(), {
                    'model': CONVERSATION_MODEL, 'max_tokens': 64, 'stream': True,
                    'messages': [{'role': 'user', 'content': '多少钱？'}],
                    'tools': [{'type': 'web_search_20250305', 'name': 'web_search'}],
                },
            )
            streamed = response.get_data().decode('utf-8')

    assert response.status_code == 200
    assert response.mimetype == 'text/event-stream'
    assert response.headers.get('X-Agent-Request-Id')
    assert 'event: message_start' in streamed
    assert '"type": "server_tool_use"' in streamed
    assert '"type": "web_search_tool_result"' in streamed
    assert '"stop_reason": "end_turn"' in streamed
    assert '"web_search_requests": 1' in streamed
    assert 'event: message_stop' in streamed


def test_anthropic_messages_web_search_enforces_max_uses(agent_db, monkeypatch):
    """超出 max_uses 不是 HTTP 错误：content 从列表变成一个错误对象。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    _web_search_upstream(monkeypatch, [
        _anthropic_message(
            [{'type': 'tool_use', 'id': 'tu_1', 'name': 'web_search',
              'input': {'queries': '["first query", "second query"]'}}],
            stop_reason='tool_use',
        ),
        _anthropic_message([{'type': 'text', 'text': '只查到一条。'}]),
    ])

    with app.app_context():
        _relay_credentials(db, models)
        payload, status, _request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 64,
                'messages': [{'role': 'user', 'content': 'hi'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 1}],
            },
        )

    assert status == 200
    results = [block for block in payload['content'] if block['type'] == 'web_search_tool_result']
    assert isinstance(results[0]['content'], list)
    assert results[1]['content'] == {
        'type': 'web_search_tool_result_error', 'error_code': 'max_uses_exceeded',
    }
    assert payload['usage']['server_tool_use'] == {'web_search_requests': 1, 'web_fetch_requests': 0}
    assert payload['stop_reason'] == 'end_turn'


def test_anthropic_messages_web_search_failure_stays_a_200_result_block(agent_db, monkeypatch):
    """搜索上游挂掉不能把整个对话打成 5xx——只是这一次搜索失败。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000

    def failing_search():
        raise urlerror.HTTPError(
            'https://api.deepseek.com/anthropic/v1/messages', 503, 'Service Unavailable',
            {}, io.BytesIO(b'{"error":"down"}'),
        )

    _web_search_upstream(
        monkeypatch,
        [
            _anthropic_message(
                [{'type': 'tool_use', 'id': 'tu_1', 'name': 'web_search',
                  'input': {'query': 'anything'}}],
                stop_reason='tool_use',
            ),
            _anthropic_message([{'type': 'text', 'text': '搜索没成功，我先按已知信息答。'}]),
        ],
        search_response=failing_search,
    )

    with app.app_context():
        _relay_credentials(db, models)
        payload, status, _request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 64,
                'messages': [{'role': 'user', 'content': 'hi'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search'}],
            },
        )

    assert status == 200
    result = [block for block in payload['content'] if block['type'] == 'web_search_tool_result'][0]
    assert result['content']['type'] == 'web_search_tool_result_error'
    assert result['content']['error_code'] == 'unavailable'
    assert payload['stop_reason'] == 'end_turn'


def test_anthropic_messages_web_search_does_not_swallow_client_tool_calls(agent_db, monkeypatch):
    """模型同轮既搜索又调客户端工具时，客户端那一个必须原样交回去。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    _web_search_upstream(monkeypatch, [
        _anthropic_message(
            [
                {'type': 'tool_use', 'id': 'tu_1', 'name': 'web_search',
                 'input': {'query': 'Claude Code pricing'}},
                {'type': 'tool_use', 'id': 'tu_2', 'name': 'Bash', 'input': {'command': 'ls'}},
            ],
            stop_reason='tool_use',
        ),
    ])

    with app.app_context():
        _relay_credentials(db, models)
        payload, status, _request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 64,
                'messages': [{'role': 'user', 'content': 'hi'}],
                'tools': [
                    {'name': 'Bash', 'input_schema': {'type': 'object'}},
                    {'type': 'web_search_20250305', 'name': 'web_search'},
                ],
            },
        )

    assert status == 200
    # 客户端确实有工具要跑，这时 tool_use 是对的。
    assert payload['stop_reason'] == 'tool_use'
    client_calls = [block for block in payload['content'] if block['type'] == 'tool_use']
    assert client_calls == [{'type': 'tool_use', 'id': 'tu_2', 'name': 'Bash',
                             'input': {'command': 'ls'}}]
    # 搜索仍然跑完了，结果一并带回，不用浪费一轮往返。
    assert any(block['type'] == 'web_search_tool_result' for block in payload['content'])
    assert payload['usage']['server_tool_use'] == {'web_search_requests': 1, 'web_fetch_requests': 0}


def test_anthropic_messages_web_search_loop_always_terminates_with_an_answer(agent_db, monkeypatch):
    """模型一直要搜时最后一轮必须撤掉工具收尾，不能只剩搜索结果没有结论。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    keeps_searching = _anthropic_message(
        [{'type': 'tool_use', 'id': 'tu_x', 'name': 'web_search',
          'input': {'query': 'again'}}],
        stop_reason='tool_use',
    )
    captured = _web_search_upstream(monkeypatch, [keeps_searching] * 10)

    with app.app_context():
        _relay_credentials(db, models)
        payload, status, _request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 64,
                'messages': [{'role': 'user', 'content': 'hi'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 2}],
                'tool_choice': {'type': 'tool', 'name': 'web_search'},
            },
        )

    assert status == 200
    assert payload['stop_reason'] == 'end_turn'
    # 客户端绝不能收到一个待执行的 web_search 工具调用。
    assert all(block['type'] != 'tool_use' for block in payload['content'])
    conversation = [body for body in captured if not _is_search_request(body)]
    # 最后一轮撤掉了搜索工具，tool_choice 也不能再指着它。
    assert not any(
        tool.get('name') == 'web_search' for tool in conversation[-1].get('tools') or []
    )
    assert conversation[-1].get('tool_choice') in (None, {'type': 'auto'})


def test_anthropic_messages_without_the_server_tool_is_untouched(agent_db, monkeypatch):
    """没有声明 server tool 的请求必须走原来的透传路径。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    captured = _web_search_upstream(monkeypatch, [
        _anthropic_message([{'type': 'text', 'text': 'plain'}]),
    ])

    with app.app_context():
        _relay_credentials(db, models)
        payload, status, _request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 64,
                'messages': [{'role': 'user', 'content': 'hi'}],
            },
        )

    assert status == 200
    assert payload['content'] == [{'type': 'text', 'text': 'plain'}]
    assert 'server_tool_use' not in payload.get('usage', {})
    assert len(captured) == 1
    assert 'tools' not in captured[0]


def test_anthropic_messages_normalizes_returned_server_tool_history(agent_db, monkeypatch):
    """客户端会把上一轮的 server tool 块原样带回来，上游不认识这些 type。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    captured = _web_search_upstream(monkeypatch, [
        _anthropic_message([{'type': 'text', 'text': '继续。'}]),
    ])

    with app.app_context():
        _relay_credentials(db, models)
        _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 64,
                'messages': [
                    {'role': 'user', 'content': '多少钱？'},
                    {'role': 'assistant', 'content': [
                        {'type': 'server_tool_use', 'id': 's1', 'name': 'web_search',
                         'input': {'query': 'Claude Code pricing'}},
                        {'type': 'web_search_tool_result', 'tool_use_id': 's1', 'content': [
                            {'type': 'web_search_result', 'url': 'https://claude.com/pricing',
                             'title': 'Pricing'},
                        ]},
                        {'type': 'text', 'text': '按席位计费。'},
                    ]},
                    {'role': 'user', 'content': '那团队版呢？'},
                ],
            },
        )

    forwarded = json.dumps(captured[0]['messages'])
    assert 'server_tool_use' not in forwarded
    assert 'web_search_tool_result' not in forwarded
    # 信息不能丢：上一轮搜到的链接仍要留在上下文里。
    assert 'https://claude.com/pricing' in forwarded


# ─── 配额截断与错误脱敏 ───────────────────────────────────────────────────────

def test_auth_errors_give_the_real_reason_without_leaking_the_key(agent_db, monkeypatch):
    """鉴权错误的文案常常直接回显 Key，但只回一个「HTTP 401」等于吞掉真实原因。"""
    app, db, models = agent_db

    def fake_urlopen(request, timeout=None):
        raise urlerror.HTTPError(
            request.full_url, 401, 'Unauthorized', {},
            io.BytesIO(b'{"error":{"message":"invalid api key sk-relay-abc123 for tenant acme"}}'),
        )

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(db, models)
        parsed, status, request_id = _gateway(db, models).chat_completions(
            _user(), {'model': 'deepseek-v4-pro',
                      'messages': [{'role': 'user', 'content': 'hi'}]},
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
        recorded = row.error_summary or ''

    assert status == 401
    serialized = json.dumps(parsed, ensure_ascii=False)
    # Key 必须抹掉——很多厂商的鉴权错误会直接回显它。
    assert 'sk-relay-abc123' not in serialized
    # 但真实原因要给到用户，否则他既不知道是 Key 过期还是欠费，
    # 也没法告诉管理员该查什么。
    assert 'invalid api key' in parsed['error']['message']
    assert parsed['error']['type'] == 'upstream_error'
    assert parsed['error']['request_id'] == request_id
    # 管理员仍要能从用量记录里看到发生了什么。
    assert 'HTTP 401' in recorded


def test_client_side_4xx_still_passes_the_upstream_message_through(agent_db, monkeypatch):
    """普通 400 讲的是客户端自己请求的问题，原文对它有用。"""
    app, db, models = agent_db

    def fake_urlopen(request, timeout=None):
        raise urlerror.HTTPError(
            request.full_url, 400, 'Bad Request', {},
            io.BytesIO(b'{"error":{"message":"messages[0].content is required"}}'),
        )

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(db, models)
        parsed, status, _request_id = _gateway(db, models).chat_completions(
            _user(), {'model': 'deepseek-v4-pro',
                      'messages': [{'role': 'user', 'content': 'hi'}]},
        )

    assert status == 400
    assert parsed['error']['message'] == 'messages[0].content is required'


def test_quota_headroom_floor_is_opt_in(agent_db):
    """默认保持原有语义：只要还剩一点额度就放行，不替部署决定多小算小。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100
    with app.app_context():
        service = AgentUsageService(db, models)
        assert service.min_completion_headroom() == 0
        allowed = service.reserve_quota(1, 'req_a', {
            'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 4096,
        })
        assert allowed['completion_limit'] < 4096
        # 被压低这件事必须能被看见，否则客户端拿到半截回答时无从判断原因。
        assert allowed['completion_truncated'] is True

        app.config['AGENT_QUOTA_MIN_COMPLETION_HEADROOM'] = 4096
        with pytest.raises(AgentUsageError):
            service.reserve_quota(1, 'req_b', {
                'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 4096,
            })


def test_truncated_tool_call_failure_names_quota_as_the_likely_cause(agent_db, monkeypatch):
    """被配额截断的工具调用参数是残缺 JSON。

    只报「参数不是有效 JSON」会让人往协议兼容性上查，真正的原因却是配额。
    """
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100

    def fake_urlopen(request, timeout=None):
        return FakeUpstreamResponse([json.dumps({
            'id': 'c1', 'object': 'chat.completion',
            'choices': [{'index': 0, 'message': {
                'role': 'assistant', 'content': None,
                'tool_calls': [{'id': 't1', 'type': 'function', 'function': {
                    'name': 'Bash', 'arguments': '{"command": "ls -',
                }}],
            }, 'finish_reason': 'length'}],
            'usage': {'prompt_tokens': 5, 'completion_tokens': 20},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(db, models, upstream_protocol='openai-chat')
        payload, status, _request_id = _gateway(db, models).anthropic_messages(
            _user(), {'model': 'deepseek-v4-pro', 'max_tokens': 4096,
                      'messages': [{'role': 'user', 'content': 'hi'}]},
        )

    assert status == 502
    assert '配额' in payload['error']['message']


# ─── web_fetch server tool 与不支持工具的明确拒绝 ─────────────────────────────

def _fetch_result_payload(url='https://claude.com/pricing', text='每月 20 美元起。'):
    return json.dumps({
        'content': [{
            'type': 'web_fetch_tool_result', 'tool_use_id': 'up_1',
            'content': {
                'type': 'web_fetch_result', 'url': url,
                'retrieved_at': '2026-08-31T00:00:00Z',
                'content': {
                    'type': 'document', 'title': 'Pricing',
                    'citations': {'enabled': True},
                    'source': {'type': 'text', 'media_type': 'text/plain', 'data': text},
                },
            },
        }],
        'usage': {
            'input_tokens': 40, 'output_tokens': 2,
            'prompt_cache_hit_tokens': 10,
            'prompt_cache_write_tokens': 0,
            'prompt_cache_miss_tokens': 30,
        },
    }).encode('utf-8')


def test_anthropic_messages_runs_web_fetch_server_side(agent_db, monkeypatch):
    """web_fetch 与 web_search 同一条闭环，但结果块形状不同（成功也是对象）。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    _web_search_upstream(
        monkeypatch,
        [
            _anthropic_message(
                [{'type': 'tool_use', 'id': 'tu_1', 'name': 'web_fetch',
                  'input': {'url': 'https://claude.com/pricing'}}],
                stop_reason='tool_use',
            ),
            _anthropic_message([{'type': 'text', 'text': '页面写着每月 20 美元起。'}]),
        ],
        search_response=lambda: FakeUpstreamResponse([_fetch_result_payload()]),
    )

    with app.app_context():
        _relay_credentials(db, models)
        payload, status, _request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 64,
                'messages': [{'role': 'user', 'content': '读一下定价页'}],
                'tools': [{'type': 'web_fetch_20250910', 'name': 'web_fetch', 'max_uses': 1}],
            },
        )
        fetch_rows = models['AgentUsageEvent'].query.filter_by(model=SEARCH_MODEL).all()

    assert status == 200
    blocks = payload['content']
    assert blocks[0]['type'] == 'server_tool_use'
    assert blocks[0]['name'] == 'web_fetch'
    assert blocks[0]['input'] == {'url': 'https://claude.com/pricing'}
    result = blocks[1]
    assert result['type'] == 'web_fetch_tool_result'
    assert result['tool_use_id'] == blocks[0]['id']
    # 成功时是对象而不是列表——不能照搬 web_search 的判据。
    assert isinstance(result['content'], dict)
    assert result['content']['type'] == 'web_fetch_result'
    assert result['content']['content']['source']['data'] == '每月 20 美元起。'
    assert payload['stop_reason'] == 'end_turn'
    # 官方 ServerToolUsage 是两个独立计数器，抓取不能算进搜索。
    assert payload['usage']['server_tool_use'] == {
        'web_search_requests': 0, 'web_fetch_requests': 1,
    }
    assert len(fetch_rows) == 1
    assert fetch_rows[0].inbound_protocol == 'anthropic'
    assert fetch_rows[0].parent_request_id is not None
    assert fetch_rows[0].prompt_tokens == 40
    assert fetch_rows[0].completion_tokens == 2
    assert fetch_rows[0].cache_read_tokens == 10
    assert fetch_rows[0].cache_write_tokens == 0
    assert fetch_rows[0].cache_miss_tokens == 30


def test_web_fetch_respects_client_domain_restrictions(agent_db, monkeypatch):
    """域名白名单由网关执行；越界的 URL 根本不该发出去。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    captured = _web_search_upstream(monkeypatch, [
        _anthropic_message(
            [{'type': 'tool_use', 'id': 'tu_1', 'name': 'web_fetch',
              'input': {'url': 'https://evil.example/leak'}}],
            stop_reason='tool_use',
        ),
        _anthropic_message([{'type': 'text', 'text': '那个域名不在允许范围内。'}]),
    ])

    with app.app_context():
        _relay_credentials(db, models)
        payload, status, _request_id = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 64,
                'messages': [{'role': 'user', 'content': 'hi'}],
                'tools': [{'type': 'web_fetch_20250910', 'name': 'web_fetch',
                           'allowed_domains': ['claude.com']}],
            },
        )

    assert status == 200
    result = [b for b in payload['content'] if b['type'] == 'web_fetch_tool_result'][0]
    assert result['content'] == {
        'type': 'web_fetch_tool_result_error', 'error_code': 'url_not_allowed',
    }
    # 关键：越界 URL 一次上游抓取请求都没发出去。
    assert not any(_is_search_request(body) for body in captured)


def test_unsupported_server_tool_is_refused_not_forwarded(agent_db, monkeypatch):
    """网关既不执行也不静默转发——转发只会换来一个谁都不执行的 tool_use。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    captured = _web_search_upstream(monkeypatch, [
        _anthropic_message([{'type': 'text', 'text': 'unreachable'}]),
    ])

    with app.app_context():
        _relay_credentials(db, models)
        with pytest.raises(AgentGatewayError) as exc_info:
            _gateway(db, models).anthropic_messages(
                _user(), {
                    'model': CONVERSATION_MODEL, 'max_tokens': 64,
                    'messages': [{'role': 'user', 'content': 'hi'}],
                    'tools': [{'type': 'code_execution_20250522', 'name': 'code_execution'}],
                },
            )

    # API 层会把它转成 400，客户端看到的是可操作的原因而不是干等。
    assert exc_info.value.status_code == 400
    assert 'code_execution_20250522' in exc_info.value.message
    # 一次都没有转发给上游。
    assert captured == []


def test_count_tokens_answers_without_calling_upstream(agent_db, monkeypatch):
    """客户端据此判断何时压缩上下文；缺这个端点它只能退回更粗的本地估算。"""
    app, db, models = agent_db
    calls = {'n': 0}

    def fake_urlopen(request, timeout=None):
        calls['n'] += 1
        raise AssertionError('count_tokens 不该打上游')

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        payload, status, request_id = _gateway(db, models).count_tokens(
            _user(), {'model': 'x', 'messages': [{'role': 'user', 'content': 'hello world'}]},
        )
    assert status == 200
    assert request_id
    assert isinstance(payload['input_tokens'], int) and payload['input_tokens'] > 0
    assert calls['n'] == 0


def test_count_tokens_excludes_server_tool_declarations(agent_db):
    """服务端工具声明不会原样发给上游，计进去会偏高。"""
    app, db, models = agent_db
    with app.app_context():
        service = _gateway(db, models)
        plain = service.count_tokens(_user(), {
            'model': 'x', 'messages': [{'role': 'user', 'content': 'hi'}],
        })[0]['input_tokens']
        with_tool = service.count_tokens(_user(), {
            'model': 'x', 'messages': [{'role': 'user', 'content': 'hi'}],
            'tools': [{'type': 'web_search_20250305', 'name': 'web_search'}],
        })[0]['input_tokens']
    assert with_tool == plain


def test_search_skips_accounts_whose_base_url_has_no_anthropic_endpoint(agent_db, monkeypatch):
    """搜索打的是 Anthropic Messages 形状，那个地址必须真实存在。

    把一个 /compatible-mode/v1 基址拼成 /v1/messages 只会换回 400——实测过。
    """
    app, db, models = agent_db
    calls = {'n': 0}

    def fake_urlopen(request, timeout=None):
        calls['n'] += 1
        raise AssertionError('不该对这把账号发起搜索请求')

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(
            db, models, name='chat-only', provider='openai-compatible',
            upstream_protocol='openai-chat',
            base_url='https://relay.example/compatible-mode/v1',
            models_json='["qwen3.8-flash"]', default_model='qwen3.8-flash',
        )
        with pytest.raises(AgentGatewayError) as exc_info:
            _gateway(db, models).web_search(_user(), 'hello')

    assert exc_info.value.status_code == 503
    assert calls['n'] == 0
    assert '服务端搜索端点' in exc_info.value.message


def test_deepseek_chat_accounts_keep_their_sibling_anthropic_endpoint(agent_db, monkeypatch):
    """DeepSeek 在 Chat 基址旁边确实有 /anthropic/v1/messages，不能被一起挡掉。"""
    app, db, models = agent_db
    seen = []

    def fake_urlopen(request, timeout=None):
        seen.append(request.full_url)
        return FakeUpstreamResponse([json.dumps({
            'content': [{'type': 'web_search_tool_result', 'content': [
                {'type': 'web_search_result', 'url': 'https://a.io', 'title': 'A'},
            ]}],
            'usage': {'input_tokens': 3, 'output_tokens': 1},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(
            db, models, provider='deepseek', upstream_protocol='openai-chat',
            base_url='https://api.deepseek.com',
            models_json='["deepseek-v4-pro"]', default_model='deepseek-v4-pro',
        )
        payload, status, _rid = _gateway(db, models).web_search(_user(), 'hello')

    assert status == 200
    assert payload['sources'][0]['url'] == 'https://a.io'
    assert seen == ['https://api.deepseek.com/anthropic/v1/messages']


def test_a_hard_4xx_on_search_is_remembered_so_it_is_not_retried(agent_db, monkeypatch):
    """上游明确拒绝这个请求形状＝它给不了服务端搜索，别每次都白打一发。"""
    app, db, models = agent_db
    calls = {'n': 0}

    def fake_urlopen(request, timeout=None):
        calls['n'] += 1
        raise urlerror.HTTPError(
            request.full_url, 400, 'Bad Request', {},
            io.BytesIO(b'{"code":"InvalidParameter","message":"url error"}'),
        )

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        cred = _add_credential(
            db, models, provider='openai-compatible',
            upstream_protocol='anthropic-messages',
            models_json='["qwen3.8-flash"]', default_model='qwen3.8-flash',
        )
        with pytest.raises(AgentGatewayError):
            _gateway(db, models).web_search(_user(), 'hello')
        first = calls['n']
        with pytest.raises(AgentGatewayError):
            _gateway(db, models).web_search(_user(), 'again')
        health = cred.health_status

    assert first >= 1
    assert calls['n'] == first, '已知拒绝该形状的账号不该被再次尝试'
    # 400 不可重试，不该扣健康分——它只是不支持这个形状，不是坏了。
    assert health != 'cooldown'


def test_search_can_be_executed_by_a_responses_account(agent_db, monkeypatch):
    """闭环的执行方不再只会讲 Anthropic Messages。

    实测里能搜的那把账号恰恰是 Responses 上游，只会一种协议就等于搜不了。
    """
    app, db, models = agent_db
    seen = []

    def fake_urlopen(request, timeout=None):
        seen.append(request.full_url)
        return FakeUpstreamResponse([json.dumps({
            'output': [{'type': 'web_search_call', 'action': {
                'type': 'search', 'queries': ['coati'],
                'sources': [{'type': 'url', 'url': 'https://a.io'}],
            }}],
            'usage': {'input_tokens': 5, 'output_tokens': 2},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(
            db, models, name='responses-search', provider='openai-compatible',
            upstream_protocol='openai-responses',
            base_url='https://relay.example/compatible-mode/v1',
            models_json='["qwen3.8-flash"]', default_model='qwen3.8-flash',
        )
        payload, status, _rid = _gateway(db, models).web_search(_user(), 'coati gateway')

    assert status == 200
    assert payload['sources'] == [{'url': 'https://a.io', 'title': 'https://a.io'}]
    assert seen == ['https://relay.example/compatible-mode/v1/responses']


def test_client_and_upstream_tool_ids_do_not_get_mixed_up(agent_db, monkeypatch):
    """面向客户端的块要归一成 srvtoolu_，回喂上游的 tool_result 必须用原 id。

    混用会让上游认不出这是哪次调用的结果。
    """
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    captured = _web_search_upstream(monkeypatch, [
        _anthropic_message(
            [{'type': 'tool_use', 'id': 'call_abc-123', 'name': 'web_search',
              'input': {'query': 'coati'}}],
            stop_reason='tool_use',
        ),
        _anthropic_message([{'type': 'text', 'text': '好了。'}]),
    ])

    with app.app_context():
        _relay_credentials(db, models)
        payload, status, _rid = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 64,
                'messages': [{'role': 'user', 'content': 'hi'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search'}],
            },
        )

    assert status == 200
    use = [b for b in payload['content'] if b['type'] == 'server_tool_use'][0]
    result = [b for b in payload['content'] if b['type'] == 'web_search_tool_result'][0]
    # 客户端侧：连字符被换掉，前缀补齐。
    assert use['id'] == 'srvtoolu_call_abc_123'
    assert result['tool_use_id'] == use['id']
    # 上游侧：必须还是它自己给的那个 id。
    conversation = [b for b in captured if not _is_search_request(b)]
    replayed = json.dumps(conversation[1]['messages'], ensure_ascii=False)
    assert '"tool_use_id": "call_abc-123"' in replayed
    assert 'srvtoolu_' not in replayed


def test_pure_search_request_never_reaches_the_conversation_upstream(agent_db, monkeypatch):
    """Claude Code 的搜索子请求让模型参与没有意义，却要付两轮以上的 token。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    captured = _web_search_upstream(monkeypatch, [
        _anthropic_message([{'type': 'text', 'text': 'unreachable'}]),
    ])

    with app.app_context():
        conversation, _search = _relay_credentials(db, models)
        # 生产里这一步由首次探测得出；这里直接预置，让搜索确定地落到能搜的那把，
        # 避免断言被「打到不能搜的账号」这一次尝试干扰。
        WEB_SEARCH_SUPPORT.record(conversation.id, False)
        payload, status, _rid = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 1024,
                'messages': [{'role': 'user', 'content':
                              'Perform a web search for the query: Claude Code pricing'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search'}],
            },
        )

    assert status == 200
    assert [b['type'] for b in payload['content']] == [
        'server_tool_use', 'web_search_tool_result', 'text',
    ]
    assert payload['content'][0]['input'] == {'query': 'Claude Code pricing'}
    assert payload['stop_reason'] == 'end_turn'
    assert payload['usage']['server_tool_use']['web_search_requests'] == 1
    # 只打了搜索那一发，对话上游一次都没碰。
    assert all(_is_search_request(body) for body in captured)


def test_short_circuit_falls_back_to_the_full_loop_when_search_fails(agent_db, monkeypatch):
    """省 token 不能以功能变差为代价：搜不到就退回闭环，让模型至少能说明情况。"""
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000

    def failing_search():
        raise urlerror.HTTPError('https://x', 503, 'down', {}, io.BytesIO(b'{}'))

    captured = _web_search_upstream(
        monkeypatch,
        [_anthropic_message([{'type': 'text', 'text': '搜索不可用，我按已知信息回答。'}])],
        search_response=failing_search,
    )

    with app.app_context():
        conversation, _search = _relay_credentials(db, models)
        # 生产里这一步由首次探测得出；这里直接预置，让搜索确定地落到能搜的那把，
        # 避免断言被「打到不能搜的账号」这一次尝试干扰。
        WEB_SEARCH_SUPPORT.record(conversation.id, False)
        payload, status, _rid = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 256,
                'messages': [{'role': 'user', 'content':
                              'Perform a web search for the query: anything'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search'}],
            },
        )

    assert status == 200
    # 退回了正常路径：对话上游被调用过。
    assert any(not _is_search_request(body) for body in captured)
    assert payload['stop_reason'] == 'end_turn'


def test_short_circuit_can_be_switched_off(agent_db, monkeypatch):
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    app.config['AGENT_WEB_SEARCH_SHORTCUT_ENABLED'] = False
    captured = _web_search_upstream(monkeypatch, [
        _anthropic_message(
            [{'type': 'tool_use', 'id': 'tu_1', 'name': 'web_search',
              'input': {'query': 'x'}}], stop_reason='tool_use'),
        _anthropic_message([{'type': 'text', 'text': '好。'}]),
    ])

    with app.app_context():
        _relay_credentials(db, models)
        _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 256,
                'messages': [{'role': 'user', 'content':
                              'Perform a web search for the query: x'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search'}],
            },
        )

    assert any(not _is_search_request(body) for body in captured)


def test_leaked_tool_call_text_triggers_a_retry_with_the_plain_tool(agent_db, monkeypatch):
    """第三种回包形状：上游把工具调用吐成了正文。

    实测阿里云 MaaS 的 Anthropic 兼容入口就是这样。不识别的话，这段
    <tool_call> 标记会原样暴露给客户端——同一个请求换把账号就好了，
    正是这种「时好时坏」最不能接受。
    """
    app, db, models = agent_db
    app.config['AGENT_DAILY_TOKEN_QUOTA'] = 100000
    turns = [
        # 第一发：按原生形状问，上游把调用吐成文本。
        _anthropic_message([
            {'type': 'text',
             'text': 'I will search.\n<tool_call>\n<function=web_search>\n'
                     '<parameter=queries> ["Claude Code pricing"]'},
        ]),
        # 重试：换成带 schema 的普通工具，模型给出结构化调用。
        _anthropic_message(
            [{'type': 'tool_use', 'id': 'tu_1', 'name': 'web_search',
              'input': {'query': 'Claude Code pricing'}}],
            stop_reason='tool_use',
        ),
        _anthropic_message([{'type': 'text', 'text': '按席位计费。'}]),
    ]
    captured = _web_search_upstream(monkeypatch, turns)

    with app.app_context():
        conversation, _search = _relay_credentials(db, models)
        # 曾经确认会执行，之后开始吐畸形回包——这是原生路径唯一会遇到泄漏的情形。
        WEB_SEARCH_SUPPORT.record(conversation.id, True)
        payload, status, _rid = _gateway(db, models).anthropic_messages(
            _user(), {
                'model': CONVERSATION_MODEL, 'max_tokens': 256,
                'messages': [{'role': 'user', 'content': '多少钱？'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search'}],
            },
        )
        learned = WEB_SEARCH_SUPPORT.executes(conversation.id)

    assert status == 200
    serialized = json.dumps(payload, ensure_ascii=False)
    # 那段标记绝不能出现在交付给客户端的内容里。
    assert '<tool_call>' not in serialized
    assert '<function=' not in serialized
    # 重试之后闭环正常跑完。
    assert any(b['type'] == 'web_search_tool_result' for b in payload['content'])
    assert payload['stop_reason'] == 'end_turn'
    assert payload['usage']['server_tool_use']['web_search_requests'] == 1
    # 这把账号已被记住不执行，下次直接用普通工具，不再浪费那一发。
    assert learned is False
    conversation_calls = [b for b in captured if not _is_search_request(b)]
    assert len(conversation_calls) == 3


# ─── 搜索执行方的调度：全局 Provider 优先，模型账号兜底 ───────────────────────

def _fake_provider(sources=None, raises=None):
    # gateway_service 是 from ... import 进来的名字，必须打在它自己的命名空间上。
    from backend.app.agent.service import gateway_service as gs

    class Stub:
        code = 'tavily'
        label = 'Tavily'

        def search(self, query, *, limit=5, allowed_domains=(), blocked_domains=()):
            if raises:
                raise raises
            return sources or []

        def fetch(self, url):
            if raises:
                raise raises
            return {'url': url, 'title': 'T', 'text': '正文', 'retrieved_at': None}

    return Stub(), gs


def test_configured_provider_is_preferred_over_model_accounts(agent_db, monkeypatch):
    """委托模型账号一次搜索要花一次完整推理（实测 17 秒），Provider 约 1 秒。"""
    app, db, models = agent_db
    stub, module = _fake_provider(sources=[{'url': 'https://a.io', 'title': 'A', 'snippet': 's'}])
    monkeypatch.setattr(module, 'configured_search_provider', lambda: stub)

    def fake_urlopen(request, timeout=None):
        raise AssertionError('配了 Provider 就不该再去打模型账号')

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(db, models, provider='deepseek', upstream_protocol='anthropic-messages')
        payload, status, _rid = _gateway(db, models).web_search(_user(), 'coati')

    assert status == 200
    assert payload['sources'] == [{'url': 'https://a.io', 'title': 'A', 'snippet': 's'}]


def test_provider_failure_falls_back_to_model_accounts(agent_db, monkeypatch):
    """Provider 挂了不能让搜索直接死——模型账号仍然是兜底。"""
    app, db, models = agent_db
    from backend.app.agent.service.search_providers import SearchProviderError
    stub, module = _fake_provider(raises=SearchProviderError('Tavily 不可达'))
    monkeypatch.setattr(module, 'configured_search_provider', lambda: stub)

    def fake_urlopen(request, timeout=None):
        return FakeUpstreamResponse([json.dumps({
            'content': [{'type': 'web_search_tool_result', 'content': [
                {'type': 'web_search_result', 'url': 'https://fallback.io', 'title': 'F'},
            ]}],
            'usage': {'input_tokens': 3, 'output_tokens': 1},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(db, models, provider='deepseek', upstream_protocol='anthropic-messages')
        payload, status, _rid = _gateway(db, models).web_search(_user(), 'coati')

    assert status == 200
    assert payload['sources'][0]['url'] == 'https://fallback.io'


def test_provider_also_serves_web_fetch(agent_db, monkeypatch):
    """web_fetch 此前在这套账号上完全没有执行方；Provider 把它补上了。

    抓取仍由 Provider 发起，网关自身不对任意 URL 发请求，SSRF 面依然为零。
    """
    app, db, models = agent_db
    stub, module = _fake_provider()
    monkeypatch.setattr(module, 'configured_search_provider', lambda: stub)
    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda *a, **k: (_ for _ in ()).throw(AssertionError('不该打模型账号')),
    )
    with app.app_context():
        _add_credential(db, models, provider='deepseek', upstream_protocol='anthropic-messages')
        fetched, status, _rid = _gateway(db, models).web_fetch(_user(), 'https://a.io/p')

    assert status == 200
    assert fetched['text'] == '正文'


# ─── Responses 入站的内置工具：选路要认得这个能力 ─────────────────────────────

def test_responses_builtin_tools_prefer_an_account_that_can_execute_them(agent_db, monkeypatch):
    """Codex 会声明 Responses 内置 web_search，跨协议转换不了。

    不认这个能力的话，同一个请求换把账号就会被桥接拒掉——正是要避免的时好时坏。
    """
    app, db, models = agent_db
    seen = []

    def fake_urlopen(request, timeout=None):
        seen.append(request.full_url)
        return FakeUpstreamResponse([json.dumps({
            'id': 'resp_1', 'status': 'completed',
            'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': 'ok'}]}],
            'usage': {'input_tokens': 5, 'output_tokens': 2},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        # 高优先级的账号讲 anthropic-messages，转换不了内置工具。
        _add_credential(
            db, models, name='anthropic-first', provider='openai-compatible', priority=300,
            upstream_protocol='anthropic-messages', base_url='https://relay.example/apps/anthropic',
            models_json='["m"]', default_model='m',
        )
        responses_cred = _add_credential(
            db, models, name='responses-native', provider='openai-compatible', priority=100,
            upstream_protocol='openai-responses', base_url='https://relay.example/v1',
            models_json='["m"]', default_model='m',
        )
        WEB_SEARCH_SUPPORT.record(responses_cred.id, True)
        _payload, status, _rid = _gateway(db, models).openai_responses(
            _user(), {
                'model': 'm', 'input': [{'type': 'message', 'role': 'user', 'content': 'hi'}],
                'tools': [{'type': 'web_search'}],
            },
        )

    assert status == 200
    # 优先级更高的那把被让开了：能执行内置工具的排到了前面。
    assert seen == ['https://relay.example/v1/responses']


def test_plain_responses_requests_keep_the_normal_routing_order(agent_db, monkeypatch):
    """没有内置工具的请求不该被这条偏好干扰，优先级仍然说了算。"""
    app, db, models = agent_db
    seen = []

    def fake_urlopen(request, timeout=None):
        seen.append(request.full_url)
        return FakeUpstreamResponse([json.dumps({
            'id': 'msg_1', 'type': 'message', 'role': 'assistant',
            'content': [{'type': 'text', 'text': 'ok'}], 'stop_reason': 'end_turn',
            'usage': {'input_tokens': 3, 'output_tokens': 1},
        }).encode('utf-8')])

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(
            db, models, name='anthropic-first', provider='openai-compatible', priority=300,
            upstream_protocol='anthropic-messages', base_url='https://relay.example/apps/anthropic',
            models_json='["m"]', default_model='m',
        )
        cred = _add_credential(
            db, models, name='responses-native', provider='openai-compatible', priority=100,
            upstream_protocol='openai-responses', base_url='https://relay.example/v1',
            models_json='["m"]', default_model='m',
        )
        WEB_SEARCH_SUPPORT.record(cred.id, True)
        _gateway(db, models).openai_responses(
            _user(), {'model': 'm', 'input': [{'type': 'message', 'role': 'user', 'content': 'hi'}]},
        )

    assert seen == ['https://relay.example/apps/anthropic/v1/messages']


def test_previous_response_id_is_refused_not_silently_dropped(agent_db, monkeypatch):
    """网关不持久化 Responses，且跨账号调度——A 签发的 id 在 B 上不存在。

    静默丢弃会让客户端以为续上了对话，实际上下文全没了，比报错糟得多。
    """
    app, db, models = agent_db
    monkeypatch.setattr(
        gateway_urlrequest, 'urlopen',
        lambda *a, **k: (_ for _ in ()).throw(AssertionError('不该打上游')),
    )
    with app.app_context():
        _add_credential(db, models, upstream_protocol='openai-responses',
                        models_json='["m"]', default_model='m')
        with pytest.raises(AgentGatewayError) as exc_info:
            _gateway(db, models).openai_responses(_user(), {
                'model': 'm', 'previous_response_id': 'resp_abc',
                'input': [{'type': 'message', 'role': 'user', 'content': 'hi'}],
            })

    assert exc_info.value.status_code == 400
    assert 'previous_response_id' in exc_info.value.message
    # 与 GET /v1/responses/<id> 的 404 提示保持一致的口径。
    assert 'input' in exc_info.value.message


def test_sse_shaped_error_bodies_are_unwrapped_not_stringified():
    """流式出错时上游可能回一整帧 SSE，message 里还套一层 data: {json}。

    当字符串塞进 {'error': ...} 的话客户端要剥三层，实际等于没有错误信息。
    """
    from backend.app.agent.service.gateway_service import parse_upstream_error_body
    raw = (
        'event:error\n'
        'data:{"request_id":"a50b7ee4","code":"InvalidParameter",'
        '"message":"data: {\\"error\\":{\\"code\\":\\"invalid_parameter_error\\",'
        '\\"message\\":\\"conflict\\",\\"type\\":\\"invalid_request_error\\"}}"}'
    )
    parsed = parse_upstream_error_body(raw)
    assert parsed['message'] == 'conflict'
    assert parsed['type'] == 'invalid_request_error'


def test_plain_json_error_bodies_are_untouched():
    from backend.app.agent.service.gateway_service import parse_upstream_error_body
    assert parse_upstream_error_body('{"error":{"message":"bad request"}}') == {
        'error': {'message': 'bad request'},
    }
    # 非 JSON 垃圾仍然返回 None，交给调用方回落到截断原文。
    assert parse_upstream_error_body('<html>502</html>') is None
    assert parse_upstream_error_body('') is None


def test_streaming_upstream_error_reaches_the_client_readable(agent_db, monkeypatch):
    app, db, models = agent_db

    def fake_urlopen(request, timeout=None):
        raise urlerror.HTTPError(
            request.full_url, 400, 'Bad Request', {},
            io.BytesIO(
                b'event:error\ndata:{"code":"InvalidParameter",'
                b'"message":"data: {\\"error\\":{\\"message\\":\\"conflict\\"}}"}'
            ),
        )

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.app_context():
        _add_credential(db, models, upstream_protocol='anthropic-messages')
        payload, status, _rid = _gateway(db, models).anthropic_messages(
            _user(), {'model': 'deepseek-v4-pro', 'max_tokens': 64, 'stream': True,
                      'messages': [{'role': 'user', 'content': 'hi'}]},
        )

    assert status == 400
    serialized = json.dumps(payload, ensure_ascii=False)
    # 不再是 SSE 原文套字符串。
    assert 'event:error' not in serialized
    assert 'conflict' in serialized


def test_secret_redaction_keeps_the_diagnosis():
    from backend.app.agent.service.gateway_service import redact_secrets
    # 已知密钥按原样抹除。
    assert redact_secrets('bad key sk-relay-abc123 here', 'sk-relay-abc123') == \
        'bad key sk-r*** here'
    # 未知但形如密钥的串同样抹掉。
    assert 'tvly-0123456789ab' not in redact_secrets('invalid tvly-0123456789ab', None)
    # 正常文案一个字都不动。
    assert redact_secrets('Insufficient Balance') == 'Insufficient Balance'
    assert redact_secrets('') == ''
