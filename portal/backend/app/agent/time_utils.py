# -*- coding: utf-8 -*-
"""Agent 域时间约定：数据库保存 naive UTC，接口返回带时区的 RFC 3339。"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import current_app, has_app_context


DEFAULT_AGENT_TIMEZONE = 'Asia/Shanghai'


def agent_timezone_name():
    if has_app_context():
        return str(current_app.config.get('AGENT_TIMEZONE') or DEFAULT_AGENT_TIMEZONE)
    return DEFAULT_AGENT_TIMEZONE


def agent_timezone(name=None):
    value = name or agent_timezone_name()
    try:
        return ZoneInfo(value)
    except ZoneInfoNotFoundError:
        return ZoneInfo(DEFAULT_AGENT_TIMEZONE)


def _aware_utc(value):
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def utc_iso(value):
    """将数据库中的 naive UTC 序列化为显式 UTC 时间。"""
    if value is None:
        return None
    return _aware_utc(value).isoformat().replace('+00:00', 'Z')


def local_day_start_utc(now=None, timezone_name=None):
    """返回业务时区当天零点对应的 naive UTC，便于查询 UTC 字段。"""
    instant = _aware_utc(now or datetime.now(timezone.utc))
    local_now = instant.astimezone(agent_timezone(timezone_name))
    local_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    return local_start.astimezone(timezone.utc).replace(tzinfo=None)


def local_bucket_iso(value, timezone_name=None):
    """将已经按业务时区分桶的时间补上明确偏移量。"""
    if value is None:
        return None
    if not isinstance(value, datetime):
        try:
            value = datetime.fromisoformat(str(value))
        except ValueError:
            return str(value)
    zone = agent_timezone(timezone_name)
    localized = value.replace(tzinfo=zone) if value.tzinfo is None else value.astimezone(zone)
    return localized.isoformat()


def sqlite_timezone_modifier(timezone_name=None):
    """SQLite 测试环境使用固定偏移模拟业务时区分桶。"""
    zone = agent_timezone(timezone_name)
    offset = datetime.now(timezone.utc).astimezone(zone).utcoffset()
    hours = (offset.total_seconds() / 3600) if offset else 0
    sign = '+' if hours >= 0 else '-'
    value = abs(hours)
    rendered = str(int(value)) if value.is_integer() else str(value)
    return f'{sign}{rendered} hours'
