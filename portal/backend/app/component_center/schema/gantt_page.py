# -*- coding: utf-8 -*-
"""甘特图页 schema / 校验工具"""

TASK_TYPE_VALUES = {'phase', 'task', 'milestone'}
PRIORITY_VALUES = {'low', 'medium', 'high', 'critical'}
STATUS_VALUES = {'not_started', 'in_progress', 'completed', 'delayed'}


def parse_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
