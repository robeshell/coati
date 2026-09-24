# -*- coding: utf-8 -*-
"""CSRF 防护验证"""

import pytest
from flask import Flask

from backend.common.csrf import csrf_protect


@pytest.fixture
def app():
    test_app = Flask(__name__)
    test_app.secret_key = 'test-secret'
    test_app.before_request(csrf_protect)

    @test_app.route('/api/ping', methods=['POST', 'GET'])
    def ping():
        return {'ok': True}

    @test_app.route('/api/agent/v1/messages', methods=['POST'])
    def agent_messages():
        return {'ok': True}

    return test_app


def test_unauth_mutation_passes(app):
    # 未登录请求不触发 CSRF（由 login_required 负责）
    client = app.test_client()
    resp = client.post('/api/ping', json={})
    assert resp.status_code == 200


def test_authed_mutation_without_token_blocked(app):
    client = app.test_client()
    with client.session_transaction() as sess:
        sess['logged_in'] = True
        sess['csrf_token'] = 'secret-token'
    resp = client.post('/api/ping', json={})
    assert resp.status_code == 403


def test_authed_mutation_with_wrong_token_blocked(app):
    client = app.test_client()
    with client.session_transaction() as sess:
        sess['logged_in'] = True
        sess['csrf_token'] = 'secret-token'
    resp = client.post('/api/ping', headers={'X-CSRF-Token': 'wrong'}, json={})
    assert resp.status_code == 403


def test_authed_mutation_with_correct_token_allowed(app):
    client = app.test_client()
    with client.session_transaction() as sess:
        sess['logged_in'] = True
        sess['csrf_token'] = 'secret-token'
    resp = client.post('/api/ping', headers={'X-CSRF-Token': 'secret-token'}, json={})
    assert resp.status_code == 200


def test_get_never_blocked(app):
    client = app.test_client()
    with client.session_transaction() as sess:
        sess['logged_in'] = True
        sess['csrf_token'] = 'secret-token'
    resp = client.get('/api/ping')
    assert resp.status_code == 200


@pytest.mark.parametrize('header', [
    {'Authorization': 'Bearer coati_test'},
    {'X-Api-Key': 'coati_test'},
    {'Api-Key': 'coati_test'},
])
def test_agent_api_key_mutation_skips_session_csrf(app, header):
    client = app.test_client()
    with client.session_transaction() as sess:
        sess['logged_in'] = True
        sess['csrf_token'] = 'secret-token'
    resp = client.post('/api/agent/v1/messages', headers=header, json={})
    assert resp.status_code == 200


def test_agent_mutation_without_api_key_still_requires_csrf(app):
    client = app.test_client()
    with client.session_transaction() as sess:
        sess['logged_in'] = True
        sess['csrf_token'] = 'secret-token'
    resp = client.post('/api/agent/v1/messages', json={})
    assert resp.status_code == 403
