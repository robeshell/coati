# -*- coding: utf-8 -*-
"""角色模块 schema 层"""

EXPORT_FIELD_MAP = {
    'id': ('ID', lambda item: item.id),
    'name': ('角色名称', lambda item: item.name),
    'code': ('角色编码', lambda item: item.code),
    'description': ('描述', lambda item: item.description or ''),
    'menu_codes': ('菜单编码', lambda item: ','.join([menu.code for menu in item.menus])),
    'menu_names': ('菜单名称', lambda item: ','.join([menu.name for menu in item.menus])),
    'created_at': ('创建时间', lambda item: item.created_at.strftime('%Y-%m-%d %H:%M:%S') if item.created_at else ''),
}

IMPORT_HEADER_MAP = {
    '角色名称': 'name',
    '角色编码': 'code',
    '描述': 'description',
    '菜单编码': 'menu_codes',
}


def parse_codes(raw_value):
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
