# -*- coding: utf-8 -*-
"""定时任务 schema 层"""

from __future__ import annotations

import ipaddress
import json
import socket
from datetime import datetime, timedelta
from urllib.parse import urlparse

EXPORT_FIELD_MAP = {
    'id': ('ID', lambda item: item.id),
    'name': ('任务名称', lambda item: item.name),
    'task_code': ('任务编码', lambda item: item.task_code),
    'cron_expression': ('Cron 表达式', lambda item: item.cron_expression),
    'request_method': ('请求方法', lambda item: item.request_method),
    'request_url': ('请求地址', lambda item: item.request_url),
    'timeout_seconds': ('超时时间(秒)', lambda item: item.timeout_seconds or 10),
    'is_active': ('状态', lambda item: '启用' if item.is_active else '停用'),
    'last_status': ('最近状态', lambda item: item.last_status or 'idle'),
    'run_count': ('累计执行次数', lambda item: item.run_count or 0),
    'last_run_at': ('最近执行时间', lambda item: item.last_run_at.strftime('%Y-%m-%d %H:%M:%S') if item.last_run_at else ''),
    'next_run_at': ('下次执行时间', lambda item: item.next_run_at.strftime('%Y-%m-%d %H:%M:%S') if item.next_run_at else ''),
    'updated_at': ('更新时间', lambda item: item.updated_at.strftime('%Y-%m-%d %H:%M:%S') if item.updated_at else ''),
}


class ScheduledTaskSchemaError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def validate_request_url(raw):
    """校验定时任务目标 URL：http/https 协议 + 目标 IP 不在内网/保留网段。

    返回规范化 URL 字符串；不合法时抛 ScheduledTaskSchemaError。
    """
    text = str(raw or '').strip()
    if not text:
        raise ScheduledTaskSchemaError('请求地址不能为空')

    parsed = urlparse(text)
    if parsed.scheme not in ('http', 'https'):
        raise ScheduledTaskSchemaError('请求地址仅支持 http/https 协议')
    if not parsed.hostname:
        raise ScheduledTaskSchemaError('请求地址缺少主机名')
    if parsed.username or parsed.password:
        raise ScheduledTaskSchemaError('请求地址不能包含用户名或密码')

    hostname = parsed.hostname
    try:
        port = parsed.port
    except ValueError:
        raise ScheduledTaskSchemaError('请求地址端口不合法')
    if port is not None and not (0 < port <= 65535):
        raise ScheduledTaskSchemaError('请求地址端口不合法')

    # 直连 IP：直接判定
    try:
        ip = ipaddress.ip_address(hostname)
        if not ip.is_global:
            raise ScheduledTaskSchemaError('不允许访问内网地址')
        return text
    except ValueError:
        pass

    # 主机名：解析并校验全部结果（存在一个内网 IP 即拒绝），防止 DNS 重绑定
    try:
        addrs = socket.getaddrinfo(hostname, None)
    except OSError:
        raise ScheduledTaskSchemaError('请求地址无法解析')
    for addr in addrs:
        ip_text = addr[4][0]
        try:
            ip = ipaddress.ip_address(ip_text)
        except ValueError:
            continue
        if not ip.is_global:
            raise ScheduledTaskSchemaError('不允许访问内网地址')

    return text


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


def parse_json_object(value, default=None):
    if value is None:
        return default if default is not None else {}
    if isinstance(value, dict):
        return value
    text = str(value).strip()
    if not text:
        return default if default is not None else {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ScheduledTaskSchemaError('JSON 格式不合法') from exc
    if not isinstance(parsed, dict):
        raise ScheduledTaskSchemaError('JSON 内容必须是对象')
    return parsed


def parse_cron_expression(expression):
    text = str(expression or '').strip()
    if not text:
        raise ScheduledTaskSchemaError('Cron 表达式不能为空')

    fields = text.split()
    if len(fields) != 5:
        raise ScheduledTaskSchemaError('Cron 表达式格式错误，应为 5 段: 分 时 日 月 周')

    minute_set = _parse_cron_field(fields[0], 0, 59)
    hour_set = _parse_cron_field(fields[1], 0, 23)
    day_set = _parse_cron_field(fields[2], 1, 31)
    month_set = _parse_cron_field(fields[3], 1, 12)
    weekday_set = _parse_cron_field(fields[4], 0, 6, alias={7: 0})
    return {
        'text': text,
        'minutes': minute_set,
        'hours': hour_set,
        'days': day_set,
        'months': month_set,
        'weekdays': weekday_set,
    }


def compute_next_run_at(expression, base_time=None, lookahead_minutes=366 * 24 * 60):
    cron = parse_cron_expression(expression)
    current = (base_time or datetime.utcnow()).replace(second=0, microsecond=0) + timedelta(minutes=1)

    for _ in range(lookahead_minutes):
        cron_weekday = (current.weekday() + 1) % 7  # Monday=0 -> 1, Sunday=6 -> 0
        if (
            current.minute in cron['minutes']
            and current.hour in cron['hours']
            and current.day in cron['days']
            and current.month in cron['months']
            and cron_weekday in cron['weekdays']
        ):
            return current
        current += timedelta(minutes=1)

    raise ScheduledTaskSchemaError('Cron 表达式在一年内没有可触发时间，请检查配置')


def _parse_cron_field(field, min_value, max_value, alias=None):
    alias = alias or {}
    result = set()

    for part in str(field).split(','):
        token = part.strip()
        if not token:
            raise ScheduledTaskSchemaError('Cron 表达式存在空字段')

        if token == '*':
            result.update(range(min_value, max_value + 1))
            continue

        step = 1
        base = token
        if '/' in token:
            base, step_raw = token.split('/', 1)
            if not step_raw.isdigit() or int(step_raw) <= 0:
                raise ScheduledTaskSchemaError(f'Cron 步长不合法: {token}')
            step = int(step_raw)

        if base == '*':
            start, end = min_value, max_value
        elif '-' in base:
            left, right = base.split('-', 1)
            start = _parse_num(left, min_value, max_value, alias)
            end = _parse_num(right, min_value, max_value, alias)
            if start > end:
                raise ScheduledTaskSchemaError(f'Cron 区间不合法: {token}')
        else:
            value = _parse_num(base, min_value, max_value, alias)
            start, end = value, value

        result.update(range(start, end + 1, step))

    if not result:
        raise ScheduledTaskSchemaError('Cron 字段解析后为空')
    return result


def _parse_num(raw, min_value, max_value, alias):
    text = str(raw).strip()
    if not text or (text[0] == '-' and not text[1:].isdigit()) or (text[0] != '-' and not text.isdigit()):
        raise ScheduledTaskSchemaError(f'Cron 数值不合法: {raw}')

    value = int(text)
    value = alias.get(value, value)
    if value < min_value or value > max_value:
        raise ScheduledTaskSchemaError(f'Cron 数值超出范围: {value}')
    return value
