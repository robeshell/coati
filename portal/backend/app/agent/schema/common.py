"""Agent 域通用校验工具。"""

from urllib.parse import urlsplit


class AgentValidationError(ValueError):
    pass


def text(value, field, *, required=False, max_length=None, default=None):
    if value is None:
        if required:
            raise AgentValidationError(f'{field} 必填')
        return default
    value = str(value).strip()
    if required and not value:
        raise AgentValidationError(f'{field} 必填')
    if max_length and len(value) > max_length:
        raise AgentValidationError(f'{field} 不能超过 {max_length} 个字符')
    return value or default


def integer(value, field, *, minimum=None, maximum=None, default=None):
    if value in (None, ''):
        return default
    try:
        value = int(value)
    except (TypeError, ValueError) as exc:
        raise AgentValidationError(f'{field} 必须是整数') from exc
    if minimum is not None and value < minimum:
        raise AgentValidationError(f'{field} 不能小于 {minimum}')
    if maximum is not None and value > maximum:
        raise AgentValidationError(f'{field} 不能大于 {maximum}')
    return value


def boolean(value, default=True):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ('true', '1', 'yes', 'on'):
            return True
        if lowered in ('false', '0', 'no', 'off'):
            return False
    return bool(value)


def http_url(value, field, *, required=False):
    value = text(value, field, required=required, max_length=512)
    if not value:
        return None
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise AgentValidationError(f'{field} 必须是有效的 HTTP(S) 地址')
    return value.rstrip('/')
