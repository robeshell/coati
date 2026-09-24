"""请求记录与筛选条件校验。"""

from .common import AgentValidationError, boolean, integer, text

VALID_STATUSES = {
    'ok', 'upstream_error', 'stream_error', 'client_error',
    'routing_error', 'protocol_error', 'quota_exceeded', 'reserved',
}
def normalize_usage_event(data):
    data = data or {}
    status = text(data.get('status'), '状态', max_length=32, default='ok')
    if status not in VALID_STATUSES:
        raise AgentValidationError('状态值不合法')
    return {
        'request_id': text(data.get('request_id'), '请求 ID', max_length=64),
        'parent_request_id': text(data.get('parent_request_id'), '父请求 ID', max_length=64),
        'session_id': text(data.get('session_id'), '会话 ID', max_length=64),
        'client_request_id': text(data.get('client_request_id'), '客户端请求 ID', max_length=128),
        'step_index': integer(data.get('step_index'), '步骤序号', minimum=0, maximum=1_000_000),
        'retry_index': integer(data.get('retry_index'), '重试序号', minimum=0, maximum=100),
        'model': text(data.get('model'), '模型', max_length=128),
        'upstream_model': text(data.get('upstream_model'), '实际模型', max_length=128),
        'inbound_protocol': text(data.get('inbound_protocol'), '客户端协议', max_length=32),
        'upstream_protocol': text(data.get('upstream_protocol'), '上游接口', max_length=32),
        'route_id': integer(data.get('route_id'), '路由 ID', minimum=1),
        'prompt_tokens': integer(data.get('prompt_tokens'), '输入 Token', minimum=0, default=0),
        'completion_tokens': integer(data.get('completion_tokens'), '输出 Token', minimum=0, default=0),
        'context_tokens_estimate': integer(data.get('context_tokens_estimate'), '估算上下文 Token', minimum=0, default=0),
        'context_bytes': integer(data.get('context_bytes'), '上下文字节数', minimum=0, default=0),
        'message_count': integer(data.get('message_count'), '消息数', minimum=0, default=0),
        'tool_count': integer(data.get('tool_count'), '工具数', minimum=0, default=0),
        'image_count': integer(data.get('image_count'), '图片数', minimum=0, default=0),
        'tool_result_bytes': integer(data.get('tool_result_bytes'), '工具结果字节数', minimum=0, default=0),
        'largest_message_bytes': integer(data.get('largest_message_bytes'), '最大消息字节数', minimum=0, default=0),
        # None = 上游未上报；0 = 上游明确上报为 0，不能混用。
        'cache_read_tokens': integer(data.get('cache_read_tokens'), '缓存读取 Token', minimum=0),
        'cache_write_tokens': integer(data.get('cache_write_tokens'), '缓存写入 Token', minimum=0),
        'cache_miss_tokens': integer(data.get('cache_miss_tokens'), '缓存未命中 Token', minimum=0),
        'latency_ms': integer(data.get('latency_ms'), '耗时', minimum=0),
        'status': status,
        'http_status': integer(data.get('http_status'), 'HTTP 状态码', minimum=100, maximum=599),
        'error_summary': text(data.get('error_summary'), '错误摘要', max_length=500),
        'attempt_count': integer(data.get('attempt_count'), '尝试次数', minimum=0, maximum=10, default=1),
        'fallback_used': boolean(data.get('fallback_used'), False),
        'credential_id': integer(data.get('credential_id'), '凭证 ID', minimum=1),
        'pat_id': integer(data.get('pat_id'), '令牌 ID', minimum=1),
    }


def normalize_quota_payload(data):
    data = data or {}
    if 'daily_token_quota' not in data:
        raise AgentValidationError('每日 Token 配额必填')
    raw = data.get('daily_token_quota')
    return {
        'daily_token_quota': None if raw in (None, '') else integer(
            raw, '每日 Token 配额', minimum=0, maximum=1_000_000_000,
        ),
    }


def normalize_usage_filters(args):
    status = text(args.get('status'), '状态', max_length=32)
    if status and status not in VALID_STATUSES:
        raise AgentValidationError('状态值不合法')
    return {
        'user_id': integer(args.get('user_id'), '用户 ID', minimum=1),
        'pat_id': integer(args.get('pat_id'), '令牌 ID', minimum=1),
        'days': integer(args.get('days'), '时间范围', minimum=1, maximum=365, default=7),
        'status': status,
        'model': text(args.get('model'), '模型', max_length=128),
    }


__all__ = [
    'AgentValidationError', 'normalize_quota_payload',
    'normalize_usage_event', 'normalize_usage_filters',
]
