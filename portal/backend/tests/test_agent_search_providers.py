# -*- coding: utf-8 -*-
"""独立搜索后端：把「能不能搜」从「号池里恰好有没有合适账号」里摘出来。"""

import json

import pytest
from flask import Flask

from backend.app.agent.service.search_providers import (
    SearchProviderError,
    TavilyProvider,
    build_search_provider,
)


class _Resp:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


@pytest.fixture()
def flask_app():
    app = Flask(__name__)
    app.config.update(AGENT_CREDENTIAL_ENCRYPTION_KEY='test-only-encryption-key')
    with app.app_context():
        yield app


def test_tavily_maps_results_onto_the_gateway_source_shape(monkeypatch):
    """dsh 插件与 server tool 闭环都消费 {url,title,snippet}，形状必须一致。"""
    captured = {}

    def fake_post(url, **kwargs):
        captured['url'] = url
        captured['payload'] = kwargs['json']
        return _Resp({'results': [
            {'title': 'Pricing', 'url': 'https://claude.com/pricing',
             'content': '每月 20 美元起。', 'score': 0.9},
            {'title': 'dup', 'url': 'https://claude.com/pricing', 'content': 'x'},
            {'title': 'Docs', 'url': 'https://docs.claude.com', 'content': ''},
        ]})

    monkeypatch.setattr('backend.app.agent.service.search_providers.requests.post', fake_post)
    sources = TavilyProvider('tvly-x').search(
        'Claude Code pricing', limit=5,
        allowed_domains=['claude.com'], blocked_domains=['spam.io'],
    )
    assert captured['url'] == 'https://api.tavily.com/search'
    # 与上游原生工具不同，Tavily 白名单和黑名单都支持。
    assert captured['payload']['include_domains'] == ['claude.com']
    assert captured['payload']['exclude_domains'] == ['spam.io']
    assert sources == [
        {'url': 'https://claude.com/pricing', 'title': 'Pricing', 'snippet': '每月 20 美元起。'},
        {'url': 'https://docs.claude.com', 'title': 'Docs'},
    ]


def test_tavily_extract_feeds_web_fetch(monkeypatch):
    monkeypatch.setattr(
        'backend.app.agent.service.search_providers.requests.post',
        lambda url, **kw: _Resp({'results': [
            {'url': 'https://a.io/p', 'raw_content': '# 标题\n正文'},
        ]}),
    )
    fetched = TavilyProvider('tvly-x').fetch('https://a.io/p')
    assert fetched['url'] == 'https://a.io/p'
    assert '正文' in fetched['text']


def test_tavily_reports_a_failed_extract(monkeypatch):
    monkeypatch.setattr(
        'backend.app.agent.service.search_providers.requests.post',
        lambda url, **kw: _Resp({'results': [], 'failed_results': [
            {'url': 'https://a.io', 'error': 'timeout'},
        ]}),
    )
    with pytest.raises(SearchProviderError, match='timeout'):
        TavilyProvider('tvly-x').fetch('https://a.io')


def test_auth_failures_are_reported_clearly(monkeypatch):
    monkeypatch.setattr(
        'backend.app.agent.service.search_providers.requests.post',
        lambda url, **kw: _Resp({'detail': {'error': 'Unauthorized'}}, status_code=401),
    )
    with pytest.raises(SearchProviderError, match='API Key'):
        TavilyProvider('tvly-bad').search('x')


def test_no_config_means_no_provider(flask_app):
    """留空即回退到委托模型账号，行为与引入本模块之前一致。"""
    assert build_search_provider({}) is None
    assert build_search_provider({'AGENT_WEBSEARCH_PROVIDER': 'tavily'}) is None  # 缺 key
    assert build_search_provider({
        'AGENT_WEBSEARCH_PROVIDER': 'nope', 'AGENT_WEBSEARCH_API_KEY': 'k',
    }) is None


def test_encrypted_api_key_is_decrypted(flask_app):
    from backend.app.agent.service.credential_crypto import encrypt_secret
    provider = build_search_provider({
        'AGENT_WEBSEARCH_PROVIDER': 'tavily',
        'AGENT_WEBSEARCH_API_KEY': encrypt_secret('tvly-real'),
        'AGENT_WEBSEARCH_TIMEOUT_SECONDS': '999',
    })
    assert provider.api_key == 'tvly-real'
    assert provider.timeout == 60  # 上限收敛
