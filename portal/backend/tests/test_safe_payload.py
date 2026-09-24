# -*- coding: utf-8 -*-
"""审计日志敏感字段脱敏验证"""

from backend.common.request_meta import safe_payload


def test_masks_password_fields():
    text = safe_payload({'username': 'admin', 'password': 'secret123'})
    assert 'secret123' not in text
    assert '***' in text
    assert 'admin' in text


def test_masks_nested_sensitive():
    text = safe_payload({'user': {'token': 'abc', 'name': 'x'}, 'old_password': 'p'})
    assert 'abc' not in text
    assert 'token": "***"' in text
    assert 'old_password": "***"' in text
    assert 'x' in text


def test_keeps_normal_fields():
    text = safe_payload({'title': 'hello', 'status': 'active'})
    assert 'hello' in text
    assert 'active' in text


def test_none_payload():
    assert safe_payload(None) is None


def test_list_masking():
    text = safe_payload([{'api_key': 'k', 'name': 'n'}])
    assert 'api_key": "***"' in text
    assert 'n' in text
