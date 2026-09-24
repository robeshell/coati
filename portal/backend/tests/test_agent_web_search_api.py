# -*- coding: utf-8 -*-
"""网页搜索的两个入口。

- POST /api/agent/v1/web-search：工作台 COATI 搜索经门户打上游服务端搜索。
- POST /api/agent/v1/messages 带 web_search server tool：Claude Code 的 WebSearch
  走的这条，搜索必须由网关自己闭环，客户端拿到的是已经搜完的结果块。
"""

import json

from flask import Blueprint, Flask
from flask_sqlalchemy import SQLAlchemy

from backend.app.agent.api import register_agent_routes
from backend.app.agent.model import build_agent_models
from backend.app.agent.service.bearer import hash_token
from backend.app.agent.service.credential_crypto import encrypt_api_key
from backend.app.agent.service.gateway_service import urlrequest as gateway_urlrequest
from backend.app.agent.service.server_tools import WEB_SEARCH_SUPPORT


def _agent_app():
    # 服务端工具的观测结果是进程级的，账号 id 在各用例间会重复。
    WEB_SEARCH_SUPPORT.clear()
    app = Flask(__name__)
    app.config.update(
        SQLALCHEMY_DATABASE_URI='sqlite://',
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        AGENT_CREDENTIAL_ENCRYPTION_KEY='test-only-encryption-key',
        AGENT_GATEWAY_MAX_ATTEMPTS=3,
        AGENT_DAILY_TOKEN_QUOTA=10000,
        AGENT_QUOTA_DEFAULT_MAX_OUTPUT_TOKENS=2048,
        AGENT_CREDENTIAL_FAILURE_THRESHOLD=3,
        AGENT_CREDENTIAL_COOLDOWN_SECONDS=60,
    )
    db = SQLAlchemy(app)

    class Admin(db.Model):
        __tablename__ = 'admin_users'
        id = db.Column(db.Integer, primary_key=True)
        username = db.Column(db.String(100), nullable=False)

        def to_dict(self):
            return {'id': self.id, 'username': self.username}

    models = {'Admin': Admin, **build_agent_models(db)}
    bp = Blueprint('agent_test', __name__)
    register_agent_routes(bp, db, models, app=app)
    app.register_blueprint(bp)
    with app.app_context():
        db.create_all()
        db.session.add(Admin(id=1, username='tester'))
        db.session.commit()
    return app, db, models


def _make_pat(app, db, models, raw='coati_test_token', scopes=None):
    with app.app_context():
        pat = models['AgentPat'](
            user_id=1,
            name='test',
            token_prefix=raw[:8],
            token_hash=hash_token(raw),
            scopes_json=json.dumps(scopes or ['chat', 'profile']),
        )
        db.session.add(pat)
        db.session.commit()


def _make_credential(app, db, models):
    with app.app_context():
        cred = models['AgentLlmCredential'](
            name='test-cred',
            provider='deepseek',
            base_url='https://api.deepseek.com',
            api_key=encrypt_api_key('sk-test-key'),
            api_key_hint='sk-t',
            key_fingerprint='fp-test',
            models_json=json.dumps(['deepseek-v4-pro', 'deepseek-v4-flash']),
            default_model='deepseek-v4-pro',
            enabled=True,
        )
        db.session.add(cred)
        db.session.commit()


class _FakeUpstream:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode('utf-8')
        self.headers = {'Content-Type': 'application/json'}

    def read(self, size=None):
        data, self._payload = self._payload, b''
        return data

    def close(self):
        return None


def test_web_search_requires_bearer():
    app, _, _ = _agent_app()
    with app.test_client() as client:
        response = client.post('/api/agent/v1/web-search', json={'query': 'hello'})
    assert response.status_code == 401


def test_web_search_requires_chat_scope():
    app, db, models = _agent_app()
    _make_pat(app, db, models, scopes=['profile'])
    with app.test_client() as client:
        response = client.post(
            '/api/agent/v1/web-search',
            json={'query': 'hello'},
            headers={'Authorization': 'Bearer coati_test_token'},
        )
    assert response.status_code == 403
    assert response.get_json()['required_scope'] == 'chat'


def test_web_search_returns_sources(monkeypatch):
    app, db, models = _agent_app()
    _make_pat(app, db, models)
    _make_credential(app, db, models)

    def fake_urlopen(request, timeout=None):
        return _FakeUpstream({
            'content': [{
                'type': 'web_search_tool_result',
                'content': [
                    {'type': 'web_search_result', 'url': 'https://nodejs.org/en', 'title': 'Node.js'},
                ],
            }],
            'usage': {'input_tokens': 3, 'output_tokens': 1},
        })

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.test_client() as client:
        response = client.post(
            '/api/agent/v1/web-search',
            json={'query': 'Node.js', 'max_results': 3},
            headers={
                'Authorization': 'Bearer coati_test_token',
                'X-COATI-Session-ID': 'api-search-session',
                'X-COATI-Request-ID': 'api-search-request',
            },
        )
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['query'] == 'Node.js'
    assert payload['sources'][0]['url'] == 'https://nodejs.org/en'
    request_id = response.headers.get('X-Agent-Request-Id')
    assert request_id
    with app.app_context():
        row = models['AgentUsageEvent'].query.filter_by(request_id=request_id).one()
    assert row.session_id == 'api-search-session'
    assert row.client_request_id == 'api-search-request'
    assert row.inbound_protocol == 'web-search'


def _chat_completion(message):
    return {
        'id': 'chatcmpl-1', 'object': 'chat.completion', 'model': 'deepseek-v4-pro',
        'choices': [{'index': 0, 'message': message,
                     'finish_reason': 'tool_calls' if message.get('tool_calls') else 'stop'}],
        'usage': {'prompt_tokens': 11, 'completion_tokens': 7},
    }


def test_messages_endpoint_runs_web_search_server_tool_end_to_end(monkeypatch):
    """验收口径：网关返回搜完的结果，不是一个没人执行的 tool_use。"""
    seen = []

    def fake_urlopen(request, timeout=None):
        seen.append(request.full_url)
        if request.full_url.endswith('/anthropic/v1/messages'):
            # 上游的服务端搜索接口。
            return _FakeUpstream({
                'content': [{
                    'type': 'web_search_tool_result',
                    'content': [{
                        'type': 'web_search_result', 'url': 'https://claude.com/pricing',
                        'title': 'Claude Code Pricing', 'snippet': '$20/月起。',
                    }],
                }],
                'usage': {'input_tokens': 3, 'output_tokens': 1},
            })
        # 对话上游：第一轮请求搜索，第二轮给结论。
        rounds = [url for url in seen if url.endswith('/chat/completions')]
        if len(rounds) == 1:
            return _FakeUpstream(_chat_completion({
                'role': 'assistant', 'content': None,
                'tool_calls': [{
                    'id': 'call_1', 'type': 'function',
                    'function': {'name': 'web_search',
                                 'arguments': '{"queries": "[\\"Claude Code pricing\\"]"}'},
                }],
            }))
        return _FakeUpstream(_chat_completion({
            'role': 'assistant', 'content': 'Claude Code 从每月 20 美元起。',
        }))

    app, db, models = _agent_app()
    _make_pat(app, db, models)
    _make_credential(app, db, models)
    monkeypatch.setattr(gateway_urlrequest, 'urlopen', fake_urlopen)
    with app.test_client() as client:
        response = client.post(
            '/api/agent/v1/messages',
            json={
                'model': 'deepseek-v4-pro', 'max_tokens': 256,
                'messages': [{'role': 'user', 'content': 'Claude Code 多少钱？'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search', 'max_uses': 1}],
            },
            headers={'Authorization': 'Bearer coati_test_token'},
        )

    assert response.status_code == 200
    payload = response.get_json()
    results = [b for b in payload['content'] if b['type'] == 'web_search_tool_result']
    assert results, payload['content']
    assert isinstance(results[0]['content'], list)
    assert results[0]['content'][0]['url'] == 'https://claude.com/pricing'
    assert payload['usage']['server_tool_use']['web_search_requests'] >= 1
    assert payload['stop_reason'] == 'end_turn'
    # server_tool_use 必须紧挨着它对应的结果块。
    types = [b['type'] for b in payload['content']]
    index = types.index('web_search_tool_result')
    assert types[index - 1] == 'server_tool_use'
    assert payload['content'][index - 1]['id'] == results[0]['tool_use_id']


def test_messages_endpoint_reports_missing_search_account_as_a_result_block(monkeypatch):
    """号池里没有能搜索的账号时，也只能是结果块里的错误，不能打成 5xx。"""
    calls = {'n': 0}

    def dispatch(request, timeout=None):
        calls['n'] += 1
        if calls['n'] == 1:
            return _FakeUpstream(_chat_completion({
                'role': 'assistant', 'content': None,
                'tool_calls': [{
                    'id': 'call_1', 'type': 'function',
                    'function': {'name': 'web_search', 'arguments': '{"query": "anything"}'},
                }],
            }))
        return _FakeUpstream(_chat_completion({'role': 'assistant', 'content': '我没能联网。'}))

    app, db, models = _agent_app()
    _make_pat(app, db, models)
    with app.app_context():
        # openai-compatible 不声明 web_search 能力：能对话，但搜不了。
        cred = models['AgentLlmCredential'](
            name='no-search', provider='openai-compatible',
            base_url='https://relay.example/v1', api_key=encrypt_api_key('sk-x'),
            api_key_hint='sk', key_fingerprint='fp-nosearch',
            models_json=json.dumps(['glm-5']), default_model='glm-5', enabled=True,
        )
        db.session.add(cred)
        db.session.commit()
    monkeypatch.setattr(gateway_urlrequest, 'urlopen', dispatch)
    with app.test_client() as client:
        response = client.post(
            '/api/agent/v1/messages',
            json={
                'model': 'glm-5', 'max_tokens': 256,
                'messages': [{'role': 'user', 'content': 'hi'}],
                'tools': [{'type': 'web_search_20250305', 'name': 'web_search'}],
            },
            headers={'Authorization': 'Bearer coati_test_token'},
        )

    assert response.status_code == 200
    payload = response.get_json()
    result = [b for b in payload['content'] if b['type'] == 'web_search_tool_result'][0]
    assert result['content'] == {
        'type': 'web_search_tool_result_error', 'error_code': 'unavailable',
    }
    assert payload['stop_reason'] == 'end_turn'
