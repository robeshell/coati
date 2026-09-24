# -*- coding: utf-8 -*-
"""Agent auth / usage unit tests (no DB)."""

from types import SimpleNamespace

from flask import Flask, g

from backend.app.agent.service.bearer import agent_scope_required, hash_token


def test_hash_token_stable():
    assert hash_token('coati_abc') == hash_token('coati_abc')
    assert hash_token('coati_abc') != hash_token('coati_abd')


def test_hash_token_sha256_length():
    assert len(hash_token('x')) == 64


def test_scope_decorator_allows_only_declared_scope():
    app = Flask(__name__)

    @agent_scope_required('chat')
    def endpoint():
        return 'ok'

    with app.test_request_context(headers={'Authorization': 'Bearer coati_test'}):
        g.agent_user = SimpleNamespace(id=1)
        g.agent_pat = SimpleNamespace(scopes=lambda: ['chat'])
        assert endpoint() == 'ok'

    with app.test_request_context(headers={'Authorization': 'Bearer coati_test'}):
        g.agent_user = SimpleNamespace(id=1)
        g.agent_pat = SimpleNamespace(scopes=lambda: ['profile'])
        response, status = endpoint()
        assert status == 403
        assert response.get_json()['required_scope'] == 'chat'
