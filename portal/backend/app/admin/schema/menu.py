# -*- coding: utf-8 -*-
"""菜单模块 schema/DTO 层：参数映射、校验、类型转换"""

EXPORT_FIELD_MAP = {
    'id': ('ID', lambda item: item.id),
    'name': ('菜单名称', lambda item: item.name),
    'code': ('菜单编码', lambda item: item.code),
    'menu_type': ('类型', lambda item: item.menu_type),
    'path': ('路径', lambda item: item.path or ''),
    'component': ('组件', lambda item: item.component or ''),
    'icon': ('图标', lambda item: item.icon or ''),
    'parent_code': ('父级编码', lambda item: item.parent.code if item.parent else ''),
    'sort_order': ('排序', lambda item: item.sort_order if item.sort_order is not None else 0),
    'is_visible': ('是否显示', lambda item: '是' if item.is_visible else '否'),
    'is_active': ('是否启用', lambda item: '是' if item.is_active else '否'),
    'description': ('描述', lambda item: item.description or ''),
}

IMPORT_HEADER_MAP = {
    '菜单名称': 'name',
    '菜单编码': 'code',
    '类型': 'menu_type',
    '路径': 'path',
    '组件': 'component',
    '图标': 'icon',
    '父级编码': 'parent_code',
    '排序': 'sort_order',
    '是否显示': 'is_visible',
    '是否启用': 'is_active',
    '描述': 'description',
}

MENU_TYPES = {'directory', 'menu', 'button'}
MENU_MUTABLE_FIELDS = [
    'name',
    'code',
    'icon',
    'path',
    'component',
    'parent_id',
    'sort_order',
    'is_visible',
    'is_active',
    'menu_type',
    'description',
]


class MenuSchemaError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def parse_bool(value, default=None):
    if value is None or value == '':
        return default
    if isinstance(value, bool):
        return value
    raw = str(value).strip().lower()
    if raw in {'1', 'true', 'yes', 'on', '是', '启用'}:
        return True
    if raw in {'0', 'false', 'no', 'off', '否', '停用'}:
        return False
    return default


def parse_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def build_error_row(line, reason, row):
    return {
        'line': line,
        'reason': reason,
        'row': {k: ('' if v is None else str(v)) for k, v in (row or {}).items()}
    }


def validate_create_payload(data):
    payload = data or {}
    name = str(payload.get('name') or '').strip()
    code = str(payload.get('code') or '').strip()
    if not name or not code:
        raise MenuSchemaError('菜单名称和编码不能为空')


def validate_update_payload(data):
    payload = data or {}
    if 'name' in payload and not str(payload.get('name') or '').strip():
        raise MenuSchemaError('菜单名称不能为空')
    if 'code' in payload and not str(payload.get('code') or '').strip():
        raise MenuSchemaError('菜单编码不能为空')


def map_import_headers(fieldnames):
    row_header_map = {}
    for header in fieldnames:
        key = (header or '').strip()
        if key in IMPORT_HEADER_MAP:
            row_header_map[header] = IMPORT_HEADER_MAP[key]
    return row_header_map


def parse_import_row(mapped):
    name = str(mapped.get('name') or '').strip()
    code = str(mapped.get('code') or '').strip()
    menu_type = str(mapped.get('menu_type') or 'menu').strip() or 'menu'
    parent_code = str(mapped.get('parent_code') or '').strip()

    return {
        'name': name,
        'code': code,
        'menu_type': menu_type,
        'path': str(mapped.get('path') or '').strip() or None,
        'component': str(mapped.get('component') or '').strip() or None,
        'icon': str(mapped.get('icon') or '').strip() or None,
        'parent_code': parent_code,
        'sort_order': parse_int(mapped.get('sort_order'), default=0),
        'is_visible': parse_bool(mapped.get('is_visible'), default=True),
        'is_active': parse_bool(mapped.get('is_active'), default=True),
        'description': str(mapped.get('description') or '').strip() or None,
    }
