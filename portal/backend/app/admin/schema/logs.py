# -*- coding: utf-8 -*-
"""日志模块 schema 层"""

from datetime import datetime

LOGIN_EXPORT_FIELD_MAP = {
    'id': ('ID', lambda item: item.id),
    'username': ('用户名', lambda item: item.username),
    'status': ('状态', lambda item: item.status),
    'ip': ('IP 地址', lambda item: item.ip or ''),
    'user_agent': ('User-Agent', lambda item: item.user_agent or ''),
    'message': ('说明', lambda item: item.message or ''),
    'created_at': ('时间', lambda item: item.created_at.strftime('%Y-%m-%d %H:%M:%S') if item.created_at else ''),
}

OPERATION_EXPORT_FIELD_MAP = {
    'id': ('ID', lambda item: item.id),
    'username': ('用户名', lambda item: item.username),
    'module': ('模块', lambda item: item.module),
    'action': ('操作', lambda item: item.action),
    'method': ('方法', lambda item: item.method),
    'path': ('路径', lambda item: item.path),
    'target_id': ('目标ID', lambda item: item.target_id or ''),
    'status_code': ('状态码', lambda item: item.status_code if item.status_code is not None else ''),
    'ip': ('IP 地址', lambda item: item.ip or ''),
    'user_agent': ('User-Agent', lambda item: item.user_agent or ''),
    'payload': ('请求体', lambda item: item.payload or ''),
    'created_at': ('时间', lambda item: item.created_at.strftime('%Y-%m-%d %H:%M:%S') if item.created_at else ''),
}

LOGIN_IMPORT_HEADER_MAP = {
    '用户名': 'username',
    '状态': 'status',
    'IP 地址': 'ip',
    'User-Agent': 'user_agent',
    '说明': 'message',
    '时间': 'created_at',
}

OPERATION_IMPORT_HEADER_MAP = {
    '用户名': 'username',
    '模块': 'module',
    '操作': 'action',
    '方法': 'method',
    '路径': 'path',
    '目标ID': 'target_id',
    '状态码': 'status_code',
    'IP 地址': 'ip',
    'User-Agent': 'user_agent',
    '请求体': 'payload',
    '时间': 'created_at',
}


class LogsSchemaError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def parse_datetime(raw_value, default=None):
    if raw_value is None:
        return default
    text = str(raw_value).strip()
    if not text:
        return default
    normalized = text.replace('T', ' ').replace('Z', '')
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def parse_int(raw_value, default=0):
    try:
        return int(raw_value)
    except (TypeError, ValueError):
        return default


def build_error_row(line, reason, row):
    return {
        'line': line,
        'reason': reason,
        'row': {k: ('' if v is None else str(v)) for k, v in (row or {}).items()},
    }


def resolve_module_and_action(path, method):
    segments = [seg for seg in path.strip('/').split('/') if seg]
    module = 'system'
    action = {
        'POST': 'create',
        'PUT': 'update',
        'DELETE': 'delete',
    }.get(method, method.lower())

    if len(segments) >= 3 and segments[0] == 'api' and segments[1] == 'admin':
        module = segments[2]
        if 'import' in segments:
            action = 'import'
        elif 'export' in segments:
            action = 'export'
        elif 'logout' in segments:
            module = 'auth'
            action = 'logout'
        elif 'change-password' in segments:
            module = 'auth'
            action = 'change_password'

    return module, action
