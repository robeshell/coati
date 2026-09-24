# -*- coding: utf-8 -*-
"""树形列表页 schema 层"""

EXPORT_FIELD_MAP = {
    'id': ('ID', lambda item: item.id),
    'name': ('节点名称', lambda item: item.name),
    'node_code': ('节点编码', lambda item: item.node_code),
    'parent_id': ('父节点ID', lambda item: item.parent_id or ''),
    'node_type': ('节点类型', lambda item: item.node_type or 'category'),
    'icon': ('图标', lambda item: item.icon or ''),
    'status': ('状态', lambda item: item.status or 'active'),
    'owner': ('负责人', lambda item: item.owner or ''),
    'sort_order': ('排序', lambda item: item.sort_order if item.sort_order is not None else 0),
    'is_active': ('启用', lambda item: '启用' if item.is_active else '停用'),
    'description': ('描述', lambda item: item.description or ''),
    'created_at': ('创建时间', lambda item: item.created_at.strftime('%Y-%m-%d %H:%M:%S') if item.created_at else ''),
    'updated_at': ('更新时间', lambda item: item.updated_at.strftime('%Y-%m-%d %H:%M:%S') if item.updated_at else ''),
}

IMPORT_HEADER_MAP = {
    'ID': 'id',
    '节点名称': 'name',
    '节点编码': 'node_code',
    '父节点ID': 'parent_id',
    '节点类型': 'node_type',
    '图标': 'icon',
    '状态': 'status',
    '负责人': 'owner',
    '排序': 'sort_order',
    '启用': 'is_active',
    '描述': 'description',
}


def parse_bool(value, default=None):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raw = str(value).strip().lower()
    if raw in ('true', '1', 'yes', '启用'):
        return True
    if raw in ('false', '0', 'no', '停用'):
        return False
    return default


def parse_int(value, default=0):
    if value is None:
        return default
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


def build_error_row(line, reason, row):
    return {'line': line, 'reason': reason, 'row': row}
