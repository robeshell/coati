# -*- coding: utf-8 -*-
"""高级表格页 schema 层"""


STATUS_VALUES = {'draft', 'published', 'archived'}
CATEGORY_VALUES = {'general', 'order', 'user', 'finance', 'risk'}


def parse_bool(value, default=None):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raw = str(value).strip().lower()
    if raw in ('true', '1', 'yes', 'on', '启用', '是'):
        return True
    if raw in ('false', '0', 'no', 'off', '停用', '否'):
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
