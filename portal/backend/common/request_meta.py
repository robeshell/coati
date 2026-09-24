# -*- coding: utf-8 -*-
"""请求元信息工具"""

import json
from flask import request


def get_client_ip():
    """获取客户端 IP。

    以 request.remote_addr 为准（直连部署时即对端地址，不可伪造）；
    部署在可信反向代理后时由 ProxyFix 修正为真实客户端 IP。
    不直接信任可伪造的 X-Forwarded-For / X-Real-IP 头。
    """
    return request.remote_addr or ''


def get_user_agent():
    """获取客户端 UA"""
    return request.headers.get('User-Agent', '')[:500]


SENSITIVE_KEYS = {
    'password', 'old_password', 'new_password', 'confirm_password',
    'secret', 'token', 'access_token', 'api_key', 'authorization',
}


def _mask_sensitive(data):
    """递归脱敏请求体中的敏感字段，避免密码/令牌落入审计日志"""
    if isinstance(data, dict):
        return {
            key: ('***' if str(key).lower() in SENSITIVE_KEYS else _mask_sensitive(value))
            for key, value in data.items()
        }
    if isinstance(data, list):
        return [_mask_sensitive(item) for item in data]
    return data


def safe_payload(payload):
    """序列化请求体并限制长度（敏感字段先脱敏）"""
    if payload is None:
        return None
    try:
        text = json.dumps(_mask_sensitive(payload), ensure_ascii=False)
    except Exception:
        text = str(payload)
    if len(text) > 2000:
        return text[:2000] + '...(truncated)'
    return text
