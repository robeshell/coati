# -*- coding: utf-8 -*-
"""详情标签页 schema / 校验工具"""

STATUS_VALUES = {'active', 'leave', 'probation'}


def parse_bool(value, default=True):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).lower() in ('true', '1', 'yes', '启用')


def parse_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
