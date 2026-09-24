# -*- coding: utf-8 -*-
"""用量写入、查询与日配额业务服务。"""

import json
import math
from datetime import datetime, timedelta
from uuid import uuid4

from flask import current_app

from backend.app.agent.crud import AgentUsageCRUD
from backend.app.agent.schema.common import AgentValidationError
from backend.app.agent.schema.usage import normalize_quota_payload, normalize_usage_event, normalize_usage_filters
from backend.app.agent.time_utils import local_day_start_utc, utc_iso
from backend.common.tabular import build_table_response, normalize_table_file_type

STATUS_LABELS = {
    'ok': '成功',
    'upstream_error': '上游错误',
    'stream_error': '流式中断',
    'client_error': '客户端中断',
    'routing_error': '路由失败',
    'protocol_error': '协议不兼容',
    'quota_exceeded': '超过配额',
    'reserved': '预扣',
}

REQUEST_PURPOSE_LABELS = {
    'model': '模型请求',
    'compaction': '上下文压缩',
    'title': '会话标题',
}

# 账号尝试链只供管理员排查。它复用已有错误摘要字段保存，个人接口和导出
# 会在返回前脱敏，避免把平台内部账号信息泄露给普通用户。
INTERNAL_ATTEMPT_TRACE_PREFIX = '账号调用链：'


def mine_error_summary(row):
    value = row.error_summary or ''
    if row.fallback_used and INTERNAL_ATTEMPT_TRACE_PREFIX in value:
        return '请求过程中已自动切换备用账号'
    return value


def request_purpose(client_request_id):
    """从 dsh 现有客户端请求 ID 中提取辅助调用用途，不新增数据库字段。"""
    value = str(client_request_id or '')
    for purpose, label in REQUEST_PURPOSE_LABELS.items():
        if f':{purpose}:' in value:
            return {'code': purpose, 'label': label}
    return None

MINE_EXPORT_FIELD_MAP = {
    'created_at': ('时间', lambda row: utc_iso(row.created_at)),
    'request_id': ('请求 ID', lambda row: row.request_id or ''),
    'parent_request_id': ('父请求 ID', lambda row: row.parent_request_id or ''),
    'session_id': ('会话 ID', lambda row: row.session_id or ''),
    'client_request_id': ('客户端请求 ID', lambda row: row.client_request_id or ''),
    'request_purpose': ('请求用途', lambda row: (request_purpose(row.client_request_id) or {}).get('label', '')),
    'step_index': ('步骤序号', lambda row: '' if row.step_index is None else row.step_index),
    'retry_index': ('重试序号', lambda row: '' if row.retry_index is None else row.retry_index),
    'model': ('模型', lambda row: row.model or ''),
    'prompt_tokens': ('输入 Token', lambda row: row.prompt_tokens or 0),
    'completion_tokens': ('输出 Token', lambda row: row.completion_tokens or 0),
    'total_tokens': ('合计 Token', lambda row: row.total_tokens or 0),
    'context_tokens_estimate': ('估算上下文 Token', lambda row: row.context_tokens_estimate or 0),
    'context_bytes': ('上下文字节数', lambda row: row.context_bytes or 0),
    'message_count': ('消息数', lambda row: row.message_count or 0),
    'tool_count': ('工具数', lambda row: row.tool_count or 0),
    'image_count': ('图片数', lambda row: row.image_count or 0),
    'tool_result_bytes': ('工具结果字节数', lambda row: row.tool_result_bytes or 0),
    'largest_message_bytes': ('最大消息字节数', lambda row: row.largest_message_bytes or 0),
    'cache_read_tokens': ('缓存读取 Token', lambda row: '' if row.cache_read_tokens is None else row.cache_read_tokens),
    'cache_write_tokens': ('缓存写入 Token', lambda row: '' if row.cache_write_tokens is None else row.cache_write_tokens),
    'cache_miss_tokens': ('缓存未命中 Token', lambda row: '' if row.cache_miss_tokens is None else row.cache_miss_tokens),
    'latency_ms': ('耗时(ms)', lambda row: '' if row.latency_ms is None else row.latency_ms),
    'status': ('状态', lambda row: STATUS_LABELS.get(row.status, row.status or '')),
    'error_summary': ('错误摘要', mine_error_summary),
    'fallback_used': ('是否换号', lambda row: '是' if row.fallback_used else '否'),
    'attempt_count': ('尝试次数', lambda row: row.attempt_count or 0),
}

# 个人用量接口只允许返回用户排查自身用量所需的字段。内部路由信息必须在服务层剥离，
# 不能依赖前端“不展示”来承担权限边界。
MINE_HIDDEN_FIELDS = {
    'user_id', 'upstream_model', 'route_id', 'credential_id', 'pat_id',
    'credential_name', 'provider', 'route_name',
}


class AgentUsageError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class AgentUsageService:
    def __init__(self, db, models):
        self.Usage = models['AgentUsageEvent']
        self.crud = AgentUsageCRUD(db, models)

    @staticmethod
    def new_request_id():
        return f'req_{uuid4().hex}'

    @staticmethod
    def default_quota():
        return int(current_app.config.get('AGENT_DAILY_TOKEN_QUOTA', 0) or 0)

    @staticmethod
    def min_completion_headroom():
        """剩余额度不足以放下这么多输出时直接拒绝，而不是静默截断 max_tokens。

        默认 0 保持原有语义（只要还剩一点就放行）。设成几百可以避免用户在
        临近配额时收到残缺回答，以及截断的工具调用参数引发的 502。
        """
        try:
            return max(0, int(current_app.config.get(
                'AGENT_QUOTA_MIN_COMPLETION_HEADROOM', 0,
            ) or 0))
        except (TypeError, ValueError):
            return 0

    def record(self, user_id, **event):
        try:
            payload = normalize_usage_event(event)
        except AgentValidationError as exc:
            raise AgentUsageError(str(exc)) from exc
        existing_request = self.crud.get_by_request_id(payload.get('request_id')) if payload.get('request_id') else None
        if existing_request:
            if existing_request.user_id == user_id and existing_request.status == 'reserved':
                payload['user_id'] = user_id
                payload['request_id'] = existing_request.request_id
                return self.crud.finalize_reserved(existing_request, payload).to_dict()
            raise AgentUsageError('请求 ID 已存在', 409)
        payload['user_id'] = user_id
        payload['request_id'] = payload.get('request_id') or self.new_request_id()
        payload['total_tokens'] = payload['prompt_tokens'] + payload['completion_tokens']
        row = self.Usage(**payload)
        self.crud.add(row)
        return row.to_dict()

    def bind_credential(self, request_id, credential_id):
        """记录 reserved 请求当前使用的账号；失败不影响主请求。"""
        return self.crud.bind_credential(request_id, credential_id)

    def active_credential_loads(self, credential_ids):
        """返回近期进行中请求的账号负载。"""
        if not credential_ids:
            return {}
        try:
            stale_seconds = int(current_app.config.get(
                'AGENT_ACTIVE_REQUEST_STALE_SECONDS', 900,
            ) or 900)
        except (TypeError, ValueError):
            stale_seconds = 900
        stale_seconds = min(3600, max(300, stale_seconds))
        since = datetime.utcnow() - timedelta(seconds=stale_seconds)
        return self.crud.active_credential_loads(credential_ids, since=since)

    def recover_transaction(self):
        """读取负载失败时释放当前数据库事务，让网关继续降级调度。"""
        self.crud.rollback()

    def tokens_today(self, user_id):
        start = local_day_start_utc()
        return self.crud.tokens_since(user_id, start)

    @staticmethod
    def estimate_tokens(value):
        if value in (None, '', [], {}):
            return 0
        if not isinstance(value, str):
            value = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
        # UTF-8 字节/4 对英文接近常见分词比例，对中文略偏保守。
        return max(1, math.ceil(len(value.encode('utf-8')) / 4))

    def reserve_quota(
        self, user_id, request_id, body, requested_model=None, pat_id=None,
        parent_request_id=None,
    ):
        estimate = {
            'messages': body.get('messages'),
            'tools': body.get('tools'),
            'response_format': body.get('response_format'),
        }
        if body.get('input') is not None:
            estimate['input'] = body.get('input')
        if body.get('instructions') is not None:
            estimate['instructions'] = body.get('instructions')
        if body.get('system') is not None:
            estimate['system'] = body.get('system')
        prompt_tokens = self.estimate_tokens(estimate)
        raw_limit = body.get('max_completion_tokens', body.get('max_output_tokens', body.get('max_tokens')))
        if raw_limit in (None, ''):
            raw_limit = current_app.config.get('AGENT_QUOTA_DEFAULT_MAX_OUTPUT_TOKENS', 4096)
        try:
            completion_tokens = int(raw_limit)
        except (TypeError, ValueError) as exc:
            raise AgentUsageError('最大输出 Token 必须是整数') from exc
        completion_tokens = min(1_000_000, max(1, completion_tokens))
        ttl = max(300, int(current_app.config.get('AGENT_QUOTA_RESERVATION_TTL_SECONDS', 3600) or 3600))
        result = self.crud.reserve_quota(
            user_id=user_id,
            request_id=request_id,
            model=requested_model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            since=local_day_start_utc(),
            reservation_since=datetime.utcnow() - timedelta(seconds=ttl),
            default_quota=self.default_quota(),
            pat_id=pat_id,
            parent_request_id=parent_request_id,
            min_headroom=self.min_completion_headroom(),
        )
        if not result['allowed']:
            raise AgentUsageError('本次请求预计用量超过今日剩余配额', 429, {
                'used': result['used'], 'quota': result['quota'],
                'remaining': result.get('remaining', 0),
            })
        return result

    def assert_quota(self, user_id):
        summary = self.quota_summary(user_id)
        quota = summary['daily_quota'] or 0
        used = summary['used_today']
        if quota > 0 and used >= quota:
            raise AgentUsageError('今日 Token 配额已用尽', 429, {
                'used': used, 'quota': quota, 'remaining': 0,
            })

    def quota_summary(self, user_id):
        override = self.crud.get_quota(user_id)
        quota = override.daily_token_quota if override is not None else self.default_quota()
        used = self.tokens_today(user_id)
        return {
            'daily_quota': quota or None,
            'quota_override': override.daily_token_quota if override is not None else None,
            'quota_source': 'user' if override is not None else 'default',
            'used_today': used,
            'remaining': max(0, quota - used) if quota > 0 else None,
            'usage_percent': round(min(100, used / quota * 100), 1) if quota > 0 else None,
            'exhausted': quota > 0 and used >= quota,
        }

    def list_quotas(self, page=1, per_page=20, search=None):
        page = max(1, int(page or 1))
        per_page = min(100, max(1, int(per_page or 20)))
        users, total = self.crud.page_quota_users(page, per_page, (search or '').strip() or None)
        start = local_day_start_utc()
        user_ids = [row.id for row in users]
        quotas, usage = self.crud.quota_context(user_ids, start)
        default_quota = self.default_quota()
        items = []
        for user in users:
            override = quotas.get(user.id)
            effective = override.daily_token_quota if override is not None else default_quota
            used = usage.get(user.id, 0)
            items.append({
                'user_id': user.id,
                'username': user.username,
                'daily_token_quota': override.daily_token_quota if override is not None else None,
                'effective_quota': effective or None,
                'quota_source': 'user' if override is not None else 'default',
                'used_today': used,
                'remaining': max(0, effective - used) if effective > 0 else None,
                'usage_percent': round(min(100, used / effective * 100), 1) if effective > 0 else None,
                'exhausted': effective > 0 and used >= effective,
                'updated_at': utc_iso(override.updated_at) if override else None,
            })
        return {
            'items': items, 'total': total, 'page': page, 'per_page': per_page,
            'default_daily_quota': default_quota or None,
        }

    def update_quota(self, user_id, data):
        if not self.crud.get_user(user_id):
            raise AgentUsageError('用户不存在', 404)
        try:
            value = normalize_quota_payload(data)['daily_token_quota']
        except AgentValidationError as exc:
            raise AgentUsageError(str(exc)) from exc
        if value is None:
            self.crud.delete_quota(user_id)
        else:
            self.crud.set_quota(user_id, value)
        return self.quota_summary(user_id)

    def list_admin(self, page=1, per_page=20, **filters):
        page = max(1, int(page or 1))
        per_page = min(100, max(1, int(per_page or 20)))
        rows, total = self.crud.page(page, per_page, **filters)
        users, credentials, routes, pats = self.crud.related_context(rows)
        items = []
        for row in rows:
            item = row.to_dict()
            item['username'] = users.get(row.user_id, f'用户 #{row.user_id}')
            credential = credentials.get(row.credential_id, {})
            item['credential_name'] = credential.get('credential_name')
            item['provider'] = credential.get('provider') or 'environment'
            if not item.get('upstream_protocol'):
                item['upstream_protocol'] = credential.get('upstream_protocol')
            item['route_name'] = routes.get(row.route_id)
            pat = pats.get(row.pat_id, {})
            item['pat_name'] = pat.get('pat_name')
            item['pat_token_type'] = pat.get('token_type')
            item['request_purpose'] = request_purpose(row.client_request_id)
            items.append(item)
        return {'items': items, 'total': total, 'page': page, 'per_page': per_page}

    def analytics(self, **filters):
        days = int(filters.get('days') or 7)
        return {
            'summary': self.crud.summary(**filters),
            'trend': self.crud.trend(**filters),
            'users': self.crud.top_users(**filters),
            # 模型分布始终返回全集：它同时承担下钻入口，否则一旦按模型筛选
            # 就只剩一个模型可点，管理员无法横向切换比较。
            'models': self.crud.model_breakdown(**{**filters, 'model': None}),
            'filter_options': self.crud.filter_options(days=days),
            'daily_quota_per_user': self.default_quota() or None,
        }

    def list_mine(self, user_id, page=1, per_page=20, **filters):
        page = max(1, int(page or 1))
        per_page = min(100, max(1, int(per_page or 20)))
        filters = dict(filters)
        filters.pop('user_id', None)
        rows, total = self.crud.page(page, per_page, user_id=user_id, **filters)
        pats = self.crud.pat_context(rows)
        items = []
        for row in rows:
            item = row.to_dict()
            for field in MINE_HIDDEN_FIELDS:
                item.pop(field, None)
            item['error_summary'] = mine_error_summary(row)
            pat = pats.get(row.pat_id, {})
            item['pat_name'] = pat.get('pat_name')
            item['pat_token_type'] = pat.get('token_type')
            item['request_purpose'] = request_purpose(row.client_request_id)
            items.append(item)
        return {'items': items, 'total': total, 'page': page, 'per_page': per_page}

    def analytics_mine(self, user_id, **filters):
        filters = dict(filters)
        filters.pop('user_id', None)
        days = int(filters.get('days') or 7)
        scoped_filters = {'user_id': user_id, **filters}
        payload = {
            'summary': self.crud.summary(**scoped_filters),
            'trend': self.crud.trend(**scoped_filters),
            'users': [],
            # 与管理员口径一致：模型分布忽略 model 自身的筛选，保留可切换的下钻入口。
            'models': self.crud.model_breakdown(**{**scoped_filters, 'model': None}),
            'daily_quota_per_user': None,
            'quota': self.quota_summary(user_id),
            'filter_options': {
                'pats': [
                    self._pat_filter_option(row)
                    for row in self.crud.list_pats_with_usage_for_user(user_id, days=days)
                ],
                'models': self.crud.model_options(days=days, user_id=user_id),
            },
        }
        return payload

    @staticmethod
    def _pat_filter_option(row):
        bits = [row.name or f'令牌 #{row.id}']
        if row.token_type == 'device':
            bits.append('设备')
        if row.revoked_at:
            bits.append('已撤销')
        elif row.expires_at and row.expires_at <= datetime.utcnow():
            bits.append('已过期')
        return {'value': row.id, 'label': ' · '.join(bits)}

    def export_mine(self, user_id, data):
        data = data or {}
        try:
            filters = normalize_usage_filters(data.get('filters') or data)
        except AgentValidationError as exc:
            raise AgentUsageError(str(exc)) from exc
        filters.pop('user_id', None)
        fields = [field for field in (data.get('fields') or []) if field in MINE_EXPORT_FIELD_MAP]
        if not fields:
            fields = list(MINE_EXPORT_FIELD_MAP)
        file_type = normalize_table_file_type(data.get('file_type'), default='xlsx')
        export_mode = str(data.get('export_mode') or 'filtered').strip()
        if export_mode == 'selected':
            ids = data.get('ids') or []
            if not isinstance(ids, list) or not ids:
                raise AgentUsageError('请先勾选要导出的记录', 400)
            rows = self.crud.list_for_user_ids(user_id, ids)
        else:
            rows, _total = self.crud.page(1, 5000, user_id=user_id, **filters)
        headers = [MINE_EXPORT_FIELD_MAP[field][0] for field in fields]
        table_rows = [[MINE_EXPORT_FIELD_MAP[field][1](row) for field in fields] for row in rows]
        try:
            return build_table_response(headers, table_rows, 'my_usage_export', file_type=file_type)
        except RuntimeError as exc:
            raise AgentUsageError(str(exc), 500) from exc

    def summarize_pats(self, user_id, pat_ids, days=7):
        return self.crud.summarize_pats(user_id, pat_ids, days=days)
