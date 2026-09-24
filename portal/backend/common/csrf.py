# -*- coding: utf-8 -*-
"""CSRF 防护

基于 Session Cookie 的认证依赖浏览器自动携带 Cookie，需对状态变更请求校验
双提交 token：前端在登录/获取当前用户时拿到 csrf_token，随请求头
X-CSRF-Token 提交，服务端与会话中的 token 比对。
"""

import secrets

from flask import jsonify, request, session


def ensure_csrf_token():
    """为当前会话生成/返回 CSRF token"""
    if not session.get('csrf_token'):
        session['csrf_token'] = secrets.token_hex(16)
    return session['csrf_token']


def csrf_protect():
    """before_request：对已登录会话的状态变更请求做 CSRF 校验

    - 仅拦截 /api/ 下的 POST/PUT/PATCH/DELETE
    - 登录接口本身豁免（此时尚未建立会话 token）
    - 未登录请求跳过（由 login_required 处理）
    """
    if request.method not in ('POST', 'PUT', 'PATCH', 'DELETE'):
        return None
    if not request.path.startswith('/api/'):
        return None
    if request.path == '/api/admin/login':
        return None
    # Agent CLI 接口使用自己的 API Key 鉴权，不依赖浏览器 Session CSRF。
    # OpenAI 客户端通常发 Authorization: Bearer，Anthropic 客户端通常发
    # x-api-key；两者都必须在带有管理端 Cookie 时正常工作。
    agent_api_paths = (
        '/api/agent/v1/',
        '/api/agent/anthropic/v1/',
        '/api/agent/me/',
    )
    if request.path.startswith(agent_api_paths):
        authorization = request.headers.get('Authorization', '')
        if authorization.lower().startswith('bearer ') or any(
            (request.headers.get(name) or '').strip()
            for name in ('X-Api-Key', 'Api-Key')
        ):
            return None
    if not session.get('logged_in'):
        return None

    token = request.headers.get('X-CSRF-Token', '')
    expected = session.get('csrf_token') or ''
    if not token or not expected or not secrets.compare_digest(token, expected):
        return jsonify({'error': 'CSRF 校验失败，请刷新页面后重试'}), 403
    return None
