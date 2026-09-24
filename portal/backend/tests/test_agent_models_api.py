# -*- coding: utf-8 -*-
"""GET /api/agent/v1/models —— dsh 模型发现（OpenAI 兼容清单）路由测试。

dsh 的 pi-ai 适配器在模型发现时请求 {base}/models，此前 portal 网关只实现
了 /chat/completions，导致该端点 404、模型下拉获取失败。这里覆盖：
Bearer 鉴权、profile scope、credential + route 模型合并、空配置、禁用项过滤。
"""

import json

import pytest
from flask import Blueprint, Flask
from flask_sqlalchemy import SQLAlchemy

from backend.app.agent.api import register_agent_routes
from backend.app.agent.model import build_agent_models
from backend.app.agent.service.bearer import hash_token
from backend.app.agent.service.credential_crypto import encrypt_api_key


@pytest.fixture()
def agent_app():
    app = Flask(__name__)
    app.config.update(
        SQLALCHEMY_DATABASE_URI='sqlite://',
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        AGENT_CREDENTIAL_ENCRYPTION_KEY='test-only-encryption-key',
        AGENT_GATEWAY_MAX_ATTEMPTS=3,
        AGENT_DAILY_TOKEN_QUOTA=100,
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


def make_pat(app, db, models, raw='coati_test_token', scopes=None, user_id=1):
    with app.app_context():
        pat = models['AgentPat'](
            user_id=user_id,
            name='test',
            token_prefix=raw[:8],
            token_hash=hash_token(raw),
            scopes_json=json.dumps(scopes or ['chat', 'profile']),
        )
        db.session.add(pat)
        db.session.commit()
    return pat


def make_credential(app, db, models, *, models_list=None, default_model='deepseek-v4-pro',
                    provider='deepseek', upstream_protocol='openai-chat', enabled=True):
    with app.app_context():
        cred = models['AgentLlmCredential'](
            name='test-cred',
            provider=provider,
            upstream_protocol=upstream_protocol,
            base_url='https://api.example.com/v1',
            api_key=encrypt_api_key('sk-test-key'),
            api_key_hint='sk-t',
            key_fingerprint='fp-test',
            models_json=json.dumps(models_list or []),
            default_model=default_model,
            enabled=enabled,
        )
        db.session.add(cred)
        db.session.commit()
    return cred


def make_route(app, db, models, model_name, enabled=True):
    with app.app_context():
        route = models['AgentRouteConfig'](
            model_name=model_name,
            upstream_model=None,
            enabled=enabled,
        )
        db.session.add(route)
        db.session.commit()
    return route


def test_models_requires_bearer(agent_app):
    app, _, _ = agent_app
    with app.test_client() as client:
        response = client.get('/api/agent/v1/models')
    assert response.status_code == 401
    assert response.get_json()['error']


def test_models_accepts_x_api_key(agent_app):
    app, db, models = agent_app
    make_pat(app, db, models)
    make_route(app, db, models, 'visible')
    with app.test_client() as client:
        response = client.get('/api/agent/v1/models', headers={'X-Api-Key': 'coati_test_token'})
    assert response.status_code == 200
    assert [entry['id'] for entry in response.get_json()['data']] == ['visible']


def test_models_requires_profile_scope(agent_app):
    app, db, models = agent_app
    make_pat(app, db, models, scopes=['chat'])
    with app.test_client() as client:
        response = client.get('/api/agent/v1/models',
                              headers={'Authorization': 'Bearer coati_test_token'})
    assert response.status_code == 403
    assert response.get_json()['required_scope'] == 'profile'


def test_models_lists_credential_and_route_models(agent_app):
    """路由别名置顶，真实模型按厂商分组返回。"""
    app, db, models = agent_app
    make_pat(app, db, models)
    make_credential(app, db, models, models_list=['alpha', 'beta'], default_model='gamma')
    make_route(app, db, models, 'route-model')
    with app.test_client() as client:
        response = client.get('/api/agent/v1/models',
                              headers={'Authorization': 'Bearer coati_test_token'})
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['object'] == 'list'
    ids = [entry['id'] for entry in payload['data']]
    # route-model 置顶；deepseek 厂商内 default_model 前置：gamma → alpha → beta
    assert ids == ['route-model', 'gamma', 'alpha', 'beta']
    for entry in payload['data']:
        assert entry['object'] == 'model'
        assert entry['id']


def test_models_groups_credentials_by_provider(agent_app):
    """多厂商时：路由置顶，厂商按 code 字母序分组，组内保持账号优先级。"""
    app, db, models = agent_app
    make_pat(app, db, models)
    make_credential(app, db, models, models_list=['o1'], default_model='o-default', provider='openai')
    make_credential(app, db, models, models_list=['ds-a'], default_model='ds-default', provider='deepseek')
    make_route(app, db, models, 'coati-auto')
    with app.test_client() as client:
        response = client.get('/api/agent/v1/models',
                              headers={'Authorization': 'Bearer coati_test_token'})
    assert response.status_code == 200
    ids = [entry['id'] for entry in response.get_json()['data']]
    # deepseek < openai（字母序）；组内 default 前置
    assert ids == ['coati-auto', 'ds-default', 'ds-a', 'o-default', 'o1']


def test_models_exposes_models_usable_by_openai_chat_conversion(agent_app):
    app, db, models = agent_app
    make_pat(app, db, models)
    make_credential(
        app, db, models, models_list=['anthropic-only'], default_model='anthropic-only',
        upstream_protocol='anthropic-messages',
    )
    make_credential(
        app, db, models, models_list=['chat-only'], default_model='chat-only',
        upstream_protocol='openai-chat',
    )
    with app.test_client() as client:
        response = client.get(
            '/api/agent/v1/models',
            headers={'Authorization': 'Bearer coati_test_token'},
        )

    assert response.status_code == 200
    ids = [entry['id'] for entry in response.get_json()['data']]
    assert 'chat-only' in ids
    assert 'anthropic-only' in ids


def test_models_empty_when_no_config(agent_app):
    app, db, models = agent_app
    make_pat(app, db, models)
    with app.test_client() as client:
        response = client.get('/api/agent/v1/models',
                              headers={'Authorization': 'Bearer coati_test_token'})
    assert response.status_code == 200
    assert response.get_json() == {'object': 'list', 'data': []}


def test_responses_accepts_x_api_key_without_bearer(agent_app):
    app, db, models = agent_app
    make_pat(app, db, models)
    with app.test_client() as client:
        missing = client.post('/api/agent/v1/responses', json={'input': 'hi'})
        authed = client.post(
            '/api/agent/v1/responses',
            json={'input': 'hi'},
            headers={'X-Api-Key': 'coati_test_token'},
        )
        lookup = client.get(
            '/api/agent/v1/responses/resp_missing',
            headers={'X-Api-Key': 'coati_test_token'},
        )
    assert missing.status_code == 401
    assert authed.status_code != 401
    assert lookup.status_code == 404


def test_messages_accepts_x_api_key_without_bearer(agent_app):
    app, db, models = agent_app
    make_pat(app, db, models)
    with app.test_client() as client:
        missing = client.post('/api/agent/v1/messages', json={'messages': [], 'max_tokens': 16})
        authed = client.post(
            '/api/agent/v1/messages',
            json={'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 16},
            headers={'X-Api-Key': 'coati_test_token'},
        )
    assert missing.status_code == 401
    assert authed.status_code != 401


def test_models_skips_disabled_credential_and_route(agent_app):
    app, db, models = agent_app
    make_pat(app, db, models)
    make_credential(app, db, models, models_list=['hidden'], enabled=False)
    make_route(app, db, models, 'hidden-route', enabled=False)
    make_route(app, db, models, 'visible')
    with app.test_client() as client:
        response = client.get('/api/agent/v1/models',
                              headers={'Authorization': 'Bearer coati_test_token'})
    assert response.status_code == 200
    ids = [entry['id'] for entry in response.get_json()['data']]
    assert ids == ['visible']
