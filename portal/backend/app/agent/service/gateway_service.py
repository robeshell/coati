# -*- coding: utf-8 -*-
"""LLM 网关。

对下三套协议始终开：Chat Completions、Anthropic Messages、OpenAI Responses。
对上由账号明确声明接口类型；调度先过滤兼容账号，再决定原样转发或翻译。
"""

import codecs
import hashlib
import hmac
import json
import re
import threading
import time
from uuid import uuid4
from datetime import datetime
from urllib import error as urlerror
from urllib import request as urlrequest

from flask import Response, current_app, g, stream_with_context

from backend.app.agent.constants import (
    AUTO_ROUTE_MODEL,
    UPSTREAM_ANTHROPIC_MESSAGES,
    UPSTREAM_OPENAI_CHAT,
    UPSTREAM_OPENAI_RESPONSES,
    credential_upstream_protocol,
    upstream_accepts_inbound,
)
from backend.app.agent.crud import AgentCredentialCRUD, AgentModelProfileCRUD, AgentRouteCRUD
from backend.app.agent.service.credential_service import (
    ACTIVE_CREDENTIAL_REQUESTS,
    AgentCredentialError,
    AgentCredentialService,
)
from backend.app.agent.service.protocol_bridge import (
    ProtocolBridgeError,
    server_tool_use_id,
    bridge_request_body,
    bridge_response_body,
    build_stream_bridge,
    stream_error_message,
)
from backend.app.agent.service.model_profile_catalog import LiteLLMModelCatalog
from backend.app.agent.service.server_tools import (
    WEB_SEARCH_SUPPORT,
    DEFAULT_MAX_USES,
    MAX_QUERY_LENGTH,
    SEARCH_RESULT_LIMIT,
    WEB_SEARCH_TOOL_NAME,
    WEB_FETCH_TOOL_NAME,
    MAX_URL_LENGTH,
    anthropic_message_to_sse,
    apply_server_tools,
    extract_server_tools,
    fetch_tool_use_block,
    fetch_url_from_input,
    is_server_tool_call,
    native_server_tool_kinds,
    render_fetch_error,
    render_fetch_result,
    web_fetch_error_block,
    web_fetch_result_block,
    filter_sources,
    has_leaked_tool_call_text,
    is_server_web_search_block,
    localized_query,
    normalize_server_tool_history,
    render_search_error,
    render_search_results,
    responses_builtin_tool_types,
    search_only_query,
    search_queries_from_input,
    server_tool_use_block,
    web_search_error_block,
    web_search_tool_result_block,
)
from backend.app.agent.service.provider_adapters import ProviderAdapterError, get_provider_adapter
from backend.app.agent.service.proxy import proxy_mapping
from backend.app.agent.service.search_providers import (
    SearchProviderError,
    configured_search_provider,
)
from backend.app.agent.service.session_affinity_service import AgentSessionAffinityService
from backend.app.agent.service.usage_service import (
    AgentUsageError,
    AgentUsageService,
    INTERNAL_ATTEMPT_TRACE_PREFIX,
)


class AgentGatewayError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


DEFAULT_CONTEXT_WINDOW = 128000
DEFAULT_MAX_OUTPUT_TOKENS = 8192
DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8
DEFAULT_COMPACTION_RETAIN_RATIO = 0.16


# 让同一 worker 内的“读负载→选路→预留→绑定”成为一个短临界区；
# 不锁住真正的上游请求，避免把吞吐量变成串行。
_ROUTE_SELECTION_LOCK = threading.Lock()


_BLOCKED_REQUEST_HEADERS = {
    'authorization', 'x-api-key', 'host', 'content-length',
    'connection', 'transfer-encoding', 'cookie',
}


def apply_credential_headers(req, credential):
    extra = credential.extra_headers() if credential is not None and hasattr(credential, 'extra_headers') else {}
    for name, value in extra.items():
        if str(name).lower() in _BLOCKED_REQUEST_HEADERS:
            continue
        req.add_header(name, value)
    return req


# 上游欠费/配额耗尽文案（例如余额不足、明确的配额耗尽）。
_BILLING_MARKERS = (
    'insufficient balance',
    'exceeded your current quota',
    'exceeded_current_quota',
)


def classify_upstream_http(code, err_body=''):
    """判断上游 HTTP 错误是否可换 Key、该 Key 是否应立即踢出调度。

    返回 (retryable, immediate)：
    - retryable: 换一把 Key 可能成功（401/402/403/408/429/5xx，或正文像欠费）
    - immediate: 鉴权/明确欠费不会自行恢复，应立即冷却，不要等连续失败阈值

    429 一律按临时限流处理。即使正文带有 OpenAI/阿里云常见的
    ``insufficient_quota``，也不能在网关侧把唯一账号硬冷却，否则 dsh 的下一次
    重试会被网关提前返回“没有可用模型账号”，用户反而无法继续重试。
    请求体本身有问题（普通 400）两者都为 False，原样回传。
    """
    body = (err_body or '').lower()
    billing = any(marker in body for marker in _BILLING_MARKERS)
    immediate = code in (401, 402, 403) or (billing and code != 429)
    retryable = immediate or code in (408, 429) or code >= 500
    return retryable, immediate


_TRANSIENT_CONNECTION_MARKERS = (
    'unexpected_eof',
    'eof occurred in violation of protocol',
    'connection reset',
    'connection aborted',
    'broken pipe',
    'timed out',
    'timeout',
    'temporary failure in name resolution',
    'network is unreachable',
    'ssl',
    'tls',
)


def classify_connection_error(exc):
    """网络/TLS 瞬时故障可在同 Key 或换 Key 后重试。"""
    if isinstance(exc, TimeoutError):
        return True, str(exc)
    reason = getattr(exc, 'reason', None)
    text = str(reason if reason is not None else exc)
    lower = text.lower()
    transient = any(marker in lower for marker in _TRANSIENT_CONNECTION_MARKERS)
    return transient, text


def _header_value(headers, names):
    headers = headers or {}
    for name in names:
        value = headers.get(name)
        if value not in (None, ''):
            return str(value).strip()
    return None


def _bounded_header_int(headers, names, maximum):
    value = _header_value(headers, names)
    if not value:
        return None
    try:
        value = int(value)
    except (TypeError, ValueError):
        return None
    return max(0, min(maximum, value))


def _session_digest(prefix, value):
    secret = str(current_app.config.get('SECRET_KEY') or 'coati-session-fingerprint').encode('utf-8')
    digest = hmac.new(secret, value, hashlib.sha256).hexdigest()
    return f'{prefix}_{digest[:64 - len(prefix) - 1]}'


def _normalize_session_id(value):
    if value in (None, '') or isinstance(value, (dict, list, tuple)):
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if len(raw) <= 64:
        return raw
    return _session_digest('id', raw.encode('utf-8'))


def _body_session_id(body):
    if not isinstance(body, dict):
        return None
    for key in ('session_id', 'sessionId', 'prompt_cache_key', 'conversation_id'):
        value = _normalize_session_id(body.get(key))
        if value:
            return value
    conversation = body.get('conversation')
    if isinstance(conversation, dict):
        return _normalize_session_id(conversation.get('id'))
    return _normalize_session_id(conversation)


def _initial_message_fingerprint(body):
    """为无会话字段但会携带完整历史的兼容客户端生成不落原文的稳定指纹。"""
    if not isinstance(body, dict):
        return None
    items = body.get('messages')
    if not isinstance(items, list):
        items = body.get('input')
    if isinstance(items, str):
        user_content = items
        system_content = body.get('instructions') or body.get('system')
    elif isinstance(items, list):
        system_content = body.get('instructions') or body.get('system')
        user_content = None
        for item in items:
            if not isinstance(item, dict):
                continue
            role = str(item.get('role') or '').lower()
            if system_content in (None, '') and role in {'system', 'developer'}:
                system_content = item.get('content')
            if role == 'user':
                user_content = item.get('content')
                break
    else:
        return None
    if user_content in (None, '', [], {}):
        return None
    serialized = json.dumps(
        {'system': system_content, 'user': user_content},
        ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=str,
    ).encode('utf-8')
    return _session_digest('msg', serialized)


def request_trace_metadata(headers, body=None):
    """读取客户端链路信息；必要时只计算消息 HMAC，不保存提示词原文。"""
    explicit_session = _header_value(headers, (
        'X-COATI-Session-ID',
        'X-Claude-Code-Session-Id',
        'Session-Id',
        'Session_id',
        'X-Session-ID',
        'X-Session-Affinity',
        'X-Amp-Thread-Id',
    ))
    session_id = _normalize_session_id(explicit_session)
    session_source = 'header' if session_id else None
    if not session_id:
        session_id = _body_session_id(body)
        session_source = 'body' if session_id else None
    if not session_id:
        # 指纹只用于日志关联，不作为会话粘性的强依据；相同首句的两个独立
        # 对话不能因此被绑定到同一上游账号。
        session_id = _initial_message_fingerprint(body)
        session_source = 'fingerprint' if session_id else None
    return {
        'session_id': session_id,
        'session_source': session_source,
        'client_request_id': (_header_value(
            headers, ('X-COATI-Request-ID', 'X-Client-Request-ID'),
        ) or '')[:128] or None,
        'step_index': _bounded_header_int(headers, ('X-COATI-Step', 'X-Agent-Step'), 1_000_000),
        'retry_index': _bounded_header_int(headers, ('X-COATI-Retry', 'X-Agent-Retry'), 100),
    }


def _json_size(value):
    try:
        return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    except (TypeError, ValueError):
        return 0


def _count_images(value):
    if isinstance(value, list):
        return sum(_count_images(item) for item in value)
    if not isinstance(value, dict):
        return 0
    count = 1 if value.get('type') in {'image', 'image_url', 'input_image'} else 0
    return count + sum(_count_images(item) for item in value.values())


_TOOL_RESULT_ROLES = {'tool', 'toolresult', 'tool_result'}
_TOOL_RESULT_TYPES = {
    'tool_result',
    'function_call_output',
    'web_search_tool_result',
    'web_fetch_tool_result',
}


def _tool_result_size(value):
    """统计不同入站协议里的工具结果，不保存结果正文。"""
    if isinstance(value, list):
        return sum(_tool_result_size(item) for item in value)
    if not isinstance(value, dict):
        return 0
    role = str(value.get('role') or '').lower()
    if role in _TOOL_RESULT_ROLES:
        return _json_size(value)
    if str(value.get('type') or '').lower() in _TOOL_RESULT_TYPES:
        # 一个结果块里可能还嵌有 web_search_result/document；按结果块计一次，
        # 不把嵌套来源再重复累计。
        return _json_size(value)
    content = value.get('content')
    return _tool_result_size(content) if content is not None else 0


def context_metadata(body, usage_service, *, tool_result_bytes_offset=0):
    """记录上下文形态，便于定位超长消息/工具结果，但不落原文。"""
    body = body if isinstance(body, dict) else {}
    messages = body.get('messages')
    if isinstance(messages, list):
        message_items = messages
    elif isinstance(body.get('input'), list):
        message_items = body.get('input')
    elif body.get('input') not in (None, ''):
        message_items = [body.get('input')]
    else:
        message_items = []

    estimate = {
        'messages': body.get('messages'),
        'tools': body.get('tools'),
        'response_format': body.get('response_format'),
    }
    for key in ('input', 'instructions', 'system'):
        if body.get(key) is not None:
            estimate[key] = body.get(key)

    tool_result_bytes = _tool_result_size(message_items)
    try:
        tool_result_bytes += max(0, int(tool_result_bytes_offset or 0))
    except (TypeError, ValueError):
        pass
    return {
        'context_tokens_estimate': usage_service.estimate_tokens(estimate),
        'context_bytes': _json_size(body),
        'message_count': len(message_items),
        'tool_count': len(body.get('tools') or []) if isinstance(body.get('tools'), list) else 0,
        'image_count': _count_images(message_items),
        'tool_result_bytes': tool_result_bytes,
        'largest_message_bytes': max((_json_size(item) for item in message_items), default=0),
    }


def stream_completion_estimate_value(payload):
    """提取各协议流式增量中的实际模型输出，供异常中断时估算用量。"""
    if not isinstance(payload, dict):
        return None
    pieces = []
    choices = payload.get('choices')
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            delta = choice.get('delta') if isinstance(choice.get('delta'), dict) else {}
            for key in ('content', 'reasoning_content'):
                value = delta.get(key)
                if value:
                    pieces.append(value)
            for call in delta.get('tool_calls') or []:
                if not isinstance(call, dict):
                    continue
                function = call.get('function') if isinstance(call.get('function'), dict) else {}
                if function.get('name'):
                    pieces.append(function['name'])
                if function.get('arguments'):
                    pieces.append(function['arguments'])
    kind = str(payload.get('type') or '')
    if kind == 'content_block_start':
        block = payload.get('content_block') if isinstance(payload.get('content_block'), dict) else {}
        if block.get('type') == 'tool_use' and block.get('name'):
            pieces.append(block['name'])
    elif kind == 'content_block_delta':
        delta = payload.get('delta') if isinstance(payload.get('delta'), dict) else {}
        for key in ('text', 'thinking', 'partial_json'):
            if delta.get(key):
                pieces.append(delta[key])
    elif kind.endswith('.delta'):
        if payload.get('delta'):
            pieces.append(payload['delta'])
    elif kind == 'response.output_item.added':
        item = payload.get('item') if isinstance(payload.get('item'), dict) else {}
        if item.get('type') in ('function_call', 'custom_tool_call') and item.get('name'):
            pieces.append(item['name'])
    return pieces or None


def _transient_connection_retries():
    return max(0, min(2, int(current_app.config.get('AGENT_GATEWAY_TRANSIENT_RETRIES', 1) or 1)))


def urlopen_with_transient_retry(req, timeout, proxy_url=None):
    """对 SSL/连接类瞬时错误在同 Key 上短暂重试，再交给调度换号。"""
    retries = _transient_connection_retries()
    last_exc = None
    for attempt in range(retries + 1):
        try:
            if proxy_url:
                opener = urlrequest.build_opener(urlrequest.ProxyHandler(proxy_mapping(proxy_url)))
                return opener.open(req, timeout=timeout)
            return urlrequest.urlopen(req, timeout=timeout)
        except (urlerror.URLError, TimeoutError, OSError) as exc:
            last_exc = exc
            transient, _ = classify_connection_error(exc)
            if not transient or attempt >= retries:
                raise
    if last_exc is not None:
        raise last_exc
    raise RuntimeError('urlopen_with_transient_retry: unreachable')


# 鉴权失败的错误文案里经常直接回显 Key（实测形如 "invalid api key sk-xxx"）。
# 用户需要知道「Key 无效」这个原因，但不该拿到 Key 本身。
_SECRET_LIKE = re.compile(
    r'\b(sk|tvly|gsk|key|token)[-_][A-Za-z0-9_\-]{8,}\b', re.IGNORECASE,
)


def redact_secrets(text, *known):
    """把消息里的密钥抹掉，保留其余诊断信息。"""
    value = str(text or '')
    if not value:
        return value
    for secret in known:
        secret = str(secret or '').strip()
        if len(secret) >= 8 and secret in value:
            value = value.replace(secret, f'{secret[:4]}***')
    return _SECRET_LIKE.sub(lambda m: f'{m.group(0)[:6]}***', value)


def parse_upstream_error_body(raw):
    """把上游错误体解析成对象，剥掉 SSE 帧与字符串套娃。

    流式请求出错时，有的上游返回的不是 JSON 而是一整帧 SSE
    （event:error\ndata:{...}），而且 message 里还会再套一层 "data: {json}"。
    直接当字符串塞进 {'error': ...} 的话，客户端要剥三层才能看到真实原因，
    实际使用中等于没有错误信息。
    """
    text = (raw or '').strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # SSE 帧：只取 data: 行拼回 JSON。
        payload = '\n'.join(
            line.split(':', 1)[1].strip()
            for line in text.splitlines()
            if line.startswith('data:')
        ).strip()
        if not payload or payload == '[DONE]':
            return None
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            return None
    # 上游可能把真正的错误又当字符串塞进 message，最多再剥两层。
    for _ in range(2):
        if not isinstance(parsed, dict):
            break
        message = parsed.get('message')
        if not isinstance(message, str):
            break
        inner = message.strip()
        if inner.startswith('data:'):
            inner = inner.split(':', 1)[1].strip()
        if not inner.startswith('{'):
            break
        try:
            unwrapped = json.loads(inner)
        except json.JSONDecodeError:
            break
        if not isinstance(unwrapped, dict):
            break
        parsed = unwrapped.get('error') if isinstance(unwrapped.get('error'), dict) else unwrapped
    return parsed


class AgentGatewayService:
    def __init__(self, db, models):
        self.models = models
        self.usage = AgentUsageService(db, models)
        self.credentials = AgentCredentialService(db, models)
        self.route_crud = AgentRouteCRUD(db, models)
        self.credential_crud = AgentCredentialCRUD(db, models)
        self.model_profile_crud = AgentModelProfileCRUD(db, models)
        self.model_capability_catalog = LiteLLMModelCatalog(db, models)
        self.session_affinity = AgentSessionAffinityService(db, models)

    def _proxy_for(self, credential):
        getter = getattr(self.credentials, 'proxy_secret', None)
        return getter(credential) if callable(getter) else None

    @staticmethod
    def _selection_pool_size(max_attempts):
        """新会话选号池与实际故障转移次数分离。"""
        try:
            configured = int(current_app.config.get(
                'AGENT_GATEWAY_SELECTION_POOL_SIZE', 7,
            ) or 7)
        except (TypeError, ValueError):
            configured = 7
        return min(50, max(max_attempts, max(1, configured)))

    def _active_credential_loads(self, credential_ids, *, include_local=False):
        """读取跨 worker 的进行中请求数，DB 失败时使用 worker 内存兜底。"""
        credential_ids = [item for item in (credential_ids or []) if item is not None]
        if not credential_ids:
            return {}

        usage = getattr(self, 'usage', None)
        if usage is not None:
            try:
                # reserved 记录已覆盖正常平台请求，不能再叠加本 worker 计数。
                loads = usage.active_credential_loads(credential_ids)
                if not include_local:
                    return loads
                local_loads = ACTIVE_CREDENTIAL_REQUESTS.snapshot(credential_ids)
                return {
                    credential_id: int(loads.get(credential_id, 0) or 0)
                    + int(local_loads.get(credential_id, 0) or 0)
                    for credential_id in set(loads) | set(local_loads)
                }
            except Exception:
                try:
                    usage.recover_transaction()
                except Exception:
                    pass
                current_app.logger.warning('读取进行中账号负载失败，回退 worker 内存计数', exc_info=True)
        return ACTIVE_CREDENTIAL_REQUESTS.snapshot(credential_ids)

    def _order_personal_candidates(self, candidates):
        """个人渠道无强会话时，按活跃负载和权重分散首选账号。"""
        candidates = list(candidates or [])
        if len(candidates) <= 1:
            return candidates
        active_requests = self._active_credential_loads(
            [getattr(row, 'id', None) for row in candidates],
            include_local=True,
        )
        if not any(int(value or 0) > 0 for value in active_requests.values()):
            priorities = sorted(
                {int(getattr(row, 'priority', 0) or 0) for row in candidates},
                reverse=True,
            )
            ordered = []
            for priority in priorities:
                bucket = [
                    row for row in candidates
                    if int(getattr(row, 'priority', 0) or 0) == priority
                ]
                ordered.extend(AgentCredentialService._weighted_order(bucket))
            return ordered

        ordered = []
        priorities = sorted(
            {int(getattr(row, 'priority', 0) or 0) for row in candidates},
            reverse=True,
        )
        for priority in priorities:
            bucket = [
                row for row in candidates
                if int(getattr(row, 'priority', 0) or 0) == priority
            ]
            remaining = list(bucket)
            while remaining:
                scores = {
                    row.id: (
                        int(active_requests.get(row.id, 0) or 0) + 1
                    ) / max(1, int(getattr(row, 'weight', 1) or 1))
                    for row in remaining
                }
                best_score = min(scores.values())
                ties = [row for row in remaining if scores[row.id] == best_score]
                ordered.extend(AgentCredentialService._weighted_order(ties))
                remaining = [row for row in remaining if row not in ties]
        return ordered

    @staticmethod
    def _session_affinity_model_key(route, model_name, effective_model):
        route_key = f'route:{route.id}' if route else 'pool'
        return f'{route_key}:{model_name or "default"}:{effective_model or "default"}'[:255]

    def _resolve_session_affinity(self, user_id, session_id, model_key):
        service = getattr(self, 'session_affinity', None)
        if service is None:
            return None
        try:
            return service.resolve(user_id, session_id, model_key)
        except Exception:
            # 亲和存储异常不能阻断模型请求，退回原有账号池调度。
            try:
                service.recover_transaction()
            except Exception:
                pass
            current_app.logger.warning('读取会话亲和绑定失败，已回退普通调度', exc_info=True)
            return None

    def _bind_route_session(self, route):
        service = getattr(self, 'session_affinity', None)
        context = (route or {}).get('_session_affinity')
        credential_id = (route or {}).get('credential_id')
        if service is None or not context or credential_id is None:
            return None
        try:
            return service.bind(context, credential_id)
        except Exception:
            try:
                service.recover_transaction()
            except Exception:
                pass
            current_app.logger.warning('写入会话亲和绑定失败，模型响应不受影响', exc_info=True)
            return None

    def _bind_request_credential(self, request_id, route):
        """把 reserved 请求更新为当前实际尝试的账号。"""
        credential_id = (route or {}).get('credential_id')
        if not request_id or credential_id is None:
            return
        try:
            self.usage.bind_credential(request_id, credential_id)
        except Exception:
            current_app.logger.warning(
                '记录进行中请求账号失败，实时负载可能短暂低估',
                exc_info=True,
            )

    def _canonicalize_session_routes(
        self, routes, *, lookup_model, display_model, upstream_override, user, session_id,
        inbound_protocol=None,
    ):
        """在首个上游请求前确定并沿用会话的规范账号。

        多 worker 同时处理同一新会话时，两个 worker 可能都在首次查询时看不到
        binding。CRUD 层保证 first-writer-wins；这里把后到请求切换到先绑定的账号，
        避免它已经选了另一个候选账号后才开始访问上游。
        """
        routes = list(routes or [])
        first = routes[0] if routes else None
        if not first or not first.get('_session_affinity'):
            return routes
        binding = self._bind_route_session(first)
        canonical_id = getattr(binding, 'credential_id', None)
        if canonical_id is None or canonical_id == first.get('credential_id'):
            return routes

        canonical = next(
            (route for route in routes if route.get('credential_id') == canonical_id),
            None,
        )
        if canonical is not None:
            return [canonical] + [route for route in routes if route is not canonical]

        # 规范账号可能落在本 worker 的实际尝试上限之外，但仍应优先恢复同一
        # 会话的绑定；重新解析会让 affinity credential 被放到候选首位。
        try:
            refreshed = self.resolve_routes(
                lookup_model,
                display_model=display_model,
                upstream_override=upstream_override,
                user=user,
                session_id=session_id,
                inbound_protocol=inbound_protocol,
            )
        except AgentGatewayError:
            return routes
        if refreshed and refreshed[0].get('credential_id') == canonical_id:
            return refreshed
        return routes

    def _invalidate_route_session(self, route):
        context = (route or {}).get('_session_affinity')
        credential_id = (route or {}).get('credential_id')
        self._invalidate_session_context(context, credential_id)

    def _invalidate_session_context(self, context, credential_id):
        service = getattr(self, 'session_affinity', None)
        if service is None or not context or credential_id is None:
            return
        try:
            service.invalidate(context, credential_id)
        except Exception:
            try:
                service.recover_transaction()
            except Exception:
                pass
            current_app.logger.warning('清除会话亲和绑定失败，模型重试继续执行', exc_info=True)

    def resolve_routes(
        self, requested_model, display_model=None, upstream_override=None, user=None,
        session_id=None, inbound_protocol=None,
    ):
        model_name = (requested_model or '').strip()
        user_id = getattr(user, 'id', None)
        if user_id and model_name:
            personal_rows = self.credentials.personal_matching(user_id, model_name)
            matched_personal_rows = list(personal_rows)
            if inbound_protocol:
                personal_rows = [
                    row for row in personal_rows
                    if upstream_accepts_inbound(
                        credential_upstream_protocol(row), inbound_protocol,
                    )
                ]
            if matched_personal_rows and not personal_rows:
                raise AgentGatewayError('个人渠道的上游接口与当前客户端协议不兼容', 422)
            if personal_rows:
                return self._resolve_personal_routes(
                    personal_rows,
                    model_name,
                    display_model=display_model,
                    session_id=session_id,
                    user_id=user_id,
                )
        route = None
        if model_name:
            route = self.route_crud.get_enabled_by_model(model_name)
        override = (upstream_override or '').strip() or None
        effective_model = (
            override
            or (route.upstream_model if route and route.upstream_model else None)
            or model_name
            or None
        )
        max_attempts = min(10, max(1, int(current_app.config.get('AGENT_GATEWAY_MAX_ATTEMPTS', 3) or 3)))
        selection_pool_size = self._selection_pool_size(max_attempts)
        affinity_context = None

        try:
            if route and route.credential_id:
                bound = self.credential_crud.get(route.credential_id)
                primary_model = (
                    override
                    or (route.upstream_model or '').strip()
                    or model_name
                    or None
                )
                # 回退进 Key 池时按实际上游模型匹配，不用客户端入口名（如 coati-coding / coati-auto）。
                pool_model = (
                    override
                    or (route.upstream_model or '').strip()
                    or getattr(bound, 'default_model', None)
                    or None
                )
                try:
                    candidates = self.credentials.candidates(
                        credential_id=route.credential_id,
                        preferred_model=primary_model,
                        require_model_match=bool(primary_model),
                        inbound_protocol=inbound_protocol,
                    )
                except AgentCredentialError:
                    if not route.fallback_enabled:
                        raise
                    candidates = self.credentials.candidates(
                        preferred_model=pool_model,
                        require_model_match=bool(pool_model),
                        limit=max_attempts,
                        inbound_protocol=inbound_protocol,
                    )
                else:
                    if route.fallback_enabled and max_attempts > 1:
                        try:
                            fallback = self.credentials.candidates(
                                preferred_model=pool_model,
                                require_model_match=bool(pool_model),
                                limit=max_attempts - 1,
                                inbound_protocol=inbound_protocol,
                            )
                        except AgentCredentialError:
                            fallback = []
                        candidates.extend(row for row in fallback if row.id != route.credential_id)
            else:
                affinity_context = self._resolve_session_affinity(
                    user_id,
                    session_id,
                    self._session_affinity_model_key(route, model_name, effective_model),
                )
                affinity_credential = None
                affinity_credential_id = (
                    affinity_context.get('credential_id') if affinity_context else None
                )
                if affinity_credential_id is not None:
                    try:
                        affinity_credential = self.credentials.candidates(
                            credential_id=affinity_credential_id,
                            inbound_protocol=inbound_protocol,
                        )[0]
                    except AgentCredentialError:
                        self._invalidate_session_context(
                            affinity_context, affinity_credential_id,
                        )
                        affinity_context['credential_id'] = None
                        affinity_context['hit'] = False
                    else:
                        matches_model = (
                            not effective_model
                            or AgentCredentialService._row_matches_model(
                                affinity_credential, effective_model, allow_upstream=True,
                            )
                        )
                        healthy = not AgentCredentialService._unhealthy_in_penalty(
                            affinity_credential,
                        )
                        if not matches_model or not healthy:
                            self._invalidate_session_context(
                                affinity_context, affinity_credential_id,
                            )
                            affinity_context['credential_id'] = None
                            affinity_context['hit'] = False
                            affinity_credential = None
                candidates = self.credentials.candidates(
                    preferred_model=effective_model,
                    require_model_match=bool(effective_model),
                    limit=selection_pool_size,
                    affinity_key=(
                        affinity_context.get('selection_key') if affinity_context else None
                    ),
                    inbound_protocol=inbound_protocol,
                )
                active_requests = self._active_credential_loads(
                    [getattr(row, 'id', None) for row in candidates],
                )
                affinity_service = getattr(self, 'session_affinity', None)
                if affinity_service is not None and (
                    not affinity_context or not affinity_context.get('hit')
                ):
                    candidates = affinity_service.order_initial_candidates(
                        affinity_context, candidates,
                        active_requests=active_requests,
                    )
                if affinity_credential is not None:
                    candidates = [affinity_credential] + [
                        row for row in candidates if row.id != affinity_credential.id
                    ]
                    candidates = candidates[:max_attempts]
        except AgentCredentialError as e:
            raise AgentGatewayError(e.message, e.status_code, e.payload) from e

        resolved = []
        unavailable = []
        for cred in candidates:
            try:
                adapter = get_provider_adapter(getattr(cred, 'provider', 'openai-compatible'))
                adapter.assert_available()
                key = (
                    self.credentials.secret(cred)
                    if getattr(cred, 'id', None) is not None
                    else cred.api_key
                )
                proxy_url = self._proxy_for(cred)
            except (ProviderAdapterError, AgentCredentialError) as exc:
                unavailable.append(getattr(exc, 'message', None) or str(exc))
                if (
                    affinity_context
                    and getattr(cred, 'id', None) == affinity_context.get('credential_id')
                ):
                    self._invalidate_session_context(
                        affinity_context, affinity_context.get('credential_id'),
                    )
                    affinity_context['credential_id'] = None
                    affinity_context['hit'] = False
                continue
            resolver = getattr(cred, 'upstream_model_for', None)
            upstream_model = resolver(effective_model) if callable(resolver) else None
            upstream_model = upstream_model or effective_model or cred.default_model
            is_bound_primary = bool(route and route.credential_id and cred.id == route.credential_id)
            base = (
                (route.upstream_base if is_bound_primary and route.upstream_base else None)
                or cred.base_url
            ).rstrip('/')
            resolved.append({
                'base': base,
                'key': key,
                'model': upstream_model,
                'requested': display_model or model_name or cred.default_model,
                'route_id': getattr(route, 'id', None),
                'credential_id': getattr(cred, 'id', None),
                'credential': cred,
                'provider': adapter.code,
                'adapter': adapter,
                'upstream_protocol': credential_upstream_protocol(cred),
                'proxy_url': proxy_url,
                'timeout': min(300, max(5, int(getattr(cred, 'request_timeout_seconds', 120) or 120))),
            })
            if affinity_context:
                resolved[-1]['_session_affinity'] = affinity_context
            if len(resolved) >= max_attempts:
                break
        if not resolved:
            detail = unavailable[0] if unavailable else '没有可用的上游 Provider Adapter'
            raise AgentGatewayError(detail, 503)
        return resolved

    def _resolve_personal_routes(
        self, rows, model_name, display_model=None, session_id=None, user_id=None,
    ):
        now = datetime.utcnow()
        available = [row for row in rows if not AgentCredentialService._in_cooldown(row, now)]
        if not available:
            raise AgentGatewayError(
                '个人渠道当前不可用，请检查渠道或切换其他模型',
                502,
            )

        # 个人渠道不走平台路由表，之前一直按数据库顺序返回，导致同一会话在多条
        # 个人渠道之间没有稳定选择。缓存依赖同一账号，同一 session 应该先命中同一
        # 条个人渠道；出现故障时仍保留其余渠道作为本次请求的故障转移候选。
        if session_id:
            affinity_key = f'personal:{user_id or 0}:{session_id}:{model_name}'
            ordered = []
            priorities = sorted(
                {int(row.priority or 0) for row in available}, reverse=True,
            )
            for priority in priorities:
                bucket = [row for row in available if int(row.priority or 0) == priority]
                ordered.extend(
                    AgentCredentialService._weighted_rendezvous_order(
                        bucket, affinity_key,
                    )
                )
            available = ordered
        else:
            available = self._order_personal_candidates(available)

        resolved = []
        unavailable = []
        for cred in available:
            try:
                adapter = get_provider_adapter(getattr(cred, 'provider', 'openai-compatible'))
                adapter.assert_available()
                key = self.credentials.secret(cred)
                proxy_url = self._proxy_for(cred)
            except (ProviderAdapterError, AgentCredentialError) as exc:
                unavailable.append(getattr(exc, 'message', None) or str(exc))
                continue
            resolved.append({
                'base': cred.base_url.rstrip('/'),
                'key': key,
                'model': cred.upstream_model_for(model_name) or cred.default_model,
                'requested': display_model or model_name or cred.default_model,
                'route_id': None,
                'credential_id': cred.id,
                'credential': cred,
                'provider': adapter.code,
                'adapter': adapter,
                'upstream_protocol': credential_upstream_protocol(cred),
                'personal': True,
                'proxy_url': proxy_url,
                'timeout': min(300, max(5, int(getattr(cred, 'request_timeout_seconds', 120) or 120))),
            })
        if not resolved:
            detail = unavailable[0] if unavailable else '个人渠道当前不可用，请检查渠道或切换其他模型'
            raise AgentGatewayError(detail, 502)
        return resolved

    def resolve_route(self, requested_model):
        return self.resolve_routes(requested_model)[0]

    def resolve_search_routes(self):
        """从已配置且声明网页搜索能力的 Provider 中选择账号。"""
        max_attempts = min(10, max(1, int(current_app.config.get('AGENT_GATEWAY_MAX_ATTEMPTS', 3) or 3)))
        try:
            candidates = self.credentials.candidates(
                preferred_model=None,
                provider=None,
                require_model_match=False,
                # 先拿完整健康池再按 Adapter 能力过滤，避免高优先级的普通
                # Chat 账号占满候选池，让后面的搜索 Provider 永远进不来。
                limit=None,
            )
        except AgentCredentialError as e:
            raise AgentGatewayError(e.message, e.status_code, e.payload) from e

        active_requests = self._active_credential_loads(
            [getattr(row, 'id', None) for row in candidates],
        )
        affinity_service = getattr(self, 'session_affinity', None)
        if affinity_service is not None:
            candidates = affinity_service.order_initial_candidates(
                None, candidates, active_requests=active_requests,
            )

        # 已实测会执行的账号优先，未探过的其次；否则高优先级的普通对话账号会
        # 一直占满候选位，让真正能搜的那把永远轮不上。
        candidates = sorted(
            candidates,
            key=lambda row: 0 if WEB_SEARCH_SUPPORT.executes(getattr(row, 'id', None)) else 1,
        )

        resolved = []
        unavailable = []
        for cred in candidates:
            try:
                adapter = get_provider_adapter(getattr(cred, 'provider', 'openai-compatible'))
                adapter.assert_available()
                # 搜索打的是 Anthropic Messages 形状，所以那个地址必须真实存在：
                # 要么账号本身就是 anthropic-messages 上游，要么这个厂商在基址旁边
                # 另有一个已知路径的 Anthropic 端点（DeepSeek 就是）。把一个
                # /compatible-mode/v1 基址拼成 /v1/messages 只会换回 400。
                # 注意这判的是「地址存不存在」，不是「能不能执行搜索」——后者仍然
                # 只能按实际回包观测。
                cred_protocol = credential_upstream_protocol(cred)
                if not (
                    cred_protocol in (UPSTREAM_ANTHROPIC_MESSAGES, UPSTREAM_OPENAI_RESPONSES)
                    or getattr(adapter, 'anthropic_endpoint_beside_base', False)
                ):
                    unavailable.append(
                        f'{getattr(cred, "name", "模型账号")} 没有可用的服务端搜索端点'
                    )
                    continue
                if WEB_SEARCH_SUPPORT.executes(getattr(cred, 'id', None)) is False:
                    unavailable.append(
                        f'{getattr(cred, "name", "模型账号")} 实测不执行服务端搜索'
                    )
                    continue
                key = (
                    self.credentials.secret(cred)
                    if getattr(cred, 'id', None) is not None
                    else cred.api_key
                )
                proxy_url = self._proxy_for(cred)
            except (ProviderAdapterError, AgentCredentialError) as exc:
                unavailable.append(getattr(exc, 'message', None) or str(exc))
                continue
            supported = cred.supported_models() if hasattr(cred, 'supported_models') else []
            # 搜索接口属于 Provider 能力，但实际模型仍由账号配置决定。
            # 不再为了“优先 flash”在网关里写死某个模型名。
            upstream_model = (cred.default_model or (supported[0] if supported else '')).strip()
            if not upstream_model:
                unavailable.append(f'{getattr(cred, "name", "模型账号")} 未配置网页搜索模型')
                continue
            base = (cred.base_url or adapter.default_base_url or '').rstrip('/')
            resolved.append({
                'base': base,
                'key': key,
                'model': upstream_model,
                'requested': upstream_model,
                # 搜索/抓取的请求形状按上游协议分派：Anthropic Messages 用 server
                # tool 声明，Responses 用它的内置 web_search。
                'upstream_protocol': (
                    cred_protocol
                    if cred_protocol == UPSTREAM_OPENAI_RESPONSES
                    else UPSTREAM_ANTHROPIC_MESSAGES
                ),
                'route_id': None,
                'credential_id': getattr(cred, 'id', None),
                'credential': cred,
                'provider': adapter.code,
                'adapter': adapter,
                'proxy_url': proxy_url,
                'timeout': min(300, max(5, int(getattr(cred, 'request_timeout_seconds', 120) or 120))),
            })
            if len(resolved) >= max_attempts:
                break
        if not resolved:
            detail = unavailable[0] if unavailable else '未配置支持网页搜索的模型账号，无法使用网页搜索'
            raise AgentGatewayError(detail, 503)
        return resolved

    @staticmethod
    def _body_has_image(body):
        """OpenAI 兼容协议下检测请求是否携带图片（user 消息 content 数组 image_url / data:image）。"""
        items = list(body.get('messages') or [])
        incoming = body.get('input')
        if isinstance(incoming, list):
            items.extend(incoming)
        elif isinstance(incoming, str) and 'data:image/' in incoming:
            return True
        for msg in items:
            if not isinstance(msg, dict):
                continue
            if msg.get('type') in ('input_image', 'image', 'image_url'):
                return True
            content = msg.get('content')
            if isinstance(content, str):
                if 'data:image/' in content:
                    return True
                continue
            if not isinstance(content, list):
                continue
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get('type') in ('image', 'image_url', 'input_image'):
                    return True
                source = part.get('source')
                if isinstance(source, dict) and source.get('type') in ('base64', 'url'):
                    return True
                image_url = part.get('image_url')
                if isinstance(image_url, dict) and isinstance(image_url.get('url'), str) \
                        and image_url['url'].startswith('data:image/'):
                    return True
        return False

    def _auto_target(self, body):
        """按自动路由配置解析 coati-auto 的实际目标模型（含图→vision_model，纯文本→upstream_model）。"""
        route = self.route_crud.get_enabled_by_model(AUTO_ROUTE_MODEL)
        if not route:
            raise AgentGatewayError(
                '自动路由（coati-auto）未配置：请在「模型网关 → 模型路由」新增该模型的路由', 503,
            )
        if self._body_has_image(body):
            target = route.vision_model
            if not target:
                raise AgentGatewayError('自动路由未配置「含图时模型」，无法处理带图请求', 503)
            return target
        target = route.upstream_model
        if not target:
            raise AgentGatewayError('自动路由未配置「实际模型」作为纯文本目标', 503)
        return target

    @staticmethod
    def _positive_int(value, fallback):
        try:
            value = int(value)
        except (TypeError, ValueError):
            return fallback
        return value if value > 0 else fallback

    def _default_context_window(self):
        """未声明模型能力时的安全窗口，可通过部署配置调整。"""
        return self._positive_int(
            current_app.config.get('AGENT_DEFAULT_CONTEXT_WINDOW'),
            DEFAULT_CONTEXT_WINDOW,
        )

    def _configured_model_profiles(self):
        """读取精确模型/路由 profile，不把能力归因给 Provider。

        配置允许直接使用对象，也允许从环境变量传入 JSON。兼容两种字段名，
        方便后续把同一结构迁移到管理端或数据库，而不改变 dsh bootstrap 契约。
        """
        raw = current_app.config.get('AGENT_MODEL_PROFILES')
        if raw in (None, ''):
            raw = current_app.config.get('AGENT_MODEL_PROFILES_JSON') or '{}'
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except (TypeError, ValueError):
                raw = {}
        if not isinstance(raw, dict):
            return {}

        profiles = {}
        for key, value in raw.items():
            name = str(key or '').strip()
            if not name:
                continue
            if isinstance(value, (int, float, str)):
                value = {'context_window': value}
            if not isinstance(value, dict):
                continue
            window = self._positive_int(
                value.get('context_window', value.get('contextWindow')),
                0,
            )
            output = self._positive_int(
                value.get('max_output_tokens', value.get('maxTokens')),
                DEFAULT_MAX_OUTPUT_TOKENS,
            )
            if window:
                threshold_ratio = self._positive_ratio(
                    value.get('compaction_threshold_ratio', value.get('thresholdRatio')),
                    DEFAULT_COMPACTION_THRESHOLD_RATIO,
                )
                retain_ratio = self._positive_ratio(
                    value.get('compaction_retain_ratio', value.get('retainRatio')),
                    DEFAULT_COMPACTION_RETAIN_RATIO,
                )
                if retain_ratio >= threshold_ratio:
                    threshold_ratio = DEFAULT_COMPACTION_THRESHOLD_RATIO
                    retain_ratio = DEFAULT_COMPACTION_RETAIN_RATIO
                profiles[name] = {
                    'context_window': window,
                    'max_output_tokens': output,
                    'compaction_threshold_ratio': threshold_ratio,
                    'compaction_retain_ratio': retain_ratio,
                }
        return profiles

    @staticmethod
    def _positive_ratio(value, fallback):
        try:
            number = float(value)
        except (TypeError, ValueError):
            return fallback
        return number if 0 < number < 1 else fallback

    @staticmethod
    def _context_profile(
        window, *, source, max_output_tokens=DEFAULT_MAX_OUTPUT_TOKENS,
        threshold_ratio=DEFAULT_COMPACTION_THRESHOLD_RATIO,
        retain_ratio=DEFAULT_COMPACTION_RETAIN_RATIO,
        upstream_models=None,
    ):
        return {
            'context_window': max(1, int(window)),
            'context_window_source': source,
            'max_output_tokens': max(1, int(max_output_tokens)),
            'compaction_threshold_ratio': threshold_ratio,
            'compaction_retain_ratio': retain_ratio,
            'upstream_models': sorted({str(item) for item in (upstream_models or []) if item}),
        }

    def _model_profile(self, model_name, user=None):
        """按精确模型 profile 生成 dsh 能力描述。

        dsh 必须在发出首个请求前决定是否压缩，而 Portal 的账号选择发生在
        请求进入网关之后。能力档案属于模型本身，由平台统一表维护；不能
        因为同一个模型被多把账号支持，就在账号之间取不同配置或重复维护。
        """
        model_name = (model_name or '').strip()
        route = self.route_crud.get_enabled_by_model(model_name) if model_name else None
        env_profiles = self._configured_model_profiles()
        targets = [model_name]
        if route:
            targets = [
                str(value).strip() for value in (
                    getattr(route, 'upstream_model', None),
                    getattr(route, 'vision_model', None),
                ) if str(value or '').strip()
            ] or [model_name]

        # The database profile is the source of truth. Environment profiles are
        # retained only as a deployment compatibility fallback during rollout.
        database_profiles = {}
        for target in set(targets + [model_name]):
            if not target:
                continue
            row = self.model_profile_crud.get_enabled_by_model(target)
            if row:
                database_profiles[target] = {
                    'context_window': row.context_window,
                    'max_output_tokens': row.max_output_tokens,
                    'compaction_threshold_ratio': DEFAULT_COMPACTION_THRESHOLD_RATIO,
                    'compaction_retain_ratio': DEFAULT_COMPACTION_RETAIN_RATIO,
                }

        # A logical route profile is an explicit operator assertion and takes
        # precedence over its target models. It is still one row in the same
        # unified table, never an account-level setting.
        if route and model_name in database_profiles:
            direct = database_profiles[model_name]
            window = direct['context_window']
            output = direct['max_output_tokens']
            threshold_ratio = direct['compaction_threshold_ratio']
            retain_ratio = direct['compaction_retain_ratio']
            source = 'unified-model-profile'
        else:
            threshold_ratio = DEFAULT_COMPACTION_THRESHOLD_RATIO
            retain_ratio = DEFAULT_COMPACTION_RETAIN_RATIO
            missing_targets = [target for target in targets if target not in database_profiles]
            if not missing_targets and targets:
                target_profiles = [database_profiles[target] for target in targets]
                window = min(item['context_window'] for item in target_profiles)
                output = min(item['max_output_tokens'] for item in target_profiles)
                threshold_ratio = min(item['compaction_threshold_ratio'] for item in target_profiles)
                retain_ratio = min(item['compaction_retain_ratio'] for item in target_profiles)
                source = 'minimum-unified-model-profile' if len(target_profiles) > 1 else 'unified-model-profile'
            else:
                # Legacy deployment fallback. New configuration should be made
                # in the admin unified table, so this path can be removed after
                # all environments have migrated.
                target_profiles = [env_profiles[target] for target in targets if target in env_profiles]
                missing_targets = [target for target in targets if target not in env_profiles]
                if target_profiles and not missing_targets:
                    window = min(item['context_window'] for item in target_profiles)
                    output = min(item['max_output_tokens'] for item in target_profiles)
                    threshold_ratio = min(item['compaction_threshold_ratio'] for item in target_profiles)
                    retain_ratio = min(item['compaction_retain_ratio'] for item in target_profiles)
                    source = 'minimum-deployment-model-profile' if len(target_profiles) > 1 else 'deployment-model-profile'
                else:
                    window = self._default_context_window()
                    output = DEFAULT_MAX_OUTPUT_TOKENS
                    source = 'unknown-model-fallback'
        return self._context_profile(
            window,
            source=source,
            max_output_tokens=output,
            threshold_ratio=threshold_ratio,
            retain_ratio=retain_ratio,
            upstream_models=targets,
        )

    def model_profiles(self, user=None, inbound_protocol=None):
        """返回当前用户可见模型的上下文能力，models 字段继续保持字符串列表。"""
        names = self.allowed_models(user, inbound_protocol=inbound_protocol)
        # Only bootstrap/model-list requests reach this method. The catalog is
        # process-cached and never fetched on every chat request.
        try:
            self.model_capability_catalog.sync(names)
        except Exception:
            self.model_capability_catalog.reset_transaction()
        return {
            name: self._model_profile(name, user)
            for name in names
            if name
        }

    def _route_accepts_inbound(self, route, inbound_protocol):
        """判断固定路由是否至少有一条当前入口可用的账号。"""
        if not inbound_protocol or not route or not route.credential_id:
            # 未绑定账号的自动路由仍保留在目录中，实际请求时再从账号池解析。
            return True
        bound = self.credential_crud.get(route.credential_id)
        if bound and getattr(bound, 'enabled', True) and upstream_accepts_inbound(
            credential_upstream_protocol(bound), inbound_protocol,
        ):
            target_model = (
                getattr(route, 'upstream_model', None)
                or getattr(route, 'model_name', None)
                or None
            )
            if not target_model or AgentCredentialService._row_matches_model(
                bound, target_model, allow_upstream=True,
            ):
                return True
        if not getattr(route, 'fallback_enabled', False):
            return False
        preferred_model = (
            getattr(route, 'upstream_model', None)
            or getattr(bound, 'default_model', None)
            or None
        )
        try:
            candidates = self.credentials.candidates(
                preferred_model=preferred_model,
                require_model_match=bool(preferred_model),
                limit=1,
                inbound_protocol=inbound_protocol,
            )
        except AgentCredentialError:
            return False
        return bool(candidates)

    def allowed_models(self, user=None, inbound_protocol=None):
        """模型清单（决定 dsh 模型下拉与 bootstrap.models 的顺序）。

        排序策略：
        1. 模型路由（别名，如 coati-auto）置顶，按 model_name 升序；
        2. 当前用户的个人渠道模型；
        3. 其余真实模型按厂商（provider code）分组。
        """
        ordered = []
        seen = set()

        # 1) 路由别名置顶（enabled_items 已按 model_name asc）
        for row in self.route_crud.enabled_items():
            if not self._route_accepts_inbound(row, inbound_protocol):
                continue
            name = row.model_name
            if name and name not in seen:
                seen.add(name)
                ordered.append(name)

        # 2) 个人渠道模型（仅本人）
        user_id = getattr(user, 'id', None)
        if user_id:
            for row in self.credential_crud.enabled_items(scope='personal', owner_user_id=user_id):
                if not row.display_prefix():
                    continue
                if inbound_protocol and not upstream_accepts_inbound(
                    credential_upstream_protocol(row), inbound_protocol,
                ):
                    continue
                try:
                    if not get_provider_adapter(row.provider).available:
                        continue
                except ProviderAdapterError:
                    continue
                for name in row.display_models():
                    if name and name not in seen:
                        seen.add(name)
                        ordered.append(name)

        # 3) 真实模型按厂商分组去重
        by_provider = {}
        for row in self.credential_crud.enabled_items():
            if inbound_protocol and not upstream_accepts_inbound(
                credential_upstream_protocol(row), inbound_protocol,
            ):
                continue
            try:
                if not get_provider_adapter(row.provider).available:
                    continue
            except ProviderAdapterError:
                continue
            provider = str(row.provider or '').strip().lower()
            bucket = by_provider.setdefault(provider, [])
            for name in row.supported_models():
                if name and name not in seen:
                    seen.add(name)
                    bucket.append(name)

        for provider in sorted(by_provider):
            ordered.extend(by_provider[provider])
        return ordered

    def default_model(self, inbound_protocol=None):
        """网关默认模型：第一个可用 credential 声明的 default_model（无则返回 None）。"""
        for row in self.credential_crud.enabled_items():
            if inbound_protocol and not upstream_accepts_inbound(
                credential_upstream_protocol(row), inbound_protocol,
            ):
                continue
            try:
                adapter = get_provider_adapter(row.provider)
                if not adapter.available:
                    continue
            except ProviderAdapterError:
                continue
            return row.default_model or adapter.default_model or None
        return None

    def gateway_status(self):
        """供 bootstrap / 诊断：说明网关为何无可用模型。"""
        now = datetime.utcnow()
        rows = self.credential_crud.enabled_items()
        if not rows:
            return {
                'status': 'no_credentials',
                'message': '未配置模型账号：请在管理后台「模型网关 → 模型账号」添加',
            }
        available = [
            row for row in rows
            if not AgentCredentialService._in_cooldown(row, now)
        ]
        if not available:
            until = AgentCredentialService._earliest_cooldown_until(rows, now)
            message = AgentCredentialService._format_retry_after(
                '匹配的模型账号均处于冷却状态', until, now,
            )
            payload = {'status': 'all_cooldown', 'message': message}
            if until:
                payload['retry_after'] = until.isoformat() + 'Z'
            return payload
        if not self.allowed_models():
            return {
                'status': 'no_models',
                'message': '已配置模型账号，但当前无可用模型或 Provider 未就绪',
            }
        return {'status': 'ok'}

    def _record_request(
        self, user_id, request_id, route=None, *, status, http_status=None,
        latency_ms=None, prompt_tokens=0, completion_tokens=0,
        attempt_count=0, fallback_used=False, error_summary=None,
        requested_model=None, cache_read_tokens=None, cache_write_tokens=None,
        cache_miss_tokens=None,
    ):
        trace = getattr(self, '_trace_metadata', {})
        context = getattr(self, '_context_metadata', {})
        attempt_summary = self._attempt_trace_summary()
        combined_error = '；'.join(
            item for item in (error_summary, attempt_summary) if item
        )
        self.usage.record(
            user_id,
            request_id=request_id,
            parent_request_id=getattr(self, '_parent_request_id', None),
            **trace,
            model=(route or {}).get('requested') or requested_model,
            upstream_model=(route or {}).get('model'),
            inbound_protocol=getattr(self, '_inbound_protocol', None),
            upstream_protocol=(route or {}).get('upstream_protocol'),
            route_id=(route or {}).get('route_id'),
            credential_id=(route or {}).get('credential_id'),
            pat_id=getattr(getattr(g, 'agent_pat', None), 'id', None),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            **context,
            cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens,
            cache_miss_tokens=cache_miss_tokens,
            latency_ms=latency_ms,
            status=status,
            http_status=http_status,
            error_summary=combined_error[:500] or None,
            attempt_count=attempt_count,
            fallback_used=fallback_used,
        )

    @staticmethod
    def _new_attempt(route):
        credential = (route or {}).get('credential')
        credential_id = (route or {}).get('credential_id')
        return {
            'credential_id': credential_id,
            'credential_name': getattr(credential, 'name', None) or (
                f'账号 #{credential_id}' if credential_id is not None else '环境账号'
            ),
            'status': '请求中',
            'http_status': None,
            'latency_ms': None,
            'error': None,
        }

    @staticmethod
    def _finish_attempt(attempt, status, *, http_status=None, latency_ms=None, error=None):
        if attempt is None:
            return
        attempt.update({
            'status': status,
            'http_status': http_status,
            'latency_ms': latency_ms,
            'error': str(error)[:160] if error else None,
        })

    def _attempt_trace_summary(self):
        """把同一逻辑请求的多账号尝试压缩进已有错误摘要字段。

        只在发生切换或最终失败时写入，普通单账号成功请求不污染日志；个人
        日志由 usage service 脱敏后再返回。
        """
        if not getattr(self, '_attempt_trace_enabled', False):
            return None
        attempts = getattr(self, '_attempt_trace', None) or []
        if not attempts or len(attempts) <= 1:
            return None
        parts = []
        for index, item in enumerate(attempts, start=1):
            name = item.get('credential_name') or (
                f"账号 #{item.get('credential_id')}"
                if item.get('credential_id') is not None else '环境账号'
            )
            status = item.get('status') or '未知'
            detail = status
            if item.get('http_status') is not None:
                detail += f" HTTP {item['http_status']}"
            if item.get('latency_ms') is not None:
                detail += f" {item['latency_ms']}ms"
            if item.get('error'):
                detail += f" {item['error']}"
            parts.append(f'{index}. {name}（{detail}）')
        return INTERNAL_ATTEMPT_TRACE_PREFIX + ' → '.join(parts)

    @staticmethod
    def _attach_request_id(error, request_id):
        error.payload = {**error.payload, 'request_id': request_id}
        return error

    @staticmethod
    def _echo_client_model(payload, client_model):
        if not client_model or not isinstance(payload, dict):
            return payload
        if payload.get('model'):
            payload['model'] = client_model
        message = payload.get('message')
        if isinstance(message, dict) and message.get('model'):
            message['model'] = client_model
        nested = payload.get('response')
        if isinstance(nested, dict) and nested.get('model'):
            nested['model'] = client_model
        return payload

    @classmethod
    def _rewrite_sse_client_model(cls, line, client_model):
        if not client_model or not line.startswith('data: '):
            return line
        data = line[6:].strip()
        if data in ('', '[DONE]'):
            return line
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            return line
        rewritten = cls._echo_client_model(obj, client_model)
        return 'data: ' + json.dumps(rewritten, ensure_ascii=False)

    @staticmethod
    def _translate_stream_line(line, bridge):
        if not bridge:
            return b''
        feed_line = getattr(bridge, 'feed_line', None)
        if callable(feed_line):
            return feed_line(line)
        if not line or not line.startswith('data: '):
            return b''
        data = line[6:].strip()
        if data in ('', '[DONE]'):
            result = bridge.finish() if data == '[DONE]' else b''
            return result if isinstance(result, bytes) else b''.join(result or [])
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            return b''
        result = bridge.feed(obj)
        return result if isinstance(result, bytes) else b''.join(result or [])

    # 保留旧的私有方法名，避免外部调试脚本引用时突然失效。
    _translate_openai_sse_line = _translate_stream_line

    def _resolve_client_model(self, requested, user=None, inbound_protocol=None):
        """外部客户端常带自家模型名；未配置的名称回落到门户默认模型。"""
        name = (requested or '').strip()
        route = self.route_crud.get_enabled_by_model(name) if name else None
        if name and route:
            # 已配置的路由即使当前不可用，也要保留原模型名交给 resolve_routes
            # 返回明确的路由/账号错误；不能静默改成默认模型，避免把配置问题伪装
            # 成“模型不存在”或误发到另一条路由。
            return name
        if name and name in set(self.allowed_models(user, inbound_protocol=inbound_protocol)):
            return name
        return self.default_model(inbound_protocol=inbound_protocol) or name or None

    def chat_completions(self, user, body, request_headers=None):
        return self._proxy_llm(user, body, protocol='openai', request_headers=request_headers)

    def anthropic_messages(self, user, body, request_headers=None):
        body = dict(body or {})
        # normalize_server_tool_history 会把上一轮的 server_tool_use/result 降成文本，
        # 但用量观测仍应保留真实结果大小；把归一化前的字节数作为内部偏移传下去。
        historical_tool_result_bytes = _tool_result_size(body.get('messages') or [])
        client_model = (body.get('model') or '').strip() or None
        body['model'] = self._resolve_client_model(
            client_model, user, inbound_protocol='anthropic',
        )
        tool_configs, rejected_tools, body = extract_server_tools(body)
        # 历史里的 server tool 块无论本轮是否再声明工具都要归一化：上一轮的结果
        # 块会被客户端原样带回来，上游不认识这些 type。
        body = normalize_server_tool_history(body)
        if tool_configs or rejected_tools:
            return self._anthropic_messages_with_server_tools(
                user, body, tool_configs, rejected_tools,
                request_headers=request_headers,
                client_model=client_model or body.get('model'),
                historical_tool_result_bytes=historical_tool_result_bytes,
            )
        return self._proxy_llm(
            user, body, protocol='anthropic', request_headers=request_headers,
            client_model=client_model or body.get('model'),
            historical_tool_result_bytes=historical_tool_result_bytes,
        )

    # ─── web_search server tool：服务端内部循环 ────────────────────────────────

    # 搜索复用同一个 service 实例：web_search() 会重置 _trace_metadata /
    # _attempt_trace 等按请求作用域的字段，而 _proxy_llm 每次进入时也会重新初始化
    # 它们，闭环里两者交替调用，不会互相读到对方的残留。

    @staticmethod
    def _executes_native_server_tools(route):
        """这把账号能不能原生执行 Responses 的内置工具。

        协议得是 openai-responses（其它协议根本没有这些工具），且已被观测确认
        会执行——判据与对话链路那套完全一致，不另起一套。
        """
        if (route or {}).get('upstream_protocol') != UPSTREAM_OPENAI_RESPONSES:
            return False
        return WEB_SEARCH_SUPPORT.executes(route.get('credential_id')) is True

    @staticmethod
    def _search_error_code(status_code):
        if status_code == 429:
            return 'too_many_requests'
        if status_code == 400:
            return 'invalid_tool_input'
        return 'unavailable'

    def _run_server_web_search(
        self, user, query, config, *, parent_request_id=None, trace_metadata=None,
    ):
        """执行一次搜索。

        失败不抛错——server tool 的错误是内容块，不是 HTTP 错误。返回
        (sources, error_code, detail)：错误块只能带官方 error_code，具体原因
        （例如“未配置支持网页搜索的模型账号”）随文本一并进模型上下文，
        否则运维层面完全看不出为什么搜不出来。
        """
        if len(query) > MAX_QUERY_LENGTH:
            return [], 'query_too_long', None
        try:
            payload, status, request_id = self.web_search(
                user, localized_query(query, config.get('user_location')),
                SEARCH_RESULT_LIMIT,
                parent_request_id=parent_request_id,
                trace_metadata=trace_metadata,
            )
            self._last_server_tool_request_id = request_id
        except AgentUsageError as exc:
            self._last_server_tool_request_id = (exc.payload or {}).get('request_id')
            return [], 'too_many_requests', getattr(exc, 'message', None)
        except (AgentGatewayError, AgentCredentialError) as exc:
            self._last_server_tool_request_id = (
                getattr(exc, 'payload', None) or {}
            ).get('request_id')
            return [], self._search_error_code(getattr(exc, 'status_code', 502)), \
                getattr(exc, 'message', None)
        if status != 200:
            return [], 'unavailable', None
        return filter_sources((payload or {}).get('sources') or [], config), None, None

    @staticmethod
    def _merge_anthropic_usage(total, usage):
        if not isinstance(usage, dict):
            return total
        merged = dict(total)
        for key in (
            'input_tokens', 'output_tokens',
            'cache_read_input_tokens', 'cache_creation_input_tokens',
        ):
            if usage.get(key) is not None:
                merged[key] = int(merged.get(key) or 0) + int(usage.get(key) or 0)
        return merged

    def _anthropic_messages_with_server_tools(
        self, user, body, configs, rejected=(), *, request_headers=None, client_model=None,
        historical_tool_result_bytes=0,
    ):
        """把服务端工具做成闭环：上游要用就自己执行完再继续问，直到收尾。

        客户端全程看不到任何待执行的服务端工具，所以 stop_reason 不能是 tool_use
        （除非模型同时调用了真正的客户端工具）。
        """
        wants_stream = bool(body.get('stream'))
        # shortcut 可能在第一次 _proxy_llm 之前就执行搜索；先固定入站协议，
        # 否则这条纯搜索记录的 inbound_protocol 会变成 NULL。
        self._inbound_protocol = 'anthropic'
        trace_metadata = request_trace_metadata(request_headers, body)
        self._last_server_tool_request_id = None

        shortcut = self._web_search_shortcut(
            user, body, configs, wants_stream, trace_metadata=trace_metadata,
        )
        if shortcut is not None:
            return shortcut

        inner = dict(body)
        inner.pop('stream', None)
        messages = list(inner.get('messages') or [])

        budget = min(
            (cfg.get('max_uses') if cfg.get('max_uses') is not None else DEFAULT_MAX_USES)
            for cfg in configs.values()
        ) if configs else DEFAULT_MAX_USES
        # 每轮最多消耗一次预算，外加一轮收尾；上限兜底防止模型来回打转。
        max_rounds = min(10, max(2, budget + 2))

        tool_uses = {WEB_SEARCH_TOOL_NAME: 0, WEB_FETCH_TOOL_NAME: 0}
        server_blocks = []
        usage_total = {}
        first_request_id = None
        payload = {}
        pending_client_calls = False
        native_stop_reason = None

        for round_index in range(max_rounds):
            inner['messages'] = messages
            # 最后一轮必须给出答案：不再提供搜索工具，避免只剩一堆搜索结果没有结论。
            offer = round_index < max_rounds - 1
            # 原生探测最多重来一次：上游拒绝或吐出畸形回包时，换成普通工具再打
            # 一遍。这一轮不能因为「恰好路由到一把不支持的账号」就交付降级结果——
            # 网关对外的契约不该随选中哪把账号而变。
            for probe in range(2):
                payload, status, request_id = self._proxy_llm(
                    user, dict(inner), protocol='anthropic',
                    request_headers=request_headers, client_model=client_model,
                    server_tool_configs=configs, rejected_server_tools=rejected,
                    offer_server_tools=offer,
                    parent_request_id=first_request_id,
                    historical_tool_result_bytes=historical_tool_result_bytes,
                )
                went_native = bool(getattr(self, '_web_search_native', False))
                credential_id = getattr(self, '_web_search_credential_id', None)
                if first_request_id is None:
                    first_request_id = request_id
                if status != 200:
                    if probe == 0 and went_native and 400 <= status < 500:
                        # 上游连这个工具类型都不认，直接拒了请求。
                        WEB_SEARCH_SUPPORT.record(credential_id, False)
                        continue
                    break

                blocks = [
                    block for block in ((payload or {}).get('content') or [])
                    if isinstance(block, dict)
                ]
                search_calls = [block for block in blocks if is_server_tool_call(block)]
                native_blocks = [
                    block for block in blocks
                    if block.get('type') == 'server_tool_use'
                    and block.get('name') in (WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME)
                ]
                if not went_native:
                    break
                # 发的是原生声明，回包决定了这个端点到底执不执行。
                if native_blocks:
                    WEB_SEARCH_SUPPORT.record(credential_id, True)
                    break
                if search_calls:
                    # 退化成了普通工具调用：没执行，但形状还是好的，直接进闭环。
                    WEB_SEARCH_SUPPORT.record(credential_id, False)
                    went_native = False
                    break
                if probe == 0 and has_leaked_tool_call_text(blocks):
                    # 第三种形状：把工具调用吐成了正文。这种回包对客户端毫无价值，
                    # 而且会把 <tool_call> 标记暴露出去，必须换普通工具重来。
                    WEB_SEARCH_SUPPORT.record(credential_id, False)
                    continue
                break
            if status != 200:
                return payload, status, request_id
            usage_total = self._merge_anthropic_usage(usage_total, (payload or {}).get('usage'))
            if went_native:
                # 上游自己把搜索跑完了：结果块、citations、encrypted_content 都是
                # 它签发的真货，网关不能再插手，原样交给客户端就是最好的结果。
                native_usage = ((payload or {}).get('usage') or {}).get('server_tool_use')
                if isinstance(native_usage, dict):
                    tool_uses[WEB_SEARCH_TOOL_NAME] += int(
                        native_usage.get('web_search_requests') or 0)
                    tool_uses[WEB_FETCH_TOOL_NAME] += int(
                        native_usage.get('web_fetch_requests') or 0)
                else:
                    for block in native_blocks:
                        tool_uses[block.get('name')] = tool_uses.get(block.get('name'), 0) + 1
                pending_client_calls = any(
                    block.get('type') == 'tool_use' and not is_server_tool_call(block)
                    for block in blocks
                )
                native_stop_reason = (payload or {}).get('stop_reason')
                break
            client_calls = [
                block for block in blocks
                if block.get('type') == 'tool_use' and not is_server_tool_call(block)
            ]
            if not search_calls:
                pending_client_calls = bool(client_calls)
                break

            new_blocks, tool_results, tool_uses = self._consume_server_tool_calls(
                user, search_calls, configs, tool_uses, budget,
                parent_request_id=request_id,
                trace_metadata=getattr(self, '_trace_metadata', trace_metadata),
            )
            server_blocks.extend(new_blocks)

            if client_calls:
                # 官方在「服务端工具与客户端工具同轮并发」时返回 stop_reason:
                # tool_use，把搜索推到下一轮。网关这里直接把搜索跑完再交回客户端：
                # 客户端工具不会被吞掉，也省掉一次无谓往返。
                pending_client_calls = True
                payload = dict(payload or {})
                payload['content'] = [
                    block for block in blocks if not is_server_tool_call(block)
                ]
                break

            assistant_content = [block for block in blocks if not is_server_tool_call(block)]
            messages = messages + [
                {'role': 'assistant', 'content': assistant_content + search_calls},
                {'role': 'user', 'content': tool_results},
            ]
        else:
            pending_client_calls = False

        final = dict(payload or {})
        content = [
            block for block in (final.get('content') or []) if isinstance(block, dict)
        ]
        if server_blocks:
            # 网关代跑：把成对的 server_tool_use + 结果块排在模型结论之前。
            passthrough = [block for block in content if is_server_web_search_block(block)]
            tail = [
                block for block in content
                if not is_server_tool_call(block) and not is_server_web_search_block(block)
            ]
            final['content'] = server_blocks + passthrough + tail
        else:
            # 上游原生执行：块的先后是它自己排的（文字、搜索、再文字会交替出现），
            # 重排会打乱 citations 与正文的对应关系，只滤掉不该露出的待执行调用。
            final['content'] = [block for block in content if not is_server_tool_call(block)]
        if pending_client_calls:
            stop_reason = 'tool_use'
        elif native_stop_reason == 'pause_turn':
            # 上游把长搜索这一轮挂起了，客户端要原样回传这条消息才能续上，
            # 不能被改写成 end_turn。
            stop_reason = 'pause_turn'
        elif final.get('stop_reason') == 'max_tokens':
            stop_reason = 'max_tokens'
        else:
            # 搜索已经由服务端解决，客户端没有任何工具可执行。
            stop_reason = 'end_turn'
        final['stop_reason'] = stop_reason
        usage = dict(usage_total)
        usage['server_tool_use'] = {
            'web_search_requests': tool_uses.get(WEB_SEARCH_TOOL_NAME, 0),
            'web_fetch_requests': tool_uses.get(WEB_FETCH_TOOL_NAME, 0),
        }
        final['usage'] = usage
        request_id = first_request_id or self.usage.new_request_id()
        if wants_stream:
            return self._stream_static_anthropic_message(final, request_id)
        return final, 200, request_id

    @staticmethod
    def _shortcut_enabled():
        value = current_app.config.get('AGENT_WEB_SEARCH_SHORTCUT_ENABLED', True)
        if isinstance(value, str):
            return value.strip().lower() not in {'0', 'false', 'no', 'off'}
        return bool(value)

    def _web_search_shortcut(
        self, user, body, configs, wants_stream, *, trace_metadata=None,
    ):
        """整个请求只是为了搜一次时，直接搜完返回，不惊动模型。

        Claude Code 的 WebSearch 就是这种形态。让模型参与既不改变查询词也不
        改变结果，却要付两轮以上的上游 token。

        只在成功时短路：搜索失败仍然退回正常闭环，让模型至少能说明情况——
        省钱不能以功能变差为代价。
        """
        if not self._shortcut_enabled():
            return None
        query = search_only_query(body, configs)
        if not query:
            return None
        config = configs[WEB_SEARCH_TOOL_NAME]
        sources, error_code, _detail = self._run_server_web_search(
            user, query, config, trace_metadata=trace_metadata,
        )
        if error_code or not sources:
            return None

        block_id = f'srvtoolu_{uuid4().hex[:16]}'
        payload = {
            'id': f'msg_{uuid4().hex[:24]}',
            'type': 'message',
            'role': 'assistant',
            'model': (body.get('model') or ''),
            'content': [
                server_tool_use_block(block_id, query),
                web_search_tool_result_block(block_id, sources),
                {'type': 'text', 'text': render_search_results(query, sources)},
            ],
            'stop_reason': 'end_turn',
            'usage': {
                # 没有打过对话上游，这里是网关自己的估算，不是模型报的用量。
                'input_tokens': self.usage.estimate_tokens(body.get('messages')),
                'output_tokens': self.usage.estimate_tokens(sources),
                'server_tool_use': {'web_search_requests': 1, 'web_fetch_requests': 0},
            },
        }
        # shortcut 没有模型轮次，搜索本身就是这次逻辑请求的根记录；不要再
        # 生成一个数据库里不存在的响应 ID。
        request_id = getattr(self, '_last_server_tool_request_id', None)
        request_id = request_id or self.usage.new_request_id()
        if wants_stream:
            return self._stream_static_anthropic_message(payload, request_id)
        return payload, 200, request_id

    def _consume_server_tool_calls(
        self, user, calls, configs, tool_uses, budget, *,
        parent_request_id=None, trace_metadata=None,
    ):
        """执行上游发出的服务端工具调用，产出下游内容块与回喂上游的 tool_result。

        tool_uses 按工具名分别计数：官方 ServerToolUsage 有 web_search_requests
        与 web_fetch_requests 两个独立计数器，不能混在一起。
        """
        tool_uses = dict(tool_uses)
        server_blocks = []
        tool_results = []
        for call in calls:
            # 面向上游的 tool_result 必须用上游原本的 id，面向客户端的块则要归一
            # 成 Anthropic 强制的 ^srvtoolu_[a-zA-Z0-9_]+$。两者不能混用。
            upstream_call_id = str(call.get('id') or '').strip()
            call_id = server_tool_use_id(upstream_call_id)
            if call.get('name') == WEB_FETCH_TOOL_NAME:
                blocks, rendered_text, tool_uses[WEB_FETCH_TOOL_NAME] = self._consume_web_fetch_call(
                    user, call, call_id, configs.get(WEB_FETCH_TOOL_NAME) or {},
                    tool_uses[WEB_FETCH_TOOL_NAME], budget,
                    parent_request_id=parent_request_id,
                    trace_metadata=trace_metadata,
                )
                server_blocks.extend(blocks)
                tool_results.append({
                    'type': 'tool_result', 'tool_use_id': upstream_call_id,
                    'content': [{'type': 'text', 'text': rendered_text}],
                })
                continue
            config = configs.get(WEB_SEARCH_TOOL_NAME) or {}
            searches_done = tool_uses[WEB_SEARCH_TOOL_NAME]
            queries = search_queries_from_input(call.get('input'))
            rendered = []
            if not queries:
                server_blocks.append(server_tool_use_block(call_id, ''))
                server_blocks.append(web_search_error_block(call_id, 'invalid_tool_input'))
                rendered.append(render_search_error('', 'invalid_tool_input'))
            for offset, query in enumerate(queries):
                # 一次 tool_use 可能带多个查询词（实测 qwen 会这么发）；每个查询
                # 各占一次预算，也各自成对产出 server_tool_use + 结果块。
                block_id = call_id if offset == 0 else f'{call_id}_{offset}'
                if searches_done >= budget:
                    server_blocks.append(server_tool_use_block(block_id, query))
                    server_blocks.append(web_search_error_block(block_id, 'max_uses_exceeded'))
                    rendered.append(render_search_error(query, 'max_uses_exceeded'))
                    continue
                searches_done += 1
                sources, error_code, detail = self._run_server_web_search(
                    user, query, config,
                    parent_request_id=parent_request_id,
                    trace_metadata=trace_metadata,
                )
                server_blocks.append(server_tool_use_block(block_id, query))
                if error_code:
                    server_blocks.append(web_search_error_block(block_id, error_code))
                    rendered.append(render_search_error(query, error_code, detail))
                else:
                    server_blocks.append(web_search_tool_result_block(block_id, sources))
                    rendered.append(render_search_results(query, sources))
            tool_uses[WEB_SEARCH_TOOL_NAME] = searches_done
            tool_results.append({
                'type': 'tool_result',
                'tool_use_id': upstream_call_id,
                'content': [{'type': 'text', 'text': '\n\n'.join(rendered)}],
            })
        return server_blocks, tool_results, tool_uses

    def _consume_web_fetch_call(
        self, user, call, call_id, config, used, budget, *,
        parent_request_id=None, trace_metadata=None,
    ):
        """抓取由能执行服务端工具的账号代劳，网关自身不对任意 URL 发请求。"""
        url = fetch_url_from_input(call.get('input'))
        if not url:
            return (
                [fetch_tool_use_block(call_id, ''),
                 web_fetch_error_block(call_id, 'invalid_tool_input')],
                render_fetch_error('', 'invalid_tool_input'), used,
            )
        blocks = [fetch_tool_use_block(call_id, url)]
        if used >= budget:
            blocks.append(web_fetch_error_block(call_id, 'max_uses_exceeded'))
            return blocks, render_fetch_error(url, 'max_uses_exceeded'), used
        if len(url) > MAX_URL_LENGTH:
            blocks.append(web_fetch_error_block(call_id, 'url_too_long'))
            return blocks, render_fetch_error(url, 'url_too_long'), used
        if not filter_sources([{'url': url}], config):
            # 客户端设了域名白/黑名单，这个 URL 不在允许范围内。
            blocks.append(web_fetch_error_block(call_id, 'url_not_allowed'))
            return blocks, render_fetch_error(url, 'url_not_allowed'), used
        used += 1
        fetched, error_code, detail = self._run_server_web_fetch(
            user, url, config,
            parent_request_id=parent_request_id,
            trace_metadata=trace_metadata,
        )
        if error_code:
            blocks.append(web_fetch_error_block(call_id, error_code))
            return blocks, render_fetch_error(url, error_code, detail), used
        blocks.append(web_fetch_result_block(
            call_id, fetched, citations=config.get('citations'),
        ))
        return blocks, render_fetch_result(url, fetched), used

    def _run_server_web_fetch(
        self, user, url, config, *, parent_request_id=None, trace_metadata=None,
    ):
        """执行一次抓取。失败不抛错——server tool 的错误是内容块，不是 HTTP 错误。"""
        try:
            payload, status, request_id = self.web_fetch(
                user, url, max_content_tokens=config.get('max_content_tokens'),
                parent_request_id=parent_request_id,
                trace_metadata=trace_metadata,
            )
            self._last_server_tool_request_id = request_id
        except AgentUsageError as exc:
            self._last_server_tool_request_id = (exc.payload or {}).get('request_id')
            return None, 'too_many_requests', getattr(exc, 'message', None)
        except (AgentGatewayError, AgentCredentialError) as exc:
            self._last_server_tool_request_id = (
                getattr(exc, 'payload', None) or {}
            ).get('request_id')
            code = self._search_error_code(getattr(exc, 'status_code', 502))
            if code == 'invalid_tool_input':
                code = 'url_not_accessible'
            return None, code, getattr(exc, 'message', None)
        if status != 200:
            return None, 'unavailable', None
        return payload, None, None

    def _stream_static_anthropic_message(self, payload, request_id):
        """把拼好的响应铺成 SSE：服务端要先搜完才知道内容，无法边搜边流。"""
        response = Response(
            anthropic_message_to_sse(payload),
            status=200,
            mimetype='text/event-stream',
        )
        response.headers['X-Agent-Request-Id'] = request_id
        return response

    def count_tokens(self, user, body):
        """POST /v1/messages/count_tokens —— 客户端据此判断何时压缩上下文。

        返回的是网关自己的估算，不是上游分词器的精确值。这样做的取舍：估算
        零延迟、零成本、永远可用；而转发给上游需要它也实现了这个端点（不确定），
        且客户端调用频繁，每次多一轮往返不划算。缺一个端点（此前是 404）会让
        客户端退回它自己的本地估算，那比网关的估算更粗。

        服务端工具声明会先摘掉再计数：它们不会原样发给上游，计进去会偏高。
        """
        body = dict(body or {})
        _configs, _rejected, body = extract_server_tools(body)
        body = normalize_server_tool_history(body)
        estimate = {'messages': body.get('messages')}
        if body.get('tools'):
            # 摘空之后不要留下 tools: []，否则跟「本就没声明工具」算出的值不一致。
            estimate['tools'] = body['tools']
        for key in ('system', 'tool_choice'):
            if body.get(key) is not None:
                estimate[key] = body[key]
        return {'input_tokens': self.usage.estimate_tokens(estimate)}, 200, self.usage.new_request_id()

    def openai_responses(self, user, body, request_headers=None):
        body = dict(body or {})
        client_model = (body.get('model') or '').strip() or None
        body['model'] = self._resolve_client_model(
            client_model, user, inbound_protocol='responses',
        )
        if str(body.get('previous_response_id') or '').strip():
            # 网关不持久化 Responses（GET /v1/responses/<id> 同样返回 404）。而且它
            # 跨多个账号调度：A 账号签发的 id 在 B 账号上根本不存在。静默丢弃会让
            # 客户端以为续上了对话，实际上下文全没了——比报错糟得多。
            raise self._attach_request_id(AgentGatewayError(
                '网关不持久化 Responses，previous_response_id 无法续接；'
                '请在 input 中回传完整历史', 400,
            ), self.usage.new_request_id())
        # Codex 这类客户端会声明 Responses 的内置工具（web_search 等）。它们跨协议
        # 转换不了，只有原生 Responses 上游执行得了，所以选路要优先照顾。
        builtin_tools = responses_builtin_tool_types(body)
        return self._proxy_llm(
            user, body, protocol='responses',
            request_headers=request_headers,
            client_model=client_model or body.get('model'),
            needs_native_server_tools=bool(builtin_tools),
        )

    def _proxy_llm(
        self, user, body, *, protocol='openai', request_headers=None, client_model=None,
        server_tool_configs=None, rejected_server_tools=(), offer_server_tools=True,
        needs_native_server_tools=False, parent_request_id=None,
        historical_tool_result_bytes=0,
    ):
        request_id = self.usage.new_request_id()
        body = dict(body or {})
        self._parent_request_id = parent_request_id
        self._trace_metadata = request_trace_metadata(request_headers, body)
        self._context_metadata = context_metadata(
            body, self.usage, tool_result_bytes_offset=historical_tool_result_bytes,
        )
        self._inbound_protocol = protocol
        # 本次是否按原生形状发出，以及发给了哪把账号；闭环据此判断上游到底
        # 执行了没有，并把观测结果记进 WEB_SEARCH_SUPPORT。
        self._web_search_native = False
        self._web_search_credential_id = None
        self._quota_truncated_to = None
        self._attempt_trace = []
        self._attempt_trace_enabled = False
        requested_model = (body.get('model') or '').strip() or None
        original_model = requested_model

        # 自动路由：仍走 coati-auto 这一条路由（绑定/回退），只覆盖发给上游的模型名。
        display_model = None
        lookup_model = requested_model
        upstream_override = None
        if requested_model == AUTO_ROUTE_MODEL:
            display_model = requested_model
            try:
                upstream_override = self._auto_target(body)
            except AgentGatewayError as exc:
                self._record_request(
                    user.id, request_id, status='routing_error', http_status=exc.status_code,
                    error_summary=exc.message, requested_model=display_model,
                )
                self._attach_request_id(exc, request_id)
                raise

        with _ROUTE_SELECTION_LOCK:
            try:
                strong_session_id = self._trace_metadata.get('session_id')
                if self._trace_metadata.get('session_source') == 'fingerprint':
                    strong_session_id = None
                routes = self.resolve_routes(
                    lookup_model, display_model=display_model, upstream_override=upstream_override,
                    user=user, session_id=strong_session_id, inbound_protocol=protocol,
                )
            except AgentGatewayError as exc:
                self._record_request(
                    user.id, request_id, status='routing_error', http_status=exc.status_code,
                    error_summary=exc.message, requested_model=display_model or requested_model,
                )
                self._attach_request_id(exc, request_id)
                raise

            personal = bool(routes and routes[0].get('personal'))
            self._attempt_trace_enabled = not personal
            if not personal:
                try:
                    reservation = self.usage.reserve_quota(
                        user.id, request_id, body, requested_model,
                        pat_id=getattr(getattr(g, 'agent_pat', None), 'id', None),
                        parent_request_id=parent_request_id,
                    )
                    routes = self._canonicalize_session_routes(
                        routes,
                        lookup_model=lookup_model,
                        display_model=display_model,
                        upstream_override=upstream_override,
                        user=user,
                        session_id=strong_session_id,
                        inbound_protocol=protocol,
                    )
                    if routes:
                        self._bind_request_credential(request_id, routes[0])
                    if reservation.get('completion_limit') is not None:
                        if protocol == 'responses' or 'max_output_tokens' in body:
                            limit_field = 'max_output_tokens'
                        elif 'max_completion_tokens' in body:
                            limit_field = 'max_completion_tokens'
                        else:
                            limit_field = 'max_tokens'
                        body[limit_field] = reservation['completion_limit']
                        if reservation.get('completion_truncated'):
                            # 上游可能因此中途截断。客户端看到的是一个残缺回答，
                            # 排查时必须能从用量记录看出这不是模型的问题。
                            self._quota_truncated_to = reservation['completion_limit']
                except AgentUsageError as exc:
                    self._record_request(
                        user.id, request_id, status='quota_exceeded', http_status=429,
                        error_summary=exc.message, requested_model=original_model,
                    )
                    exc.payload = {**exc.payload, 'request_id': request_id}
                    raise

        if needs_native_server_tools:
            # 请求声明了只有原生上游才执行得了的内置工具。把能执行的账号排到前面，
            # 否则同一个请求换把账号就会被协议桥接拒掉——网关对外的契约不该
            # 随选中谁而变。会话亲和让位于「这个请求到底能不能成」。
            routes = sorted(
                routes,
                key=lambda route: 0 if self._executes_native_server_tools(route) else 1,
            )

        stream = bool(body.get('stream'))

        last_error = None
        for index, route in enumerate(routes):
            attempt_count = index + 1
            fallback_used = index > 0
            if index > 0 and route.get('_session_affinity'):
                # 首个账号失败后，故障转移账号也要在发起上游请求前成为新的
                # 会话绑定，避免下一个并发请求继续命中已失效账号。
                self._bind_route_session(route)
            if index > 0 and not personal:
                # reserved 记录也必须跟随实际 fallback 账号更新，否则跨 worker
                # 的活跃负载会继续算在已经失败的首账号上。
                self._bind_request_credential(request_id, route)
            attempt_record = self._new_attempt(route)
            self._attempt_trace.append(attempt_record)
            adapter = route['adapter']
            upstream_protocol = route['upstream_protocol']
            try:
                outbound_body = bridge_request_body(body, protocol, upstream_protocol)
                native_kinds = set()
                if server_tool_configs:
                    # 能自己执行的上游要收到它协议的内置工具声明并原样透传；不能的
                    # 才换成网关代跑的普通工具。这个判断必须在选路之后做，否则会把
                    # 本来能自己执行的上游一并接管过来。
                    native_kinds = native_server_tool_kinds(
                        upstream_protocol, route.get('credential_id'), server_tool_configs,
                    ) if offer_server_tools else set()
                    outbound_body = apply_server_tools(
                        outbound_body, server_tool_configs, upstream_protocol,
                        native_kinds=native_kinds, offer=offer_server_tools,
                    )
                    self._web_search_native = bool(native_kinds)
                    self._web_search_credential_id = route.get('credential_id')
                if rejected_server_tools and not native_kinds:
                    # 网关既不执行也不该静默转发：转发出去只会换来一个谁都不会
                    # 执行的 tool_use，客户端干等——那正是 web_search 当初的坑。
                    raise ProtocolBridgeError(
                        f'网关不支持服务端工具 {rejected_server_tools[0]}，'
                        '请路由到原生支持该工具的账号',
                    )
                if upstream_protocol == UPSTREAM_ANTHROPIC_MESSAGES:
                    req = adapter.build_anthropic_request(
                        base_url=route['base'], api_key=route['key'], model=route['model'],
                        body=outbound_body, request_headers=request_headers,
                    )
                elif upstream_protocol == UPSTREAM_OPENAI_RESPONSES:
                    req = adapter.build_responses_request(
                        base_url=route['base'], api_key=route['key'],
                        model=route['model'], body=outbound_body,
                    )
                elif upstream_protocol == UPSTREAM_OPENAI_CHAT:
                    req = adapter.build_chat_request(
                        base_url=route['base'], api_key=route['key'],
                        model=route['model'], body=outbound_body,
                    )
                else:
                    raise ProviderAdapterError('账号未配置有效的上游接口类型', 422)
            except ProtocolBridgeError as exc:
                message = str(exc)
                self._finish_attempt(
                    attempt_record, '协议转换失败', http_status=400, error=message,
                )
                # 协议能力可能只与当前账号不兼容（例如 Responses 内置工具不能
                # 降级到 Chat）；继续尝试后续原生协议账号，而不是静默丢字段。
                if index < len(routes) - 1:
                    continue
                self._record_request(
                    user.id, request_id, route,
                    status='protocol_error', http_status=400,
                    attempt_count=attempt_count, fallback_used=fallback_used,
                    error_summary=message,
                )
                raise self._attach_request_id(AgentGatewayError(message, 400), request_id) from exc
            except ProviderAdapterError as exc:
                last_error = AgentGatewayError(exc.message, exc.status_code)
                self._finish_attempt(
                    attempt_record, '失败', http_status=last_error.status_code,
                    error=last_error.message,
                )
                self._invalidate_route_session(route)
                if index < len(routes) - 1:
                    continue
                self._record_request(
                    user.id, request_id, route, status='routing_error',
                    http_status=last_error.status_code, attempt_count=attempt_count,
                    fallback_used=fallback_used, error_summary=last_error.message,
                )
                raise self._attach_request_id(last_error, request_id) from exc
            apply_credential_headers(req, route.get('credential'))
            started = time.time()
            observed_at = datetime.utcnow()
            self.credentials.touch(route.get('credential'))
            active_lease = ACTIVE_CREDENTIAL_REQUESTS.acquire(route.get('credential_id'))
            try:
                resp = urlopen_with_transient_retry(
                    req, timeout=route['timeout'], proxy_url=route.get('proxy_url'),
                )
                if stream:
                    stream_lease = active_lease
                    active_lease = None
                    return self._proxy_stream(
                        user, route, resp, started, request_id, body=body,
                        attempt_count=attempt_count, fallback_used=fallback_used,
                        client_model=client_model, upstream_protocol=upstream_protocol,
                        inbound_protocol=protocol,
                        active_lease=stream_lease, attempt_record=attempt_record,
                    )
                try:
                    raw = resp.read().decode('utf-8')
                except UnicodeDecodeError as exc:
                    latency_ms = int((time.time() - started) * 1000)
                    self._finish_attempt(
                        attempt_record, '失败', http_status=502,
                        latency_ms=latency_ms, error='上游返回非 UTF-8 内容',
                    )
                    will_switch = index < len(routes) - 1
                    if will_switch:
                        self.credentials.mark_failure(
                            route.get('credential'), '上游返回非 UTF-8 内容',
                            observed_at=observed_at, soft=True,
                        )
                    else:
                        self.credentials.mark_failure(
                            route.get('credential'), '上游返回非 UTF-8 内容', observed_at=observed_at,
                        )
                    last_error = AgentGatewayError('上游返回非 UTF-8 内容', 502)
                    self._invalidate_route_session(route)
                    if will_switch:
                        continue
                    self._record_request(
                        user.id, request_id, route, status='upstream_error', http_status=502,
                        latency_ms=latency_ms, attempt_count=attempt_count,
                        fallback_used=fallback_used, error_summary=last_error.message,
                    )
                    raise self._attach_request_id(last_error, request_id) from exc
                finally:
                    resp.close()
                latency_ms = int((time.time() - started) * 1000)
                try:
                    parsed = adapter.normalize_response(json.loads(raw))
                except json.JSONDecodeError as exc:
                    self._finish_attempt(
                        attempt_record, '失败', http_status=502,
                        latency_ms=latency_ms, error='上游返回非 JSON',
                    )
                    will_switch = index < len(routes) - 1
                    if will_switch:
                        self.credentials.mark_failure(
                            route.get('credential'), '上游返回非 JSON',
                            observed_at=observed_at, soft=True,
                        )
                    else:
                        self.credentials.mark_failure(
                            route.get('credential'), '上游返回非 JSON', observed_at=observed_at,
                        )
                    last_error = AgentGatewayError('上游返回非 JSON', 502)
                    self._invalidate_route_session(route)
                    if will_switch:
                        continue
                    self._record_request(
                        user.id, request_id, route, status='upstream_error', http_status=502,
                        latency_ms=latency_ms, attempt_count=attempt_count,
                        fallback_used=fallback_used, error_summary=last_error.message,
                    )
                    raise self._attach_request_id(last_error, request_id) from exc
                self._finish_attempt(
                    attempt_record, '响应已解析', http_status=200, latency_ms=latency_ms,
                )
                usage = adapter.usage_from_response(parsed)
                prompt_tokens = int(
                    usage.get('prompt_tokens')
                    or self.usage.estimate_tokens(body.get('messages') or body.get('input'))
                )
                completion_tokens = int(
                    usage.get('completion_tokens')
                    or self.usage.estimate_tokens((parsed or {}).get('choices') or (parsed or {}).get('output'))
                )
                try:
                    parsed = bridge_response_body(
                        parsed, upstream_protocol, protocol, client_model,
                    )
                except ProtocolBridgeError as exc:
                    message = str(exc)
                    truncated_to = getattr(self, '_quota_truncated_to', None)
                    if truncated_to is not None:
                        message = (
                            f'{message}（剩余配额已把输出上限压到 {truncated_to} '
                            'tokens，上游很可能是中途截断而非返回了非法内容）'
                        )
                    will_switch = index < len(routes) - 1
                    self.credentials.mark_failure(
                        route.get('credential'), message,
                        observed_at=observed_at, soft=will_switch,
                    )
                    self._finish_attempt(
                        attempt_record, '协议转换失败', http_status=502,
                        latency_ms=latency_ms, error=message,
                    )
                    self._invalidate_route_session(route)
                    if will_switch:
                        continue
                    self._record_request(
                        user.id, request_id, route,
                        prompt_tokens=prompt_tokens,
                        completion_tokens=completion_tokens,
                        latency_ms=latency_ms,
                        status='upstream_error',
                        http_status=502,
                        attempt_count=attempt_count,
                        fallback_used=fallback_used,
                        cache_read_tokens=usage.get('cache_read_tokens'),
                        cache_write_tokens=usage.get('cache_write_tokens'),
                        cache_miss_tokens=usage.get('cache_miss_tokens'),
                        error_summary=message,
                    )
                    return {
                        'error': {'message': message, 'type': 'protocol_error'},
                    }, 502, request_id
                self.credentials.mark_success(
                    route.get('credential'), latency_ms, observed_at=observed_at,
                )
                self._finish_attempt(
                    attempt_record, '成功', http_status=200, latency_ms=latency_ms,
                )
                self._record_request(
                    user.id, request_id, route,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    latency_ms=latency_ms,
                    status='ok',
                    http_status=200,
                    attempt_count=attempt_count,
                    fallback_used=fallback_used,
                    cache_read_tokens=usage.get('cache_read_tokens'),
                    cache_write_tokens=usage.get('cache_write_tokens'),
                    cache_miss_tokens=usage.get('cache_miss_tokens'),
                )
                return self._echo_client_model(parsed, client_model), 200, request_id
            except AgentUsageError:
                raise
            except urlerror.HTTPError as exc:
                latency_ms = int((time.time() - started) * 1000)
                err_body = exc.read().decode('utf-8', errors='replace')
                retryable, immediate = classify_upstream_http(exc.code, err_body)
                self._finish_attempt(
                    attempt_record, '失败', http_status=exc.code,
                    latency_ms=latency_ms, error=f'上游返回 HTTP {exc.code}',
                )
                will_switch = retryable and index < len(routes) - 1
                if retryable:
                    self._invalidate_route_session(route)
                if retryable and immediate:
                    # 鉴权/欠费不会自愈：无论是否还有候选，立即硬冷却该 Key。
                    self.credentials.mark_failure(
                        route.get('credential'), f'HTTP {exc.code}: {err_body[:300]}',
                        observed_at=observed_at, immediate=True,
                    )
                elif retryable:
                    # 换 Key 可能成功：切换尝试只软记账（短窗降权），最后一次尝试按
                    # 普通失败累计硬阈值。429 是临时限流，即使没有候选可切换也只
                    # 软记账，保留唯一账号给客户端下一次重试。
                    self.credentials.mark_failure(
                        route.get('credential'), f'HTTP {exc.code}: {err_body[:300]}',
                        observed_at=observed_at, soft=(will_switch or exc.code == 429),
                    )
                if will_switch:
                    continue
                self._record_request(
                    user.id, request_id, route, latency_ms=latency_ms,
                    status='upstream_error', http_status=exc.code,
                    attempt_count=attempt_count, fallback_used=fallback_used,
                    error_summary=f'上游返回 HTTP {exc.code}',
                )
                if immediate:
                    # 鉴权与欠费是运维侧的问题，但用户仍然需要知道到底出了什么事——
                    # 只给一个「HTTP 401」等于把真实原因吞掉，他既不知道是 Key 过期
                    # 还是欠费，也没法告诉管理员该查什么。所以取出上游的 message 透出，
                    # 但不把整个原文倒出去：其余字段可能带出中转商身份或账号标识。
                    detail = parse_upstream_error_body(err_body)
                    reason = ''
                    if isinstance(detail, dict):
                        nested = detail.get('error')
                        source = nested if isinstance(nested, dict) else detail
                        reason = redact_secrets(
                            str(source.get('message') or '').strip(), route.get('key'),
                        )
                    return {
                        'error': {
                            'type': 'upstream_error',
                            'message': (
                                f'上游账号不可用（HTTP {exc.code}）：{reason}' if reason
                                else f'上游账号不可用（HTTP {exc.code}），请联系管理员'
                            ),
                            'request_id': request_id,
                        },
                    }, exc.code, request_id
                parsed = parse_upstream_error_body(err_body)
                if parsed is None:
                    parsed = {'error': err_body[:500]}
                else:
                    parsed = adapter.normalize_response(parsed)
                return parsed, exc.code, request_id
            except (urlerror.URLError, TimeoutError, OSError) as exc:
                _, reason_text = classify_connection_error(exc)
                message = f'上游不可达: {reason_text}'
                self._finish_attempt(
                    attempt_record, '失败', http_status=502,
                    latency_ms=int((time.time() - started) * 1000), error=message,
                )
                last_error = AgentGatewayError(message, 502)
                self._invalidate_route_session(route)
                if index < len(routes) - 1:
                    # 瞬时网络故障换 Key 重试：软记账留下观测痕迹，避免主 Key 隐身。
                    self.credentials.mark_failure(
                        route.get('credential'), message, observed_at=observed_at, soft=True,
                    )
                    continue
                self.credentials.mark_failure(
                    route.get('credential'), message, observed_at=observed_at,
                )
            finally:
                if active_lease is not None:
                    active_lease.release()
        route = routes[-1]
        final_error = last_error or AgentGatewayError('没有可用的模型账号', 503)
        self._record_request(
            user.id, request_id, route, status='upstream_error',
            http_status=final_error.status_code, attempt_count=len(routes),
            fallback_used=len(routes) > 1, error_summary=final_error.message,
        )
        raise self._attach_request_id(final_error, request_id)

    def web_search(
        self, user, query, max_results=5, *, request_headers=None,
        parent_request_id=None, trace_metadata=None,
    ):
        request_id = self.usage.new_request_id()
        if not getattr(self, '_inbound_protocol', None):
            # 公开的专用端点不是 Chat/Anthropic/Responses 请求；单独标记它，
            # 让直接调用与 server-tool 子调用在用量里可区分。
            self._inbound_protocol = 'web-search'
        query = str(query or '').strip()
        if not query:
            raise AgentGatewayError('网页搜索需要非空 query', 400, {'request_id': request_id})
        try:
            limit = min(8, max(1, int(max_results if max_results is not None else 5)))
        except (TypeError, ValueError):
            raise AgentGatewayError(
                'max_results 必须是整数', 400, {'request_id': request_id},
            ) from None
        body = {
            # 先用稳定的能力标识做配额预估；真实上游模型在 resolve_search_routes
            # 后由账号配置确定，并由 usage 记录实际 route.model。
            'model': 'web-search',
            'messages': [{'role': 'user', 'content': query}],
            'max_tokens': 4096,
        }
        self._trace_metadata = (
            dict(trace_metadata) if isinstance(trace_metadata, dict)
            else request_trace_metadata(request_headers, body)
        )
        self._parent_request_id = parent_request_id
        self._context_metadata = context_metadata(body, self.usage)
        self._attempt_trace = []
        self._attempt_trace_enabled = True
        try:
            self.usage.reserve_quota(
                user.id, request_id, body, body['model'],
                pat_id=getattr(getattr(g, 'agent_pat', None), 'id', None),
                parent_request_id=parent_request_id,
            )
        except AgentUsageError as exc:
            self._record_request(
                user.id, request_id, status='quota_exceeded', http_status=429,
                error_summary=exc.message, requested_model=body['model'],
            )
            exc.payload = {**exc.payload, 'request_id': request_id}
            raise

        provider_sources = self._provider_search(user, request_id, query, limit)
        if provider_sources is not None:
            return {'query': query, 'sources': provider_sources, 'truncated': False}, 200, request_id

        try:
            routes = self.resolve_search_routes()
        except AgentGatewayError as exc:
            self._record_request(
                user.id, request_id, status='routing_error', http_status=exc.status_code,
                error_summary=exc.message, requested_model=body['model'],
            )
            self._attach_request_id(exc, request_id)
            raise

        if routes:
            self._bind_request_credential(request_id, routes[0])

        last_error = None
        for index, route in enumerate(routes):
            attempt_count = index + 1
            fallback_used = index > 0
            if index > 0:
                self._bind_request_credential(request_id, route)
            attempt_record = self._new_attempt(route)
            self._attempt_trace.append(attempt_record)
            adapter = route['adapter']
            try:
                req = adapter.build_web_search_request(
                    base_url=route['base'], api_key=route['key'],
                    model=route['model'], query=query,
                    protocol=route.get('upstream_protocol'),
                )
            except ProviderAdapterError as exc:
                last_error = AgentGatewayError(exc.message, exc.status_code)
                self._finish_attempt(
                    attempt_record, '失败', http_status=last_error.status_code,
                    error=last_error.message,
                )
                if index < len(routes) - 1:
                    continue
                self._record_request(
                    user.id, request_id, route, status='routing_error',
                    http_status=last_error.status_code, attempt_count=attempt_count,
                    fallback_used=fallback_used, error_summary=last_error.message,
                )
                raise self._attach_request_id(last_error, request_id) from exc
            apply_credential_headers(req, route.get('credential'))
            started = time.time()
            observed_at = datetime.utcnow()
            self.credentials.touch(route.get('credential'))
            active_lease = ACTIVE_CREDENTIAL_REQUESTS.acquire(route.get('credential_id'))
            try:
                resp = urlopen_with_transient_retry(
                    req, timeout=route['timeout'], proxy_url=route.get('proxy_url'),
                )
                try:
                    raw = resp.read().decode('utf-8')
                except UnicodeDecodeError as exc:
                    latency_ms = int((time.time() - started) * 1000)
                    self._finish_attempt(
                        attempt_record, '失败', http_status=502,
                        latency_ms=latency_ms, error='上游返回非 UTF-8 内容',
                    )
                    will_switch = index < len(routes) - 1
                    if will_switch:
                        self.credentials.mark_failure(
                            route.get('credential'), '上游返回非 UTF-8 内容',
                            observed_at=observed_at, soft=True,
                        )
                    else:
                        self.credentials.mark_failure(
                            route.get('credential'), '上游返回非 UTF-8 内容', observed_at=observed_at,
                        )
                    last_error = AgentGatewayError('上游返回非 UTF-8 内容', 502)
                    if will_switch:
                        continue
                    self._record_request(
                        user.id, request_id, route, status='upstream_error', http_status=502,
                        latency_ms=latency_ms, attempt_count=attempt_count,
                        fallback_used=fallback_used, error_summary=last_error.message,
                    )
                    raise self._attach_request_id(last_error, request_id) from exc
                finally:
                    resp.close()
                latency_ms = int((time.time() - started) * 1000)
                try:
                    parsed = json.loads(raw)
                    sources = adapter.parse_web_search_response(
                        parsed, limit, protocol=route.get('upstream_protocol'),
                    )
                except json.JSONDecodeError as exc:
                    self._finish_attempt(
                        attempt_record, '失败', http_status=502,
                        latency_ms=latency_ms, error='上游返回非 JSON',
                    )
                    will_switch = index < len(routes) - 1
                    if will_switch:
                        self.credentials.mark_failure(
                            route.get('credential'), '上游返回非 JSON',
                            observed_at=observed_at, soft=True,
                        )
                    else:
                        self.credentials.mark_failure(
                            route.get('credential'), '上游返回非 JSON', observed_at=observed_at,
                        )
                    last_error = AgentGatewayError('上游返回非 JSON', 502)
                    if will_switch:
                        continue
                    self._record_request(
                        user.id, request_id, route, status='upstream_error', http_status=502,
                        latency_ms=latency_ms, attempt_count=attempt_count,
                        fallback_used=fallback_used, error_summary=last_error.message,
                    )
                    raise self._attach_request_id(last_error, request_id) from exc
                except ProviderAdapterError as exc:
                    # 上游 200 但回包里没有搜索结果，说明这个端点根本不执行服务端
                    # 搜索——这是能力问题不是健康问题，不能扣它的健康分，否则一个
                    # 好端端的对话账号会因为“不会搜”被冷却掉。
                    WEB_SEARCH_SUPPORT.record(route.get('credential_id'), False)
                    self._finish_attempt(
                        attempt_record, '不支持网页搜索', http_status=exc.status_code,
                        latency_ms=latency_ms, error=exc.message,
                    )
                    last_error = AgentGatewayError(exc.message, exc.status_code)
                    if index < len(routes) - 1:
                        continue
                    self._record_request(
                        user.id, request_id, route, status='upstream_error',
                        http_status=last_error.status_code, latency_ms=latency_ms,
                        attempt_count=attempt_count, fallback_used=fallback_used,
                        error_summary=last_error.message,
                    )
                    raise self._attach_request_id(last_error, request_id) from exc
                WEB_SEARCH_SUPPORT.record(route.get('credential_id'), True)
                self.credentials.mark_success(
                    route.get('credential'), latency_ms, observed_at=observed_at,
                )
                self._finish_attempt(
                    attempt_record, '成功', http_status=200, latency_ms=latency_ms,
                )
                usage = adapter.usage_from_web_search_response(parsed)
                prompt_tokens = int(usage.get('prompt_tokens') or self.usage.estimate_tokens(body.get('messages')))
                completion_tokens = int(usage.get('completion_tokens') or 0)
                self._record_request(
                    user.id, request_id, route,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    latency_ms=latency_ms,
                    status='ok',
                    http_status=200,
                    attempt_count=attempt_count,
                    fallback_used=fallback_used,
                    cache_read_tokens=usage.get('cache_read_tokens'),
                    cache_write_tokens=usage.get('cache_write_tokens'),
                    cache_miss_tokens=usage.get('cache_miss_tokens'),
                )
                return {
                    'query': query,
                    'sources': sources,
                    'truncated': False,
                }, 200, request_id
            except AgentUsageError:
                raise
            except AgentGatewayError:
                raise
            except urlerror.HTTPError as exc:
                latency_ms = int((time.time() - started) * 1000)
                err_body = exc.read().decode('utf-8', errors='replace')
                retryable, immediate = classify_upstream_http(exc.code, err_body)
                self._finish_attempt(
                    attempt_record, '失败', http_status=exc.code,
                    latency_ms=latency_ms, error=f'上游返回 HTTP {exc.code}',
                )
                will_switch = retryable and index < len(routes) - 1
                if retryable and immediate:
                    # 鉴权/欠费不会自愈：无论是否还有候选，立即硬冷却该 Key。
                    self.credentials.mark_failure(
                        route.get('credential'), f'HTTP {exc.code}: {err_body[:300]}',
                        observed_at=observed_at, immediate=True,
                    )
                elif retryable:
                    self.credentials.mark_failure(
                        route.get('credential'), f'HTTP {exc.code}: {err_body[:300]}',
                        observed_at=observed_at, soft=(will_switch or exc.code == 429),
                    )
                else:
                    # 不可重试的 4xx＝上游明确拒绝这个请求形状，它给不了服务端搜索。
                    # 记下来，否则每次搜索都会在这把账号上白打一发。429/5xx 是
                    # 暂时性的，不能据此下结论，所以只在这一支记录。
                    WEB_SEARCH_SUPPORT.record(route.get('credential_id'), False)
                if will_switch:
                    continue
                last_error = AgentGatewayError(f'网页搜索上游返回 HTTP {exc.code}', 502)
                self._record_request(
                    user.id, request_id, route, latency_ms=latency_ms,
                    status='upstream_error', http_status=exc.code,
                    attempt_count=attempt_count, fallback_used=fallback_used,
                    error_summary=last_error.message,
                )
                raise self._attach_request_id(last_error, request_id) from exc
            except (urlerror.URLError, TimeoutError, OSError) as exc:
                _, reason_text = classify_connection_error(exc)
                message = f'上游不可达: {reason_text}'
                self._finish_attempt(
                    attempt_record, '失败', http_status=502,
                    latency_ms=int((time.time() - started) * 1000), error=message,
                )
                last_error = AgentGatewayError(message, 502)
                if index < len(routes) - 1:
                    self.credentials.mark_failure(
                        route.get('credential'), message, observed_at=observed_at, soft=True,
                    )
                    continue
                self.credentials.mark_failure(
                    route.get('credential'), message, observed_at=observed_at,
                )
            finally:
                if active_lease is not None:
                    active_lease.release()
        route = routes[-1]
        final_error = last_error or AgentGatewayError('没有可用的网页搜索账号', 503)
        self._record_request(
            user.id, request_id, route, status='upstream_error',
            http_status=final_error.status_code, attempt_count=len(routes),
            fallback_used=len(routes) > 1, error_summary=final_error.message,
        )
        raise self._attach_request_id(final_error, request_id)

    def web_fetch(
        self, user, url, max_content_tokens=None, *,
        parent_request_id=None, trace_metadata=None,
    ):
        """抓取单个 URL：交给能执行服务端工具的账号，网关自身不对外发请求。

        NOTE 与 web_search() 的选路/重试/记账逻辑高度重合。那边还额外背着
        attempt trace 与逐档健康标记，机械抽取一次公共循环是对的，但那属于
        独立重构，不该和新增能力混在同一次改动里。
        """
        request_id = self.usage.new_request_id()
        if not getattr(self, '_inbound_protocol', None):
            self._inbound_protocol = 'web-fetch'
        url = str(url or '').strip()
        if not url:
            raise AgentGatewayError('网页抓取需要非空 url', 400, {'request_id': request_id})
        body = {
            'model': 'web-fetch',
            'messages': [{'role': 'user', 'content': url}],
            'max_tokens': 4096,
        }
        self._trace_metadata = (
            dict(trace_metadata) if isinstance(trace_metadata, dict)
            else request_trace_metadata(None, body)
        )
        self._parent_request_id = parent_request_id
        self._context_metadata = context_metadata(body, self.usage)
        self._attempt_trace = []
        self._attempt_trace_enabled = True
        try:
            self.usage.reserve_quota(
                user.id, request_id, body, body['model'],
                pat_id=getattr(getattr(g, 'agent_pat', None), 'id', None),
                parent_request_id=parent_request_id,
            )
        except AgentUsageError as exc:
            self._record_request(
                user.id, request_id, status='quota_exceeded', http_status=429,
                error_summary=exc.message, requested_model=body['model'],
            )
            exc.payload = {**exc.payload, 'request_id': request_id}
            raise

        fetched = self._provider_fetch(user, request_id, url)
        if fetched is not None:
            return fetched, 200, request_id

        try:
            routes = self.resolve_search_routes()
        except AgentGatewayError as exc:
            self._record_request(
                user.id, request_id, status='routing_error', http_status=exc.status_code,
                error_summary=exc.message, requested_model=body['model'],
            )
            self._attach_request_id(exc, request_id)
            raise
        if routes:
            self._bind_request_credential(request_id, routes[0])

        last_error = None
        for index, route in enumerate(routes):
            attempt_record = self._new_attempt(route)
            self._attempt_trace.append(attempt_record)
            started = time.time()
            observed_at = datetime.utcnow()
            self.credentials.touch(route.get('credential'))
            lease = ACTIVE_CREDENTIAL_REQUESTS.acquire(route.get('credential_id'))
            try:
                req = route['adapter'].build_web_fetch_request(
                    base_url=route['base'], api_key=route['key'], model=route['model'],
                    url=url, max_content_tokens=max_content_tokens,
                    protocol=route.get('upstream_protocol'),
                )
                apply_credential_headers(req, route.get('credential'))
                resp = urlopen_with_transient_retry(
                    req, timeout=route['timeout'], proxy_url=route.get('proxy_url'),
                )
                try:
                    raw = resp.read().decode('utf-8', errors='replace')
                finally:
                    resp.close()
                latency_ms = int((time.time() - started) * 1000)
                parsed = json.loads(raw)
                fetched = route['adapter'].parse_web_fetch_response(parsed)
            except ProviderAdapterError as exc:
                # 上游 200 但回包里没有抓取结果，说明这个端点不执行服务端工具。
                # 这是能力问题不是健康问题，不扣健康分。
                WEB_SEARCH_SUPPORT.record(route.get('credential_id'), False)
                self._finish_attempt(
                    attempt_record, '不支持网页抓取', http_status=exc.status_code,
                    error=exc.message,
                )
                last_error = AgentGatewayError(exc.message, exc.status_code)
                continue
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                self._finish_attempt(attempt_record, '失败', http_status=502, error='上游返回非 JSON')
                last_error = AgentGatewayError('上游返回非 JSON', 502)
                self.credentials.mark_failure(
                    route.get('credential'), '上游返回非 JSON',
                    observed_at=observed_at, soft=index < len(routes) - 1,
                )
                continue
            except urlerror.HTTPError as exc:
                err_body = exc.read().decode('utf-8', errors='replace')
                retryable, immediate = classify_upstream_http(exc.code, err_body)
                self._finish_attempt(
                    attempt_record, '失败', http_status=exc.code,
                    error=f'上游返回 HTTP {exc.code}',
                )
                if retryable:
                    self.credentials.mark_failure(
                        route.get('credential'), f'HTTP {exc.code}: {err_body[:300]}',
                        observed_at=observed_at, immediate=immediate,
                        soft=(not immediate and (index < len(routes) - 1 or exc.code == 429)),
                    )
                else:
                    WEB_SEARCH_SUPPORT.record(route.get('credential_id'), False)
                last_error = AgentGatewayError(f'网页抓取上游返回 HTTP {exc.code}', 502)
                continue
            except (urlerror.URLError, TimeoutError, OSError) as exc:
                _, reason = classify_connection_error(exc)
                message = f'上游不可达: {reason}'
                self._finish_attempt(attempt_record, '失败', http_status=502, error=message)
                self.credentials.mark_failure(
                    route.get('credential'), message,
                    observed_at=observed_at, soft=index < len(routes) - 1,
                )
                last_error = AgentGatewayError(message, 502)
                continue
            finally:
                if lease is not None:
                    lease.release()

            WEB_SEARCH_SUPPORT.record(route.get('credential_id'), True)
            self.credentials.mark_success(
                route.get('credential'), latency_ms, observed_at=observed_at,
            )
            self._finish_attempt(attempt_record, '成功', http_status=200, latency_ms=latency_ms)
            usage = route['adapter'].usage_from_response(parsed)
            self._record_request(
                user.id, request_id, route,
                prompt_tokens=int(
                    (usage or {}).get('prompt_tokens')
                    or self.usage.estimate_tokens(body.get('messages'))
                ),
                completion_tokens=int(
                    (usage or {}).get('completion_tokens')
                    or self.usage.estimate_tokens(fetched.get('text'))
                ),
                latency_ms=latency_ms, status='ok', http_status=200,
                attempt_count=index + 1, fallback_used=index > 0,
                cache_read_tokens=(usage or {}).get('cache_read_tokens'),
                cache_write_tokens=(usage or {}).get('cache_write_tokens'),
                cache_miss_tokens=(usage or {}).get('cache_miss_tokens'),
            )
            return fetched, 200, request_id

        final_error = last_error or AgentGatewayError('没有可用的网页抓取账号', 503)
        self._record_request(
            user.id, request_id, routes[-1] if routes else None, status='upstream_error',
            http_status=final_error.status_code, attempt_count=len(routes),
            fallback_used=len(routes) > 1, error_summary=final_error.message,
            requested_model=body['model'],
        )
        raise self._attach_request_id(final_error, request_id)

    def _provider_search(self, user, request_id, query, limit, config=None):
        """先问全局搜索后端。没配置返回 None，失败也返回 None 交给模型账号兜底。

        它比委托模型账号快一个量级、便宜一个量级，结果形状还统一——实测委托
        模型账号一次搜索要花一次完整推理（17 秒），且五个账号出现过四种回包形状。
        """
        provider = configured_search_provider()
        if provider is None:
            return None
        config = config or {}
        started = time.time()
        try:
            sources = provider.search(
                query, limit=limit,
                allowed_domains=config.get('allowed_domains') or (),
                blocked_domains=config.get('blocked_domains') or (),
            )
        except SearchProviderError as exc:
            current_app.logger.warning('网页搜索后端失败，回退模型账号：%s', exc.message)
            return None
        if not sources:
            return None
        self._record_request(
            user.id, request_id,
            prompt_tokens=self.usage.estimate_tokens(query),
            completion_tokens=self.usage.estimate_tokens(sources),
            latency_ms=int((time.time() - started) * 1000),
            status='ok', http_status=200, attempt_count=1,
            requested_model=f'websearch:{provider.code}',
        )
        return sources

    def _provider_fetch(self, user, request_id, url):
        """抓取同样先问全局后端；它去发这个请求，网关自身不碰任意 URL。"""
        provider = configured_search_provider()
        if provider is None:
            return None
        started = time.time()
        try:
            fetched = provider.fetch(url)
        except SearchProviderError as exc:
            current_app.logger.warning('网页抓取后端失败，回退模型账号：%s', exc.message)
            return None
        if not fetched or not fetched.get('text'):
            return None
        self._record_request(
            user.id, request_id,
            prompt_tokens=self.usage.estimate_tokens(url),
            completion_tokens=self.usage.estimate_tokens(fetched.get('text')),
            latency_ms=int((time.time() - started) * 1000),
            status='ok', http_status=200, attempt_count=1,
            requested_model=f'webfetch:{provider.code}',
        )
        return fetched

    def _proxy_stream(
        self, user, route, resp, started, request_id, *,
        body, attempt_count=1, fallback_used=False, client_model=None,
        upstream_protocol=None, inbound_protocol=None,
        active_lease=None, attempt_record=None,
    ):
        def generate():
            prompt_tokens = 0
            completion_tokens = 0
            estimated_completion_tokens = 0
            cache_read_tokens = None
            cache_write_tokens = None
            cache_miss_tokens = None
            status = 'ok'
            stream_error_summary = None
            parse_buffer = ''
            decoder = codecs.getincrementaldecoder('utf-8')('replace')
            bridge = build_stream_bridge(
                upstream_protocol, inbound_protocol, client_model,
            ) if upstream_protocol and inbound_protocol else None
            observed_at = datetime.utcfromtimestamp(started)
            try:
                while True:
                    chunk = resp.read(1024)
                    if not chunk:
                        parse_buffer += decoder.decode(b'', final=True)
                        if parse_buffer:
                            if bridge:
                                leftover = self._translate_stream_line(parse_buffer, bridge)
                                if leftover:
                                    yield leftover
                            else:
                                yield (self._rewrite_sse_client_model(parse_buffer, client_model) + '\n').encode('utf-8')
                        if bridge and not bridge.finished:
                            raise ProtocolBridgeError('上游流式响应未发送完成事件')
                        break
                    chunk = route['adapter'].normalize_stream_chunk(chunk)
                    if isinstance(chunk, str):
                        parse_buffer += chunk
                    else:
                        parse_buffer += decoder.decode(chunk)
                    lines = parse_buffer.split('\n')
                    parse_buffer = lines.pop()
                    emitted = []
                    chunk_stream_error = None
                    for line in lines:
                        if bridge:
                            piece = self._translate_stream_line(line, bridge)
                            if piece:
                                emitted.append(piece)
                            data = line[6:].strip() if line.startswith('data: ') else ''
                        else:
                            rewritten = self._rewrite_sse_client_model(line, client_model)
                            emitted.append(rewritten.encode('utf-8'))
                            data = rewritten[6:].strip() if rewritten.startswith('data: ') else ''
                        if not data or data == '[DONE]':
                            continue
                        try:
                            obj = json.loads(data)
                            if not bridge:
                                detected_error = stream_error_message(obj)
                                if detected_error:
                                    chunk_stream_error = detected_error
                            u = route['adapter'].usage_from_stream_event(obj)
                            if u:
                                prompt_tokens = int(u.get('prompt_tokens') or prompt_tokens)
                                completion_tokens = int(u.get('completion_tokens') or completion_tokens)
                                if 'cache_read_tokens' in u:
                                    cache_read_tokens = int(u['cache_read_tokens'])
                                if 'cache_write_tokens' in u:
                                    cache_write_tokens = int(u['cache_write_tokens'])
                                if 'cache_miss_tokens' in u:
                                    cache_miss_tokens = int(u['cache_miss_tokens'])
                            estimate_value = stream_completion_estimate_value(obj)
                            if estimate_value:
                                estimated_completion_tokens += self.usage.estimate_tokens(estimate_value)
                        except json.JSONDecodeError:
                            pass
                    if emitted:
                        yield b''.join(emitted) if bridge else (b'\n'.join(emitted) + b'\n')
                    if chunk_stream_error:
                        raise ProtocolBridgeError(chunk_stream_error)
            except GeneratorExit:
                status = 'client_error'
                stream_error_summary = '客户端中断流式响应'
                raise
            except Exception as exc:
                status = 'stream_error'
                stream_error_summary = str(exc) or '流式响应中断'
                raise
            finally:
                latency_ms = int((time.time() - started) * 1000)
                prompt_tokens = prompt_tokens or self.usage.estimate_tokens(
                    body.get('messages') or body.get('input')
                )
                completion_tokens = completion_tokens or estimated_completion_tokens
                self._finish_attempt(
                    attempt_record,
                    '成功' if status == 'ok' else status,
                    http_status=200,
                    latency_ms=latency_ms,
                    error=stream_error_summary if status != 'ok' else None,
                )
                try:
                    resp.close()
                except Exception:
                    pass
                if active_lease is not None:
                    active_lease.release()
                if status == 'ok':
                    self.credentials.mark_success(
                        route.get('credential'), latency_ms, observed_at=observed_at,
                    )
                    self._bind_route_session(route)
                elif status == 'stream_error':
                    self.credentials.mark_failure(
                        route.get('credential'), stream_error_summary or '流式响应中断',
                        observed_at=observed_at,
                    )
                    self._invalidate_route_session(route)
                try:
                    self._record_request(
                        user.id, request_id, route,
                        prompt_tokens=prompt_tokens,
                        completion_tokens=completion_tokens,
                        latency_ms=latency_ms,
                        status=status,
                        http_status=200,
                        attempt_count=attempt_count,
                        fallback_used=fallback_used,
                        cache_read_tokens=cache_read_tokens,
                        cache_write_tokens=cache_write_tokens,
                        cache_miss_tokens=cache_miss_tokens,
                        error_summary=stream_error_summary if status != 'ok' else None,
                    )
                except Exception:
                    pass

        response = Response(
            stream_with_context(generate()),
            status=200,
            mimetype=resp.headers.get('Content-Type', 'text/event-stream'),
        )
        response.headers['X-Agent-Request-Id'] = request_id
        return response
