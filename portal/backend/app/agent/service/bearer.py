# -*- coding: utf-8 -*-
"""Agent Bearer 鉴权（与浏览器 Session 分离）"""

from functools import wraps
from hashlib import sha256

from flask import g, jsonify, request


def hash_token(raw_token: str) -> str:
    return sha256(raw_token.encode('utf-8')).hexdigest()


def extract_bearer_token():
    auth = request.headers.get('Authorization') or ''
    if auth.lower().startswith('bearer '):
        return auth[7:].strip()
    return ''


def extract_api_key():
    """外部客户端：Authorization Bearer，或 Claude Code 的 x-api-key。"""
    token = extract_bearer_token()
    if token:
        return token
    for name in ('X-Api-Key', 'Api-Key'):
        value = (request.headers.get(name) or '').strip()
        if value:
            return value
    return ''


def agent_bearer_required(f):
    """要求有效 PAT（或 Device Code 兑换出的 access token，同存 agent_pat）。"""

    @wraps(f)
    def decorated(*args, **kwargs):
        token = extract_api_key()
        if not token:
            return jsonify({'error': '缺少 API Key'}), 401
        user = getattr(g, 'agent_user', None)
        if user is None:
            return jsonify({'error': '未授权'}), 401
        return f(*args, **kwargs)

    return decorated


def agent_scope_required(scope):
    """要求 Bearer 令牌包含指定权限范围。"""
    def decorator(f):
        @wraps(f)
        @agent_bearer_required
        def decorated(*args, **kwargs):
            pat = getattr(g, 'agent_pat', None)
            scopes = pat.scopes() if pat and hasattr(pat, 'scopes') else []
            if scope not in scopes:
                return jsonify({'error': '令牌权限不足', 'required_scope': scope}), 403
            return f(*args, **kwargs)
        return decorated
    return decorator
