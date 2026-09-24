# -*- coding: utf-8 -*-
"""Agent 域模型"""

import json
from datetime import datetime

from backend.app.agent.time_utils import utc_iso


def build_agent_models(db):
    class AgentPat(db.Model):
        __tablename__ = 'agent_pat'

        id = db.Column(db.Integer, primary_key=True)
        user_id = db.Column(db.Integer, db.ForeignKey('admin_users.id'), nullable=False, index=True)
        name = db.Column(db.String(100), nullable=False, default='default')
        token_type = db.Column(db.String(20), nullable=False, default='personal')
        scopes_json = db.Column(db.Text, nullable=False, default='["chat","profile"]')
        note = db.Column(db.String(255), nullable=True)
        token_prefix = db.Column(db.String(16), nullable=False)
        token_hash = db.Column(db.String(128), nullable=False, unique=True, index=True)
        expires_at = db.Column(db.DateTime, nullable=True)
        revoked_at = db.Column(db.DateTime, nullable=True)
        last_used_at = db.Column(db.DateTime, nullable=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

        def scopes(self):
            try:
                value = json.loads(self.scopes_json or '[]')
            except (TypeError, ValueError):
                value = []
            return [str(item) for item in value if str(item).strip()] if isinstance(value, list) else []

        def to_dict(self):
            now = datetime.utcnow()
            if self.revoked_at:
                status = 'revoked'
            elif self.expires_at and self.expires_at <= now:
                status = 'expired'
            else:
                status = 'active'
            expires_in_days = None
            if self.expires_at and status == 'active':
                expires_in_days = max(0, (self.expires_at - now).days)
            return {
                'id': self.id,
                'user_id': self.user_id,
                'name': self.name,
                'token_type': self.token_type,
                'scopes': self.scopes(),
                'note': self.note,
                'token_prefix': self.token_prefix,
                'status': status,
                'expires_in_days': expires_in_days,
                'expires_at': utc_iso(self.expires_at),
                'revoked_at': utc_iso(self.revoked_at),
                'last_used_at': utc_iso(self.last_used_at),
                'created_at': utc_iso(self.created_at),
            }

    class AgentDeviceCode(db.Model):
        __tablename__ = 'agent_device_code'

        id = db.Column(db.Integer, primary_key=True)
        device_code = db.Column(db.String(64), nullable=False, unique=True, index=True)
        user_code = db.Column(db.String(32), nullable=False, unique=True, index=True)
        user_id = db.Column(db.Integer, db.ForeignKey('admin_users.id'), nullable=True, index=True)
        status = db.Column(db.String(20), nullable=False, default='pending')  # pending/confirmed/expired/consumed
        access_token_hash = db.Column(db.String(128), nullable=True)
        access_token_prefix = db.Column(db.String(16), nullable=True)
        expires_at = db.Column(db.DateTime, nullable=False)
        interval_seconds = db.Column(db.Integer, nullable=False, default=5)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        confirmed_at = db.Column(db.DateTime, nullable=True)
        consumed_at = db.Column(db.DateTime, nullable=True)

        def to_dict(self):
            return {
                'id': self.id,
                'user_code': self.user_code,
                'status': self.status,
                'expires_at': utc_iso(self.expires_at),
                'interval_seconds': self.interval_seconds,
            }

    class AgentUsageEvent(db.Model):
        __tablename__ = 'agent_usage_event'

        id = db.Column(db.Integer, primary_key=True)
        request_id = db.Column(db.String(64), nullable=False, unique=True, index=True)
        # 服务端工具（web_search/web_fetch）是模型请求的子调用；保留父请求 ID
        # 后，管理员可以把一次 Claude Code 闭环的多轮模型/工具用量串起来。
        parent_request_id = db.Column(db.String(64), nullable=True, index=True)
        user_id = db.Column(db.Integer, db.ForeignKey('admin_users.id'), nullable=False, index=True)
        session_id = db.Column(db.String(64), nullable=True, index=True)
        client_request_id = db.Column(db.String(128), nullable=True, index=True)
        step_index = db.Column(db.Integer, nullable=True)
        retry_index = db.Column(db.Integer, nullable=True)
        idempotency_key = db.Column(db.String(128), nullable=True, unique=True)
        model = db.Column(db.String(128), nullable=True)
        upstream_model = db.Column(db.String(128), nullable=True)
        inbound_protocol = db.Column(db.String(32), nullable=True)
        upstream_protocol = db.Column(db.String(32), nullable=True)
        route_id = db.Column(
            db.Integer, db.ForeignKey('agent_route_config.id', ondelete='SET NULL'),
            nullable=True, index=True,
        )
        prompt_tokens = db.Column(db.Integer, nullable=False, default=0)
        completion_tokens = db.Column(db.Integer, nullable=False, default=0)
        total_tokens = db.Column(db.Integer, nullable=False, default=0)
        context_tokens_estimate = db.Column(db.Integer, nullable=False, default=0)
        context_bytes = db.Column(db.Integer, nullable=False, default=0)
        message_count = db.Column(db.Integer, nullable=False, default=0)
        tool_count = db.Column(db.Integer, nullable=False, default=0)
        image_count = db.Column(db.Integer, nullable=False, default=0)
        tool_result_bytes = db.Column(db.Integer, nullable=False, default=0)
        largest_message_bytes = db.Column(db.Integer, nullable=False, default=0)
        # None means the upstream did not report this cache dimension; 0 means
        # the upstream explicitly reported zero. Keeping that distinction is
        # required for accurate cache coverage and hit-rate diagnostics.
        cache_read_tokens = db.Column(db.Integer, nullable=True, default=None)
        cache_write_tokens = db.Column(db.Integer, nullable=True, default=None)
        cache_miss_tokens = db.Column(db.Integer, nullable=True, default=None)
        latency_ms = db.Column(db.Integer, nullable=True)
        status = db.Column(db.String(32), nullable=False, default='ok')
        http_status = db.Column(db.Integer, nullable=True)
        error_summary = db.Column(db.String(500), nullable=True)
        attempt_count = db.Column(db.Integer, nullable=False, default=1)
        fallback_used = db.Column(db.Boolean, nullable=False, default=False)
        source = db.Column(db.String(32), nullable=False, default='gateway')  # gateway|cli
        credential_id = db.Column(
            db.Integer,
            db.ForeignKey('agent_llm_credential.id', ondelete='SET NULL'),
            nullable=True,
            index=True,
        )
        pat_id = db.Column(
            db.Integer, db.ForeignKey('agent_pat.id', ondelete='SET NULL'),
            nullable=True, index=True,
        )
        created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)

        def to_dict(self):
            return {
                'id': self.id,
                'request_id': self.request_id,
                'parent_request_id': self.parent_request_id,
                'user_id': self.user_id,
                'session_id': self.session_id,
                'client_request_id': self.client_request_id,
                'step_index': self.step_index,
                'retry_index': self.retry_index,
                'model': self.model,
                'upstream_model': self.upstream_model,
                'inbound_protocol': self.inbound_protocol,
                'upstream_protocol': self.upstream_protocol,
                'route_id': self.route_id,
                'prompt_tokens': self.prompt_tokens,
                'completion_tokens': self.completion_tokens,
                'total_tokens': self.total_tokens,
                'context_tokens_estimate': self.context_tokens_estimate,
                'context_bytes': self.context_bytes,
                'message_count': self.message_count,
                'tool_count': self.tool_count,
                'image_count': self.image_count,
                'tool_result_bytes': self.tool_result_bytes,
                'largest_message_bytes': self.largest_message_bytes,
                'cache_read_tokens': self.cache_read_tokens,
                'cache_write_tokens': self.cache_write_tokens,
                'cache_miss_tokens': self.cache_miss_tokens,
                'latency_ms': self.latency_ms,
                'status': self.status,
                'http_status': self.http_status,
                'error_summary': self.error_summary,
                'attempt_count': self.attempt_count,
                'fallback_used': self.fallback_used,
                'credential_id': self.credential_id,
                'pat_id': self.pat_id,
                'created_at': utc_iso(self.created_at),
            }

    class AgentUserQuota(db.Model):
        __tablename__ = 'agent_user_quota'

        user_id = db.Column(
            db.Integer, db.ForeignKey('admin_users.id', ondelete='CASCADE'),
            primary_key=True,
        )
        daily_token_quota = db.Column(db.Integer, nullable=False, default=0)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {
                'user_id': self.user_id,
                'daily_token_quota': self.daily_token_quota,
                'updated_at': utc_iso(self.updated_at),
            }

    class AgentSessionAffinity(db.Model):
        """将一个用户会话稳定绑定到平台账号池中的一把凭据。"""
        __tablename__ = 'agent_session_affinity'
        __table_args__ = (
            db.UniqueConstraint(
                'user_id', 'session_id', 'model_key',
                name='uq_agent_session_affinity_key',
            ),
            db.Index('ix_agent_session_affinity_expires_at', 'expires_at'),
        )

        id = db.Column(db.Integer, primary_key=True)
        user_id = db.Column(
            db.Integer, db.ForeignKey('admin_users.id', ondelete='CASCADE'),
            nullable=False,
        )
        session_id = db.Column(db.String(64), nullable=False)
        model_key = db.Column(db.String(255), nullable=False)
        credential_id = db.Column(
            db.Integer, db.ForeignKey('agent_llm_credential.id', ondelete='CASCADE'),
            nullable=False, index=True,
        )
        expires_at = db.Column(db.DateTime, nullable=False)
        created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
        updated_at = db.Column(
            db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False,
        )

        def to_dict(self):
            return {
                'id': self.id,
                'user_id': self.user_id,
                'session_id': self.session_id,
                'model_key': self.model_key,
                'credential_id': self.credential_id,
                'expires_at': utc_iso(self.expires_at),
                'created_at': utc_iso(self.created_at),
                'updated_at': utc_iso(self.updated_at),
            }

    class AgentLlmCredential(db.Model):
        """上游 LLM Key 池（管理端维护，网关按权重选取）。"""
        __tablename__ = 'agent_llm_credential'

        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(100), nullable=False)
        # 画像默认值不该点名某个厂商：不显式给出时会拿到错的缓存语义和
        # anthropic_messages_url 拼接规则。openai-compatible 是中性的那个。
        provider = db.Column(db.String(64), nullable=False, default='openai-compatible')
        # 实际请求构造的唯一依据；provider 仅作为内部厂商画像和用量归类保留。
        upstream_protocol = db.Column(db.String(32), nullable=False, default='openai-chat', index=True)
        base_url = db.Column(db.String(512), nullable=False)
        # api_key 仅保存 enc:v1: 前缀的密文；明文兼容只用于升级迁移。
        api_key = db.Column(db.Text, nullable=False)
        api_key_hint = db.Column(db.String(32), nullable=False, default='****')
        key_fingerprint = db.Column(db.String(64), nullable=False, index=True)
        models_json = db.Column(db.Text, nullable=False, default='[]')
        # 历史兼容字段：能力已迁移到 agent_model_profile，运行时不再读取。
        # 保留一版便于旧数据库平滑升级和回滚，不再在接口中展示或写入。
        model_capabilities_json = db.Column(db.Text, nullable=False, default='{}')
        tags_json = db.Column(db.Text, nullable=False, default='[]')
        # 不在 ORM 中猜测具体模型；新账号的模型必须来自管理员配置。
        default_model = db.Column(db.String(128), nullable=False, default='')
        priority = db.Column(db.Integer, nullable=False, default=100)
        weight = db.Column(db.Integer, nullable=False, default=100)
        request_timeout_seconds = db.Column(db.Integer, nullable=False, default=120)
        enabled = db.Column(db.Boolean, nullable=False, default=True)
        note = db.Column(db.String(255), nullable=True)
        health_status = db.Column(db.String(20), nullable=False, default='unknown')
        consecutive_failures = db.Column(db.Integer, nullable=False, default=0)
        last_checked_at = db.Column(db.DateTime, nullable=True)
        last_success_at = db.Column(db.DateTime, nullable=True)
        last_error_at = db.Column(db.DateTime, nullable=True)
        last_error = db.Column(db.Text, nullable=True)
        last_latency_ms = db.Column(db.Integer, nullable=True)
        cooldown_until = db.Column(db.DateTime, nullable=True)
        last_used_at = db.Column(db.DateTime, nullable=True)
        # platform：平台号池；personal：用户自己的渠道，仅 owner_user_id 可用。
        scope = db.Column(db.String(20), nullable=False, default='platform', index=True)
        owner_user_id = db.Column(db.Integer, db.ForeignKey('admin_users.id'), nullable=True, index=True)
        # 客户端展示前缀（转发上游时去掉）；extra_headers_json 为发给上游的额外 Header。
        model_prefix = db.Column(db.String(64), nullable=False, default='')
        extra_headers_json = db.Column(db.Text, nullable=False, default='{}')
        # proxy_url 仅保存 enc:v1: 密文；proxy_hint 供列表展示，不包含代理认证信息。
        proxy_url = db.Column(db.Text, nullable=True)
        proxy_hint = db.Column(db.String(255), nullable=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        @staticmethod
        def _json_list(raw):
            try:
                value = json.loads(raw or '[]')
            except (TypeError, ValueError):
                value = []
            return [str(item) for item in value if str(item).strip()] if isinstance(value, list) else []

        def supported_models(self):
            values = self._json_list(self.models_json)
            if self.default_model and self.default_model not in values:
                values.insert(0, self.default_model)
            return values

        def display_prefix(self):
            raw = (self.model_prefix or '').strip()
            if not raw:
                return ''
            return raw if raw[-1] in '/-' else f'{raw}/'

        def extra_headers(self):
            try:
                value = json.loads(self.extra_headers_json or '{}')
            except (TypeError, ValueError):
                return {}
            if not isinstance(value, dict):
                return {}
            return {
                str(key).strip(): '' if val is None else str(val)
                for key, val in value.items()
                if str(key).strip()
            }

        def display_models(self):
            prefix = self.display_prefix()
            return [f'{prefix}{name}' for name in self.supported_models()]

        def matches_model(self, requested, *, allow_upstream=False):
            requested = (requested or '').strip()
            if not requested:
                return False
            if requested in self.display_models():
                return True
            return allow_upstream and requested in self.supported_models()

        def upstream_model_for(self, requested):
            requested = (requested or '').strip()
            prefix = self.display_prefix()
            models = self.supported_models()
            if prefix and requested.startswith(prefix):
                stripped = requested[len(prefix):]
                if stripped in models:
                    return stripped
            if requested in models:
                return requested
            return None

        def to_dict(self, include_secret=False):
            now_utc = datetime.utcnow()
            data = {
                'id': self.id,
                'name': self.name,
                'provider': self.provider,
                'upstream_protocol': self.upstream_protocol or 'openai-chat',
                'base_url': self.base_url,
                'api_key_masked': self.api_key_hint or '****',
                'key_fingerprint': self.key_fingerprint,
                'supported_models': self.supported_models(),
                'default_model': self.default_model,
                'model_prefix': self.model_prefix or '',
                'extra_headers': self.extra_headers(),
                'proxy_enabled': bool(self.proxy_url),
                'proxy_hint': self.proxy_hint or '',
                'priority': self.priority,
                'weight': self.weight,
                'request_timeout_seconds': self.request_timeout_seconds,
                'enabled': self.enabled,
                'note': self.note,
                'health_status': self.health_status,
                'consecutive_failures': self.consecutive_failures,
                'last_checked_at': utc_iso(self.last_checked_at),
                'last_success_at': utc_iso(self.last_success_at),
                'last_error_at': utc_iso(self.last_error_at),
                'last_error': self.last_error,
                'last_latency_ms': self.last_latency_ms,
                'cooldown_until': utc_iso(self.cooldown_until),
                # 冷却是否仍在生效：过期但还没有新成功观测的账号，展示层不再报"冷却中"。
                'cooldown_active': bool(self.cooldown_until and self.cooldown_until > now_utc),
                'last_used_at': utc_iso(self.last_used_at),
                'scope': self.scope or 'platform',
                'owner_user_id': self.owner_user_id,
                'created_at': utc_iso(self.created_at),
                'updated_at': utc_iso(self.updated_at),
            }
            return data

    class AgentRouteConfig(db.Model):
        __tablename__ = 'agent_route_config'

        id = db.Column(db.Integer, primary_key=True)
        model_name = db.Column(db.String(128), nullable=False, unique=True, index=True)
        upstream_base = db.Column(db.String(512), nullable=True)
        upstream_model = db.Column(db.String(128), nullable=True)
        credential_id = db.Column(db.Integer, db.ForeignKey('agent_llm_credential.id'), nullable=True, index=True)
        description = db.Column(db.String(255), nullable=True)
        fallback_enabled = db.Column(db.Boolean, nullable=False, default=False)
        # 自动路由（model_name=coati-auto）时，带图请求的目标视觉模型。
        vision_model = db.Column(db.String(128), nullable=True)
        weight = db.Column(db.Integer, nullable=False, default=100)
        enabled = db.Column(db.Boolean, nullable=False, default=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'model_name': self.model_name,
                'upstream_base': self.upstream_base,
                'upstream_model': self.upstream_model,
                'vision_model': self.vision_model,
                'credential_id': self.credential_id,
                'description': self.description,
                'fallback_enabled': self.fallback_enabled,
                'enabled': self.enabled,
                'created_at': utc_iso(self.created_at),
                'updated_at': utc_iso(self.updated_at),
            }

    class AgentModelProfile(db.Model):
        """平台统一维护的模型能力档案。

        模型能力属于模型本身，不属于某一把上游账号。同一模型被多个账号
        支持时，只从这里读取一次，账号表只负责声明支持模型和映射关系。
        """
        __tablename__ = 'agent_model_profile'

        id = db.Column(db.Integer, primary_key=True)
        model_name = db.Column(db.String(128), nullable=False, unique=True, index=True)
        context_window = db.Column(db.Integer, nullable=False, default=131072)
        max_output_tokens = db.Column(db.Integer, nullable=False, default=8192)
        # context_window/max_output_tokens are the effective values sent to dsh.
        # Nullable override fields distinguish an administrator override from
        # values refreshed from LiteLLM.
        context_window_override = db.Column(db.Integer, nullable=True)
        max_output_tokens_override = db.Column(db.Integer, nullable=True)
        litellm_model_name = db.Column(db.String(255), nullable=True)
        litellm_context_window = db.Column(db.Integer, nullable=True)
        litellm_max_output_tokens = db.Column(db.Integer, nullable=True)
        litellm_synced_at = db.Column(db.DateTime, nullable=True)
        enabled = db.Column(db.Boolean, nullable=False, default=True)
        note = db.Column(db.String(255), nullable=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            context_override = self.context_window_override
            output_override = self.max_output_tokens_override
            if context_override is not None and output_override is not None:
                source = 'admin'
            elif context_override is not None or output_override is not None:
                source = 'mixed'
            elif self.litellm_context_window or self.litellm_max_output_tokens:
                source = 'litellm'
            else:
                source = 'fallback'
            return {
                'id': self.id,
                'model_name': self.model_name,
                'context_window': self.context_window,
                'max_output_tokens': self.max_output_tokens,
                'context_window_override': context_override,
                'max_output_tokens_override': output_override,
                'litellm_model_name': self.litellm_model_name,
                'litellm_context_window': self.litellm_context_window,
                'litellm_max_output_tokens': self.litellm_max_output_tokens,
                'litellm_synced_at': utc_iso(self.litellm_synced_at),
                'source': source,
                'enabled': self.enabled,
                'note': self.note,
                'created_at': utc_iso(self.created_at),
                'updated_at': utc_iso(self.updated_at),
            }

    class AgentCacheTest(db.Model):
        """缓存命中率测试记录：N 轮相同请求的逐轮结果与汇总。"""
        __tablename__ = 'agent_cache_test'

        id = db.Column(db.Integer, primary_key=True)
        user_id = db.Column(db.Integer, db.ForeignKey('admin_users.id'), nullable=False, index=True)
        name = db.Column(db.String(100), nullable=False)
        model = db.Column(db.String(128), nullable=False)
        prompt = db.Column(db.Text, nullable=False)
        rounds = db.Column(db.Integer, nullable=False, default=3)
        max_tokens = db.Column(db.Integer, nullable=False, default=32)
        # ok（全部成功） / partial（部分成功） / failed（首轮即失败）
        status = db.Column(db.String(20), nullable=False, default='ok')
        summary_json = db.Column(db.Text, nullable=False, default='{}')
        rounds_json = db.Column(db.Text, nullable=False, default='[]')
        error_summary = db.Column(db.String(500), nullable=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)

        def summary(self):
            try:
                value = json.loads(self.summary_json or '{}')
            except (TypeError, ValueError):
                value = {}
            return value if isinstance(value, dict) else {}

        def rounds_data(self):
            try:
                value = json.loads(self.rounds_json or '[]')
            except (TypeError, ValueError):
                value = []
            return value if isinstance(value, list) else []

        def to_dict(self):
            return {
                'id': self.id,
                'user_id': self.user_id,
                'name': self.name,
                'model': self.model,
                'rounds': self.rounds,
                'max_tokens': self.max_tokens,
                'status': self.status,
                'summary': self.summary(),
                'round_details': self.rounds_data(),
                'error_summary': self.error_summary,
                'created_at': utc_iso(self.created_at),
            }

    return {
        'AgentPat': AgentPat,
        'AgentDeviceCode': AgentDeviceCode,
        'AgentUsageEvent': AgentUsageEvent,
        'AgentUserQuota': AgentUserQuota,
        'AgentSessionAffinity': AgentSessionAffinity,
        'AgentLlmCredential': AgentLlmCredential,
        'AgentRouteConfig': AgentRouteConfig,
        'AgentModelProfile': AgentModelProfile,
        'AgentCacheTest': AgentCacheTest,
    }
