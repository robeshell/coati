"""上游凭证输入校验。"""

import json
import re
from urllib.parse import urlsplit

from .common import AgentValidationError, boolean, http_url, integer, text
from backend.app.agent.constants import UPSTREAM_OPENAI_CHAT, UPSTREAM_PROTOCOLS

_HEADER_NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')
_BLOCKED_HEADERS = {
    'authorization', 'x-api-key', 'host', 'content-length',
    'connection', 'transfer-encoding', 'cookie',
}


def _string_list(value, label, *, maximum=50, max_length=128):
    if value in (None, ''):
        return []
    if not isinstance(value, list):
        raise AgentValidationError(f'{label}必须是数组')
    result = []
    for item in value:
        normalized = text(item, label, max_length=max_length)
        if normalized and normalized not in result:
            result.append(normalized)
    if len(result) > maximum:
        raise AgentValidationError(f'{label}最多 {maximum} 项')
    return result


def normalize_credential_payload(data, *, partial=False):
    data = data or {}
    out = {}

    def assign(name, value):
        if not partial or name in data:
            out[name] = value

    assign('name', text(data.get('name'), '名称', required=not partial, max_length=100))
    # provider 仅保留为后端根据 Base URL 推断的内部画像；客户端传值不入库，
    # 防止伪造厂商标签重新影响请求地址或缓存语义。
    if not partial or 'upstream_protocol' in data:
        protocol = text(
            data.get('upstream_protocol'), '上游接口类型', max_length=32,
            default=UPSTREAM_OPENAI_CHAT,
        )
        if protocol not in UPSTREAM_PROTOCOLS:
            raise AgentValidationError('不支持的上游接口类型')
        out['upstream_protocol'] = protocol
    assign('base_url', http_url(data.get('base_url'), 'Base URL', required=not partial))
    if not partial or 'proxy_url' in data:
        out['proxy_url'] = normalize_proxy_url(data.get('proxy_url'))
    if not partial or 'api_key' in data:
        key = text(data.get('api_key'), 'API Key', required=not partial)
        if key:
            out['api_key'] = key
    supported_models = None
    if not partial or 'supported_models' in data:
        supported_models = _string_list(data.get('supported_models'), '支持模型')
        out['models_json'] = json.dumps(supported_models, ensure_ascii=False)
    assign('default_model', text(data.get('default_model'), '默认模型', max_length=128, default=''))
    assign('priority', integer(data.get('priority'), '优先级', minimum=1, maximum=1000, default=100))
    assign('weight', integer(data.get('weight'), '权重', minimum=1, maximum=1000, default=100))
    assign('request_timeout_seconds', integer(data.get('request_timeout_seconds'), '请求超时', minimum=5, maximum=300, default=120))
    assign('enabled', boolean(data.get('enabled'), True))
    assign('note', text(data.get('note'), '备注', max_length=255))
    if not partial or 'model_prefix' in data:
        out['model_prefix'] = normalize_model_prefix(data.get('model_prefix'))
    if not partial or 'extra_headers' in data or 'extra_headers_json' in data:
        out['extra_headers_json'] = json.dumps(normalize_extra_headers(data), ensure_ascii=False)
    return {
        key: value for key, value in out.items()
        if value is not None or key in ('note', 'proxy_url')
    }


def normalize_model_prefix(value):
    raw = '' if value is None else str(value).strip()
    if not raw:
        return ''
    if len(raw) > 64:
        raise AgentValidationError('模型前缀不能超过 64 个字符')
    if any(ch.isspace() or ch in '\\\r\n' for ch in raw):
        raise AgentValidationError('模型前缀不能包含空白或反斜杠')
    return raw


def normalize_proxy_url(value):
    raw = '' if value is None else str(value).strip()
    if not raw:
        return None
    if len(raw) > 512 or any(ch in raw for ch in '\r\n'):
        raise AgentValidationError('出站代理地址不合法')
    parsed = urlsplit(raw)
    try:
        port = parsed.port
    except ValueError as exc:
        raise AgentValidationError('出站代理必须包含有效端口') from exc
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.fragment:
        raise AgentValidationError('出站代理必须是有效的 HTTP(S) 地址')
    if port is not None and not 1 <= port <= 65535:
        raise AgentValidationError('出站代理端口必须在 1-65535 之间')
    return raw.rstrip('/')


def normalize_extra_headers(data):
    raw = data.get('extra_headers')
    if raw is None:
        raw = data.get('extra_headers_json')
    if raw in (None, '', {}, []):
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError as exc:
            raise AgentValidationError('自定义请求头必须是 JSON 对象') from exc
    if not isinstance(raw, dict):
        raise AgentValidationError('自定义请求头必须是对象')
    if len(raw) > 20:
        raise AgentValidationError('自定义请求头最多 20 项')
    out = {}
    for key, value in raw.items():
        name = str(key).strip()
        if not name or len(name) > 64 or not _HEADER_NAME_RE.match(name):
            raise AgentValidationError(f'请求头名称不合法：{key}')
        if name.lower() in _BLOCKED_HEADERS:
            raise AgentValidationError(f'不允许覆盖请求头：{name}')
        text_value = '' if value is None else str(value).strip()
        if any(ch in text_value for ch in '\r\n') or len(text_value) > 512:
            raise AgentValidationError(f'请求头 {name} 的值不合法')
        out[name] = text_value
    return out


__all__ = ['AgentValidationError', 'normalize_credential_payload', 'normalize_extra_headers', 'normalize_proxy_url']
