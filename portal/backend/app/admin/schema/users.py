# -*- coding: utf-8 -*-
"""用户模块 schema 层"""

EXPORT_FIELD_MAP = {
    'id': ('ID', lambda item: item.id),
    'username': ('用户名', lambda item: item.username),
    'role_names': ('角色名称', lambda item: ','.join([role.name for role in item.roles])),
    'role_codes': ('角色编码', lambda item: ','.join([role.code for role in item.roles])),
    'created_at': ('创建时间', lambda item: item.created_at.strftime('%Y-%m-%d %H:%M:%S') if item.created_at else ''),
}

IMPORT_HEADER_MAP = {
    '用户名': 'username',
    '密码': 'password',
    '角色编码': 'role_codes',
}


class UserSchemaError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def parse_role_codes(raw_value):
    if raw_value is None:
        return []
    text = str(raw_value).strip()
    if not text:
        return []
    normalized = text.replace('，', ',')
    return [item.strip() for item in normalized.split(',') if item.strip()]


def build_error_row(line, reason, row):
    return {
        'line': line,
        'reason': reason,
        'row': {k: ('' if v is None else str(v)) for k, v in (row or {}).items()}
    }
