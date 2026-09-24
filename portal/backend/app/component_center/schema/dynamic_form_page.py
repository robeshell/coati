# -*- coding: utf-8 -*-
"""动态表单页 schema 层"""

EXPORT_FIELD_MAP = {
    'id': ('ID', lambda item: item.id),
    'title': ('标题', lambda item: item.title),
    'record_code': ('记录编码', lambda item: item.record_code),
    'category': ('分类', lambda item: item.category or 'general'),
    'status': ('发布状态', lambda item: item.status or 'draft'),
    'owner': ('负责人', lambda item: item.owner or ''),
    'priority': ('优先级', lambda item: item.priority if item.priority is not None else 0),
    'is_active': ('启用', lambda item: '启用' if item.is_active else '停用'),
    'fields_count': ('字段数量', lambda item: item.fields.count()),
    'description': ('描述', lambda item: item.description or ''),
    'created_at': ('创建时间', lambda item: item.created_at.strftime('%Y-%m-%d %H:%M:%S') if item.created_at else ''),
    'updated_at': ('更新时间', lambda item: item.updated_at.strftime('%Y-%m-%d %H:%M:%S') if item.updated_at else ''),
}

IMPORT_HEADER_MAP = {
    'ID': 'id',
    '标题': 'title',
    '记录编码': 'record_code',
    '分类': 'category',
    '发布状态': 'status',
    '负责人': 'owner',
    '优先级': 'priority',
    '启用': 'is_active',
    '描述': 'description',
}

VALID_FIELD_TYPES = {'text', 'number', 'boolean', 'date'}
STATUS_VALUES = {'draft', 'published', 'archived'}
CATEGORY_VALUES = {'general', 'config', 'profile', 'spec'}


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
