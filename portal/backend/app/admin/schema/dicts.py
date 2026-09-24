# -*- coding: utf-8 -*-
"""数据字典 schema 层"""

CSV_HEADER_TO_FIELD = {
    '字典标签': 'label',
    '字典值': 'value',
    '标签颜色': 'color',
    '排序': 'sort_order',
    '是否默认': 'is_default',
    '是否启用': 'is_active',
    '备注': 'description',
}

LEGACY_CSV_HEADER_TO_FIELD = {
    'label': 'label',
    'value': 'value',
    'color': 'color',
    'sort_order': 'sort_order',
    'is_default': 'is_default',
    'is_active': 'is_active',
    'description': 'description',
}


class DictsSchemaError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def parse_bool(value):
    if value is None or value == '':
        return None
    if isinstance(value, bool):
        return value

    raw = str(value).strip().lower()
    if raw in {'1', 'true', 'yes', 'on', '是', '启用'}:
        return True
    if raw in {'0', 'false', 'no', 'off', '否', '停用'}:
        return False
    return None


def parse_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_string(value):
    return str(value or '').strip()
