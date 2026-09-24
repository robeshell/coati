# -*- coding: utf-8 -*-
"""带统计的列表页 schema 层"""


EXPORT_FIELD_MAP = {
    'id': ('ID', lambda item: item.id),
    'name': ('名称', lambda item: item.name),
    'item_code': ('编码', lambda item: item.item_code),
    'category': ('分类', lambda item: item.category or ''),
    'status': ('发布状态', lambda item: item.status or 'draft'),
    'amount': ('金额', lambda item: float(item.amount) if item.amount is not None else 0.0),
    'quantity': ('数量', lambda item: item.quantity if item.quantity is not None else 0),
    'owner': ('负责人', lambda item: item.owner or ''),
    'priority': ('优先级', lambda item: item.priority if item.priority is not None else 0),
    'is_active': ('状态', lambda item: '启用' if item.is_active else '停用'),
    'description': ('描述', lambda item: item.description or ''),
    'created_at': ('创建时间', lambda item: item.created_at.strftime('%Y-%m-%d %H:%M:%S') if item.created_at else ''),
    'updated_at': ('更新时间', lambda item: item.updated_at.strftime('%Y-%m-%d %H:%M:%S') if item.updated_at else ''),
}

IMPORT_HEADER_MAP = {
    'ID': 'id',
    '名称': 'name',
    '编码': 'item_code',
    '分类': 'category',
    '发布状态': 'status',
    '金额': 'amount',
    '数量': 'quantity',
    '负责人': 'owner',
    '优先级': 'priority',
    '状态': 'is_active',
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


def parse_float(value, default=0.0):
    if value is None:
        return default
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def build_error_row(line, reason, row):
    return {'line': line, 'reason': reason, 'row': row}
