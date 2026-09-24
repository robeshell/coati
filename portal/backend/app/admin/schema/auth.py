# -*- coding: utf-8 -*-
"""认证模块 schema 层"""


def validate_change_password_payload(data):
    old_password = (data or {}).get('old_password')
    new_password = (data or {}).get('new_password')

    if not old_password or not new_password:
        return '请填写完整信息'
    if len(str(new_password)) < 6:
        return '新密码长度至少6位'
    return None
