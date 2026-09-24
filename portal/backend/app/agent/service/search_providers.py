# -*- coding: utf-8 -*-
"""独立网页搜索后端。

网关执行服务端搜索时有三条路，按顺序优先：

1. 上游账号原生执行——最好，结果带上游签发的真实引用，只需一次往返。
2. **本模块**：全局配置的独立搜索服务。快、便宜、结果形状统一。
3. 委托号池里能搜的模型账号——兜底。一次搜索要花一次完整的大模型推理，
   慢且贵，各家回包形状还不一致（实测五个账号出现过四种行为）。

第 2 档存在的意义是把「能不能搜」从「号池里恰好有没有合适账号」这个概率问题
里摘出来。没有配置时整条链退回第 3 档，行为与此前一致。
"""

import requests

from flask import current_app

from backend.app.agent.service.credential_crypto import decrypt_secret
from backend.app.agent.service.proxy import proxy_mapping


class SearchProviderError(RuntimeError):
    def __init__(self, message, status_code=502):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class SearchProvider:
    """搜索后端的统一接口。

    实现只需要把自家响应映射成网关内部的 sources 形状——
    {'url', 'title', 'snippet'?, 'publishedAt'?}，与 /api/agent/v1/web-search
    对外的契约一致，dsh 插件那边不用改。
    """

    code = ''
    label = ''

    def __init__(self, api_key, *, timeout=15, proxy_url=None):
        self.api_key = api_key
        self.timeout = timeout
        self.proxy_url = proxy_url

    def search(self, query, *, limit=5, allowed_domains=(), blocked_domains=()):
        raise NotImplementedError

    def fetch(self, url):
        """抓取单个 URL 的正文。

        由 Provider 去发这个请求，网关自身始终不对任意 URL 发起外部请求——
        那是一个 SSRF 面，不该由网关承担。
        """
        raise SearchProviderError(f'{self.label} 不支持网页抓取', 422)

    def _post(self, url, payload):
        kwargs = {'json': payload, 'timeout': self.timeout}
        proxies = proxy_mapping(self.proxy_url)
        if proxies:
            kwargs['proxies'] = proxies
        kwargs['headers'] = {
            'Authorization': f'Bearer {self.api_key}',
            'Content-Type': 'application/json',
        }
        try:
            response = requests.post(url, **kwargs)
        except requests.RequestException as exc:
            raise SearchProviderError(f'{self.label} 不可达：{exc}', 502) from exc
        if response.status_code in (401, 403):
            raise SearchProviderError(f'{self.label} 鉴权失败，请检查 API Key', 502)
        if response.status_code == 429:
            raise SearchProviderError(f'{self.label} 触发限流', 429)
        if response.status_code >= 400:
            detail = (response.text or '').strip()[:300]
            raise SearchProviderError(f'{self.label} 返回 HTTP {response.status_code}：{detail}', 502)
        try:
            return response.json()
        except ValueError as exc:
            raise SearchProviderError(f'{self.label} 返回非 JSON', 502) from exc


class TavilyProvider(SearchProvider):
    code = 'tavily'
    label = 'Tavily'
    endpoint = 'https://api.tavily.com/search'
    fetch_endpoint = 'https://api.tavily.com/extract'

    def search(self, query, *, limit=5, allowed_domains=(), blocked_domains=()):
        payload = {
            'query': query,
            'max_results': min(20, max(1, int(limit or 5))),
            'search_depth': 'basic',
            # 正文由 content 字段给，不需要整页原文，省额度也省上下文。
            'include_answer': False,
            'include_raw_content': False,
        }
        # 与上游原生工具不同，Tavily 白名单和黑名单都支持。
        if allowed_domains:
            payload['include_domains'] = list(allowed_domains)
        if blocked_domains:
            payload['exclude_domains'] = list(blocked_domains)
        body = self._post(self.endpoint, payload)
        results = body.get('results') if isinstance(body, dict) else None
        if not isinstance(results, list):
            raise SearchProviderError(f'{self.label} 返回结构无法解析', 502)
        sources = []
        seen = set()
        for item in results:
            if not isinstance(item, dict):
                continue
            url = str(item.get('url') or '').strip()
            if not url or url in seen:
                continue
            seen.add(url)
            source = {'url': url, 'title': str(item.get('title') or '').strip() or url}
            snippet = str(item.get('content') or '').strip()
            if snippet:
                source['snippet'] = snippet
            published = str(item.get('published_date') or '').strip()
            if published:
                source['publishedAt'] = published
            sources.append(source)
        return sources

    def fetch(self, url):
        body = self._post(self.fetch_endpoint, {
            'urls': url,
            'format': 'markdown',
            'extract_depth': 'basic',
        })
        results = body.get('results') if isinstance(body, dict) else None
        for item in results or []:
            if not isinstance(item, dict):
                continue
            text = str(item.get('raw_content') or '').strip()
            if not text:
                continue
            return {
                'url': str(item.get('url') or url).strip() or url,
                'title': str(item.get('title') or '').strip() or None,
                'text': text,
                'retrieved_at': None,
            }
        failed = (body or {}).get('failed_results') or []
        reason = ''
        if failed and isinstance(failed[0], dict):
            reason = str(failed[0].get('error') or '').strip()
        raise SearchProviderError(
            f'{self.label} 未能抓取该页面{"：" + reason if reason else ""}', 502,
        )


_PROVIDERS = {provider.code: provider for provider in (TavilyProvider,)}


def search_provider_catalog():
    return [{'code': cls.code, 'label': cls.label} for cls in _PROVIDERS.values()]


def build_search_provider(config):
    """按给定配置构造搜索后端；未配置则返回 None。

    API Key 走与上游凭据一致的密文存储（enc: 前缀）；明文只在直接写环境变量时出现。
    """
    config = config or {}

    def value(name):
        return str(config.get(name) or '').strip()

    code = value('AGENT_WEBSEARCH_PROVIDER').lower()
    if not code:
        return None
    factory = _PROVIDERS.get(code)
    if factory is None:
        current_app.logger.warning('未知的网页搜索后端：%s', code)
        return None
    raw_key = value('AGENT_WEBSEARCH_API_KEY')
    if not raw_key:
        return None
    if raw_key.startswith('enc:'):
        try:
            raw_key = decrypt_secret(raw_key)
        except Exception:
            current_app.logger.warning('网页搜索后端的 API Key 解密失败')
            return None
    try:
        timeout = min(60, max(3, int(value('AGENT_WEBSEARCH_TIMEOUT_SECONDS') or 15)))
    except (TypeError, ValueError):
        timeout = 15
    return factory(raw_key, timeout=timeout, proxy_url=value('AGENT_WEBSEARCH_PROXY_URL') or None)


def configured_search_provider():
    """当前生效的搜索后端：后台配置优先，环境变量兜底；都没有则返回 None。

    返回 None 时整条链退回「委托模型账号」，行为与引入本模块之前一致。
    """
    from backend import db
    from backend.app.admin.service.settings_service import resolve_web_search_settings

    merged = resolve_web_search_settings(
        current_app.config, db, current_app.extensions.get('app_models') or {},
    )
    return build_search_provider(merged)


__all__ = [
    'SearchProvider',
    'build_search_provider',
    'SearchProviderError',
    'TavilyProvider',
    'configured_search_provider',
    'search_provider_catalog',
]
