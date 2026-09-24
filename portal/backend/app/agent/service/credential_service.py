# -*- coding: utf-8 -*-
"""上游 LLM Key 池业务服务。"""

import hashlib
import json
import math
import random
import threading
import time
from datetime import datetime, timedelta
from types import SimpleNamespace
from urllib.parse import urlsplit

import requests
from flask import current_app
from sqlalchemy.exc import IntegrityError

from backend.app.agent.crud import AgentCredentialCRUD
from backend.app.agent.constants import (
    UPSTREAM_OPENAI_CHAT,
    UPSTREAM_PROTOCOLS,
    credential_upstream_protocol,
    upstream_accepts_inbound,
    upstream_protocol_catalog,
)
from backend.app.agent.schema.common import AgentValidationError, boolean
from backend.app.agent.schema.credential import (
    normalize_credential_payload, normalize_extra_headers, normalize_proxy_url,
)
from backend.app.agent.service.credential_crypto import (
    AgentCredentialCryptoError,
    api_key_fingerprint,
    api_key_hint,
    decrypt_api_key,
    decrypt_secret,
    encrypt_api_key,
    encrypt_secret,
)
from backend.app.agent.service.proxy import proxy_hint
from backend.app.agent.service.server_tools import WEB_SEARCH_SUPPORT
from backend.app.agent.service.provider_adapters import (
    ProviderAdapterError,
    get_provider_adapter,
    provider_catalog,
)
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete

# 欠费/鉴权失败不会自行恢复；冷却至少 30 分钟，避免空账号反复进调度。
FATAL_CREDENTIAL_COOLDOWN_SECONDS = 1800


class _ActiveCredentialRequestLease:
    """一次上游尝试的进程内负载租约，release 可安全重复调用。"""

    def __init__(self, tracker, credential_id):
        self._tracker = tracker
        self._credential_id = credential_id
        self._released = False

    def release(self):
        if self._released:
            return
        self._released = True
        self._tracker.release(self._credential_id)


class ActiveCredentialRequestTracker:
    """当前 worker 的进行中请求计数。

    正常平台请求同时写入 usage reserved 记录以跨 worker 汇总；这里作为
    DB 短暂不可用、个人渠道或 reserved 尚未落库时的低成本兜底。
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._counts = {}

    def acquire(self, credential_id):
        if credential_id is None:
            return None
        with self._lock:
            self._counts[credential_id] = self._counts.get(credential_id, 0) + 1
        return _ActiveCredentialRequestLease(self, credential_id)

    def release(self, credential_id):
        if credential_id is None:
            return
        with self._lock:
            current = self._counts.get(credential_id, 0)
            if current <= 1:
                self._counts.pop(credential_id, None)
            else:
                self._counts[credential_id] = current - 1

    def snapshot(self, credential_ids=None):
        with self._lock:
            if credential_ids is None:
                return dict(self._counts)
            wanted = set(credential_ids)
            return {
                credential_id: count
                for credential_id, count in self._counts.items()
                if credential_id in wanted
            }


ACTIVE_CREDENTIAL_REQUESTS = ActiveCredentialRequestTracker()


class AgentCredentialError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class AgentCredentialService:
    def __init__(self, db, models):
        self.Credential = models['AgentLlmCredential']
        self.crud = AgentCredentialCRUD(db, models)

    PERSONAL_LIMIT = 5
    COPY_SUFFIX = '（复制）'

    def list_items(
        self, page=1, per_page=20, search=None, enabled=None, upstream_protocol=None, health_status=None,
        *, scope='platform', owner_user_id=None, provider=None,
    ):
        page = max(1, int(page or 1))
        per_page = min(100, max(1, int(per_page or 20)))
        enabled = None if enabled in (None, '') else boolean(enabled)
        rows, total = self.crud.page(
            page, per_page, (search or '').strip() or None, enabled,
            (upstream_protocol or '').strip() or None, (health_status or '').strip() or None,
            scope=scope, owner_user_id=owner_user_id,
            provider=(provider or '').strip() or None,
        )
        return {
            'items': [row.to_dict() for row in rows], 'total': total,
            'page': page, 'per_page': per_page,
            'summary': self.crud.summary(scope=scope, owner_user_id=owner_user_id),
        }

    def _probe_after_create(self, row, *, allow_personal=False):
        """创建成功后做一次探活，并把探活失败降级为可展示的结果。

        账号已经在 ``create``/``create_personal`` 中提交成功，探活属于
        后置观测：网络、代理或上游异常不能回滚账号配置，也不能让新增接口
        误报为创建失败。探活本身仍复用 ``check``，因此会沿用现有健康状态
        更新、失败记账以及不可发现模型协议的未验证语义。
        """
        try:
            result = self.check(row.id, allow_personal=allow_personal)
        except AgentCredentialError as exc:
            result = {
                'ok': False,
                'verified': False,
                'health_status': getattr(row, 'health_status', None) or 'unknown',
                'message': exc.message,
                'status_code': exc.status_code,
            }
        except Exception as exc:  # pragma: no cover - 最后的后置观测兜底
            # 不能让意外的适配器/网络异常破坏“账号已创建”的结果；若异常
            # 来自事务则先复位会话，避免后续序列化或请求继续使用坏事务。
            try:
                self.crud.rollback()
            except Exception:
                pass
            result = {
                'ok': False,
                'verified': False,
                'health_status': getattr(row, 'health_status', None) or 'unknown',
                'message': f'自动探活失败：{exc}',
            }
        result = dict(result or {})
        result['attempted'] = True
        result.setdefault('health_status', getattr(row, 'health_status', None) or 'unknown')
        return result

    def create(self, data):
        try:
            payload = normalize_credential_payload(data)
        except AgentValidationError as exc:
            raise AgentCredentialError(str(exc)) from exc
        self._prepare_internal_provider(payload)
        self._assert_provider_available(payload.get('provider'))
        self._secure_payload(payload)
        self._ensure_default_model(payload)
        payload['scope'] = 'platform'
        payload['owner_user_id'] = None
        payload['model_prefix'] = ''
        row = self.Credential(**payload)
        self.crud.add(row)
        probe = self._probe_after_create(row)
        result = row.to_dict()
        result['health_probe'] = probe
        return result

    def copy(self, credential_id):
        """复制一条平台账号，保留密文配置但重置运行时健康状态。"""
        source = self.crud.get(credential_id)
        if not source:
            raise AgentCredentialError('凭证不存在', 404)
        self._assert_platform(source)

        name = str(source.name or '模型账号')
        suffix = self.COPY_SUFFIX
        clone = self.Credential(
            name=f'{name[:max(1, 100 - len(suffix))]}{suffix}',
            provider=source.provider,
            upstream_protocol=credential_upstream_protocol(source),
            base_url=source.base_url,
            # API Key / 代理已经是密文，直接复制密文不会暴露明文。
            api_key=source.api_key,
            api_key_hint=source.api_key_hint,
            key_fingerprint=source.key_fingerprint,
            models_json=source.models_json,
            model_capabilities_json=source.model_capabilities_json,
            tags_json=source.tags_json,
            default_model=source.default_model or '',
            priority=source.priority,
            weight=source.weight,
            request_timeout_seconds=source.request_timeout_seconds,
            enabled=source.enabled,
            note=source.note,
            # 账号配置复制，健康/调用状态从未知开始，避免误导运维判断。
            health_status='unknown',
            consecutive_failures=0,
            model_prefix=source.model_prefix or '',
            extra_headers_json=source.extra_headers_json,
            proxy_url=source.proxy_url,
            proxy_hint=source.proxy_hint,
            scope='platform',
            owner_user_id=None,
        )
        self.crud.add(clone)
        return clone.to_dict()

    def update(self, credential_id, data):
        row = self.crud.get(credential_id)
        if not row:
            raise AgentCredentialError('凭证不存在', 404)
        self._assert_platform(row)
        try:
            payload = normalize_credential_payload(data, partial=True)
        except AgentValidationError as exc:
            raise AgentCredentialError(str(exc)) from exc
        self._prepare_internal_provider(payload, row=row)
        self._assert_provider_available(payload.get('provider', row.provider))
        self._secure_payload(payload)
        self._ensure_default_model(payload, row=row)
        payload['model_prefix'] = ''
        for field, value in payload.items():
            setattr(row, field, value)
        self.crud.commit()
        # base_url / provider 都可能被改掉，之前观测到的服务端搜索行为不再可信。
        WEB_SEARCH_SUPPORT.clear(credential_id)
        return row.to_dict()

    def delete(self, credential_id):
        row = self.crud.get(credential_id)
        if not row:
            raise AgentCredentialError('凭证不存在', 404)
        self._assert_platform(row)
        if is_enabled_for_delete(row):
            raise AgentCredentialError(enabled_delete_message('模型账号'), 409)
        references = self.crud.route_reference_count(credential_id)
        if references:
            raise AgentCredentialError('该账号仍被模型路由使用，请先调整模型路由', 409, {'references': references})
        self._delete_row(row)
        return {'ok': True}

    def _delete_row(self, row):
        """删除账号但保留历史用量，兼容尚未升级外键的旧环境。"""
        try:
            self.crud.delete(row)
        except IntegrityError as exc:
            raise AgentCredentialError(
                '该账号仍被历史记录引用，请先执行数据库迁移后再删除',
                409,
            ) from exc

    def _assert_platform(self, row):
        if (getattr(row, 'scope', None) or 'platform') == 'personal' or getattr(row, 'owner_user_id', None):
            raise AgentCredentialError('个人渠道请在「模型渠道」中管理', 403)

    def list_personal(self, user_id, **kwargs):
        return self.list_items(scope='personal', owner_user_id=user_id, **kwargs)

    def create_personal(self, user_id, data):
        if self.crud.count_personal(user_id) >= self.PERSONAL_LIMIT:
            raise AgentCredentialError(f'个人渠道最多 {self.PERSONAL_LIMIT} 条，请先删除不用的渠道')
        try:
            payload = normalize_credential_payload(data)
        except AgentValidationError as exc:
            raise AgentCredentialError(str(exc)) from exc
        self._prepare_internal_provider(payload)
        self._assert_provider_available(payload.get('provider'))
        self._secure_payload(payload)
        self._ensure_default_model(payload)
        self._assert_personal_prefix(payload)
        payload['scope'] = 'personal'
        payload['owner_user_id'] = user_id
        row = self.Credential(**payload)
        self.crud.add(row)
        probe = self._probe_after_create(row, allow_personal=True)
        result = row.to_dict()
        result['health_probe'] = probe
        return result

    def update_personal(self, user_id, credential_id, data):
        row = self.crud.get_owned(credential_id, user_id)
        if not row:
            raise AgentCredentialError('渠道不存在', 404)
        try:
            payload = normalize_credential_payload(data, partial=True)
        except AgentValidationError as exc:
            raise AgentCredentialError(str(exc)) from exc
        self._prepare_internal_provider(payload, row=row)
        self._assert_provider_available(payload.get('provider', row.provider))
        self._secure_payload(payload)
        self._ensure_default_model(payload, row=row)
        self._assert_personal_prefix(payload, row=row)
        for field, value in payload.items():
            setattr(row, field, value)
        self.crud.commit()
        WEB_SEARCH_SUPPORT.clear(credential_id)
        return row.to_dict()

    def delete_personal(self, user_id, credential_id):
        row = self.crud.get_owned(credential_id, user_id)
        if not row:
            raise AgentCredentialError('渠道不存在', 404)
        if is_enabled_for_delete(row):
            raise AgentCredentialError(enabled_delete_message('个人渠道'), 409)
        references = self.crud.route_reference_count(credential_id)
        if references:
            raise AgentCredentialError(
                '该个人渠道仍被模型路由使用，请先解除路由绑定',
                409,
                {'references': references},
            )
        self._delete_row(row)
        return {'ok': True}

    def check_personal(self, user_id, credential_id):
        if not self.crud.get_owned(credential_id, user_id):
            raise AgentCredentialError('渠道不存在', 404)
        return self.check(credential_id, allow_personal=True)

    def discover_personal(self, user_id, data):
        data = dict(data or {})
        credential_id = data.get('credential_id')
        if credential_id not in (None, ''):
            try:
                owned_id = int(credential_id)
            except (TypeError, ValueError) as exc:
                raise AgentCredentialError('渠道不存在', 404) from exc
            if not self.crud.get_owned(owned_id, user_id):
                raise AgentCredentialError('渠道不存在', 404)
        return self.discover_models(data, allow_personal=True)

    def personal_matching(self, user_id, preferred_model):
        if not user_id or not preferred_model:
            return []
        rows = self.crud.enabled_items(scope='personal', owner_user_id=user_id)
        return [
            row for row in rows
            if row.display_prefix() and self._row_matches_model(row, preferred_model)
        ]

    @staticmethod
    def _assert_personal_prefix(payload, row=None):
        if 'model_prefix' in payload:
            prefix = payload.get('model_prefix') or ''
        else:
            prefix = getattr(row, 'model_prefix', None) or ''
        if not str(prefix).strip():
            raise AgentCredentialError('个人渠道必须填写模型前缀，避免与平台模型重名')

    @staticmethod
    def _ensure_default_model(payload, row=None):
        raw_models = payload.get('models_json', getattr(row, 'models_json', '[]'))
        try:
            models = json.loads(raw_models or '[]')
        except (TypeError, ValueError):
            models = []
        default_model = payload.get('default_model', getattr(row, 'default_model', None))
        if default_model and default_model not in models:
            models.insert(0, default_model)
        payload['models_json'] = json.dumps(models, ensure_ascii=False)

    @staticmethod
    def _secure_payload(payload):
        raw = payload.pop('api_key', None)
        if raw:
            try:
                payload['api_key'] = encrypt_api_key(raw)
            except AgentCredentialCryptoError as exc:
                raise AgentCredentialError(str(exc), 500) from exc
            payload['api_key_hint'] = api_key_hint(raw)
            payload['key_fingerprint'] = api_key_fingerprint(raw)
        if 'proxy_url' in payload:
            raw_proxy = payload.pop('proxy_url')
            if raw_proxy:
                try:
                    payload['proxy_url'] = encrypt_secret(raw_proxy, '出站代理不能为空')
                except AgentCredentialCryptoError as exc:
                    raise AgentCredentialError(str(exc), 500) from exc
                payload['proxy_hint'] = proxy_hint(raw_proxy)
            else:
                payload['proxy_url'] = None
                payload['proxy_hint'] = None

    @staticmethod
    def _assert_provider_available(provider):
        try:
            get_provider_adapter(provider).assert_available()
        except ProviderAdapterError as exc:
            raise AgentCredentialError(exc.message, exc.status_code) from exc

    @staticmethod
    def providers():
        return {'items': provider_catalog()}

    @staticmethod
    def upstream_protocols():
        return {'items': upstream_protocol_catalog()}

    @staticmethod
    def _infer_provider(base_url):
        """内部画像只服务于缓存解析和厂商特性，不参与接口路由。"""
        host = (urlsplit(str(base_url or '')).hostname or '').lower()
        if host == 'api.deepseek.com' or host.endswith('.deepseek.com'):
            return 'deepseek'
        if host == 'api.openai.com' or host.endswith('.openai.com'):
            return 'openai'
        if host == 'api.anthropic.com' or host.endswith('.anthropic.com'):
            return 'anthropic'
        return 'openai-compatible'

    @classmethod
    def _prepare_internal_provider(cls, payload, row=None):
        if row is not None and 'base_url' not in payload:
            return
        payload['provider'] = cls._infer_provider(
            payload.get('base_url') or getattr(row, 'base_url', ''),
        )

    @staticmethod
    def secret(row):
        try:
            return decrypt_api_key(row.api_key)
        except AgentCredentialCryptoError as exc:
            raise AgentCredentialError(str(exc), 500) from exc

    @staticmethod
    def proxy_secret(row):
        stored = getattr(row, 'proxy_url', None)
        if not stored:
            return None
        try:
            return decrypt_secret(stored)
        except AgentCredentialCryptoError as exc:
            raise AgentCredentialError(str(exc), 500) from exc

    @staticmethod
    def _weighted_order(rows, limit=None):
        remaining = list(rows)
        result = []
        target = len(remaining) if limit is None else min(len(remaining), max(0, int(limit)))
        while remaining and len(result) < target:
            picked = random.choices(
                remaining,
                weights=[max(1, int(row.weight or 1)) for row in remaining],
                k=1,
            )[0]
            result.append(picked)
            remaining.remove(picked)
        return result

    @staticmethod
    def _weighted_rendezvous_order(rows, affinity_key, limit=None):
        """无共享游标的加权一致性排序；相同会话在所有 worker 得到相同结果。"""
        key = str(affinity_key or '').encode('utf-8')

        def score(row):
            identity = str(
                getattr(row, 'id', None)
                or getattr(row, 'key_fingerprint', None)
                or getattr(row, 'name', '')
            )
            digest = hashlib.sha256(key + b'\0' + identity.encode('utf-8')).digest()
            uniform = (int.from_bytes(digest[:8], 'big') + 1) / ((1 << 64) + 1)
            weight = max(1, int(getattr(row, 'weight', 1) or 1))
            # 指数竞赛：score 最小者胜出，获胜概率与 weight 成正比。
            return (-math.log(uniform) / weight, identity)

        ordered = sorted(rows, key=score)
        if limit is None:
            return ordered
        return ordered[:max(0, int(limit))]

    @staticmethod
    def _in_cooldown(row, now=None):
        until = getattr(row, 'cooldown_until', None)
        return bool(until and until > (now or datetime.utcnow()))

    @staticmethod
    def _earliest_cooldown_until(rows, now=None):
        now = now or datetime.utcnow()
        candidates = [
            row.cooldown_until for row in rows
            if getattr(row, 'cooldown_until', None) and row.cooldown_until > now
        ]
        return min(candidates) if candidates else None

    @staticmethod
    def _format_retry_after(base_message, cooldown_until, now=None):
        now = now or datetime.utcnow()
        if not cooldown_until or cooldown_until <= now:
            return f'{base_message}，请稍后重试'
        seconds = max(1, int((cooldown_until - now).total_seconds()))
        if seconds >= 3600:
            hint = f'约 {(seconds + 3599) // 3600} 小时后重试'
        elif seconds >= 60:
            hint = f'约 {(seconds + 59) // 60} 分钟后重试'
        else:
            hint = f'约 {seconds} 秒后重试'
        return f'{base_message}，{hint}'

    @staticmethod
    def _unhealthy_in_penalty(row, now=None):
        """失败账号在重试窗口内不进入优先候选；窗口读时求值，到期自动参战。

        两档降权，恢复都不需要显式动作：
        - unhealthy：最近一次失败后 AGENT_CREDENTIAL_UNHEALTHY_RETRY_SECONDS（默认 300s）
          内不进优先候选。
        - 软记账失败（不改健康状态）：AGENT_CREDENTIAL_SOFT_RETRY_SECONDS（默认 10s）
          的更短窗口同样降权——由下一个真实请求免费探活，成功即满血复位。
        """
        now = now or datetime.utcnow()
        status = getattr(row, 'health_status', None) or 'unknown'
        last_error = getattr(row, 'last_error_at', None)
        if status == 'unhealthy':
            seconds = max(0, int(current_app.config.get(
                'AGENT_CREDENTIAL_UNHEALTHY_RETRY_SECONDS', 300,
            ) or 300))
            if seconds <= 0:
                return False
            if last_error is None:
                return True
            return last_error + timedelta(seconds=seconds) > now
        # 冷却档有自己的硬时间闸门（_in_cooldown），过期即放行，这里不叠加惩罚。
        if status == 'cooldown' or last_error is None:
            return False
        raw_seconds = current_app.config.get('AGENT_CREDENTIAL_SOFT_RETRY_SECONDS')
        soft_seconds = 10 if raw_seconds in (None, '') else max(0, int(raw_seconds))
        if soft_seconds <= 0:
            return False
        return last_error > now - timedelta(seconds=soft_seconds)

    @staticmethod
    def _row_matches_model(row, requested, *, allow_upstream=False):
        """兼容 ORM 模型和轻量测试/迁移桩的模型匹配。"""
        matcher = getattr(row, 'matches_model', None)
        if callable(matcher):
            return bool(matcher(requested, allow_upstream=allow_upstream))

        requested = (requested or '').strip()
        if not requested:
            return False
        supported_getter = getattr(row, 'supported_models', None)
        supported = supported_getter() if callable(supported_getter) else []
        if not isinstance(supported, (list, tuple, set)):
            return False
        prefix_getter = getattr(row, 'display_prefix', None)
        prefix = prefix_getter() if callable(prefix_getter) else ''
        if prefix and requested in {f'{prefix}{model}' for model in supported}:
            return True
        return allow_upstream and requested in supported

    def candidates(
        self, *, credential_id=None, preferred_model=None, provider=None,
        require_model_match=False, limit=None, affinity_key=None, inbound_protocol=None,
    ):
        now = datetime.utcnow()
        if credential_id:
            row = self.crud.get_enabled(credential_id)
            if not row or (getattr(row, 'scope', None) or 'platform') == 'personal':
                raise AgentCredentialError('指定的模型账号不可用', 503)
            if inbound_protocol and not upstream_accepts_inbound(
                credential_upstream_protocol(row), inbound_protocol,
            ):
                raise AgentCredentialError('指定的模型账号与当前客户端协议不兼容', 422)
            if self._in_cooldown(row, now):
                raise AgentCredentialError(
                    self._format_retry_after('指定的模型账号处于冷却状态', row.cooldown_until, now),
                    503,
                )
            if preferred_model and require_model_match and not self._row_matches_model(
                row, preferred_model, allow_upstream=True,
            ):
                raise AgentCredentialError(
                    f'指定的模型账号不支持模型 {preferred_model}', 503,
                )
            return [row]

        rows = self.crud.enabled_items()
        available = [row for row in rows if not self._in_cooldown(row, now)]
        if provider:
            available = [row for row in available if row.provider == provider]
        protocol_mismatch = False
        if inbound_protocol:
            before_protocol_filter = list(available)
            available = [
                row for row in available
                if upstream_accepts_inbound(credential_upstream_protocol(row), inbound_protocol)
            ]
            protocol_mismatch = bool(before_protocol_filter and not available)
        if preferred_model:
            matched = [
                row for row in available
                if self._row_matches_model(row, preferred_model, allow_upstream=True)
            ]
            if matched or require_model_match:
                available = matched
        # 「异常」在重试窗口内不进优先候选；窗口过后再试。只剩异常时仍兜底。
        preferred = [row for row in available if not self._unhealthy_in_penalty(row, now)]
        if preferred:
            available = preferred
        if not available:
            fallback = self._env_fallback()
            fallback_matches = (
                fallback
                and (not provider or fallback.provider == provider)
                and (
                    not inbound_protocol
                    or upstream_accepts_inbound(
                        credential_upstream_protocol(fallback), inbound_protocol,
                    )
                )
                and (not preferred_model or fallback.default_model == preferred_model)
            )
            if fallback_matches:
                return [fallback]
            if require_model_match and preferred_model:
                raise AgentCredentialError(f'没有支持模型 {preferred_model} 的可用模型账号', 503)
            if protocol_mismatch:
                raise AgentCredentialError('没有与当前客户端协议兼容的可用模型账号', 422)
            if rows:
                until = self._earliest_cooldown_until(rows, now)
                raise AgentCredentialError(
                    self._format_retry_after('匹配的模型账号均处于冷却状态', until, now),
                    503,
                )
            raise AgentCredentialError('未配置模型账号：请在管理后台「模型网关 → 模型账号」添加', 503)

        ordered = []
        priorities = sorted({int(row.priority or 0) for row in available}, reverse=True)
        for priority in priorities:
            remaining = None if limit is None else max(0, int(limit) - len(ordered))
            if remaining == 0:
                break
            bucket = [row for row in available if int(row.priority or 0) == priority]
            if affinity_key:
                selected = self._weighted_rendezvous_order(
                    bucket, affinity_key, limit=remaining,
                )
            else:
                selected = self._weighted_order(bucket, limit=remaining)
            ordered.extend(selected)
        return ordered

    def pick(self, *, credential_id=None, preferred_model=None):
        return self.candidates(credential_id=credential_id, preferred_model=preferred_model, limit=1)[0]

    def discover_models(self, data, *, allow_personal=False):
        data = data or {}
        credential_id = data.get('credential_id')
        if credential_id:
            row = self.crud.get(int(credential_id))
            if not row:
                raise AgentCredentialError('凭证不存在', 404)
            if not allow_personal:
                self._assert_platform(row)
        probed = self._probe_upstream(data, update_health=False)
        models = probed['models']
        result = {
            'models': models,
            'model_count': len(models),
            'latency_ms': probed['latency_ms'],
        }
        if not models:
            result['message'] = (
                '当前上游接口不支持模型列表，请手动填写'
                if probed.get('model_discovery_supported') is False
                else '上游未提供模型列表，请手动填写'
            )
        return result

    def check(self, credential_id, *, allow_personal=False):
        row = self.crud.get(credential_id)
        if not row:
            raise AgentCredentialError('凭证不存在', 404)
        if not allow_personal:
            self._assert_platform(row)
        probed = self._probe_upstream({'credential_id': credential_id}, update_health=True)
        count = len(probed['models'])
        # 拿不到模型列表，或者这条协议的模型列表本来就不能证明对话端点可用
        # （Anthropic 侧 /models 与 /v1/messages 未必同源），都不能据此判定健康。
        if probed.get('model_discovery_supported') is False or probed.get('verified') is False:
            self.crud.mark_checked(row, probed.get('latency_ms'))
            if probed.get('model_discovery_supported') is False:
                message = '当前上游接口不提供模型列表，未执行连通性验证；请手动填写模型'
            elif count:
                message = f'已取到 {count} 个模型，但该接口的模型列表不能证明对话端点可用，未标记健康'
            else:
                message = '上游未返回模型列表，未执行连通性验证；请手动填写模型'
            return {
                'ok': False,
                'verified': False,
                'latency_ms': probed['latency_ms'],
                'health_status': row.health_status or 'unknown',
                'model_count': count,
                'message': message,
            }
        result = {
            'ok': True,
            'verified': True,
            'latency_ms': probed['latency_ms'],
            'health_status': 'healthy',
            'model_count': count,
        }
        if not count:
            result['message'] = '连接已到达上游，但未返回模型列表'
        return result

    def probe_stale_credentials(self, *, limit=None, quiet_seconds=None):
        """主动探活异常/冷却/未检测且近期无探测记录的启用账号。

        - 可发现模型：mark_success 满血复位（连冷却一起解除），恢复不必等真实流量或冷却到期。
        - 不支持模型发现：只记录探测时间，保留 unknown/cooldown 等原状态。
        - 其它失败：软记账（checked=True），只刷新观测时间，不延长任何硬惩罚窗口。
        返回逐条结果与汇总计数，供后台定时器和手动触发共用。
        """
        cfg = current_app.config
        if limit is None:
            limit = int(cfg.get('AGENT_CREDENTIAL_PROBE_BATCH_LIMIT', 5) or 5)
        if quiet_seconds is None:
            quiet_seconds = int(cfg.get('AGENT_CREDENTIAL_PROBE_QUIET_SECONDS', 600) or 600)
        rows = self.crud.probe_candidates(quiet_seconds=quiet_seconds, limit=limit)
        results = []
        for row in rows:
            # 用探测开始时刻参与乐观并发判断：探测期间出现的真实流量观测
            # 更新更晚，必须保留，不能被这次后台探测结果覆盖。
            observed_at = datetime.utcnow()
            try:
                probed = self._probe_upstream({'credential_id': row.id}, update_health=False)
                if (probed.get('model_discovery_supported') is False
                        or probed.get('verified') is False):
                    self.crud.mark_checked(row, probed.get('latency_ms'))
                    results.append({
                        'id': row.id, 'name': row.name, 'scope': row.scope or 'platform',
                        'ok': False, 'verified': False, 'model_count': 0,
                        'message': '当前上游接口不提供模型列表，未验证账号状态',
                    })
                    continue
                self.crud.mark_success(
                    row, probed.get('latency_ms'), checked=True, observed_at=observed_at,
                )
                results.append({
                    'id': row.id, 'name': row.name, 'scope': row.scope or 'platform',
                    'ok': True, 'model_count': len(probed.get('models') or []),
                })
            except Exception as exc:
                message = getattr(exc, 'message', None) or str(exc)
                # 环境异常（无 app 上下文等）也要留在 results 里并按失败软记账。
                try:
                    self.crud.mark_failure(
                        row, f'定时探测失败：{message}',
                        checked=True, observed_at=observed_at, soft=True,
                    )
                except Exception:
                    pass
                results.append({
                    'id': row.id, 'name': row.name, 'scope': row.scope or 'platform',
                    'ok': False, 'error': message,
                })
        return {
            'probed': len(results),
            'recovered': sum(1 for item in results if item['ok'] and item.get('verified', True)),
            'still_failing': sum(1 for item in results if not item['ok'] and item.get('verified', True)),
            'unverified': sum(1 for item in results if item.get('verified') is False),
            'items': results,
        }

    def _probe_upstream(self, data, *, update_health):
        data = data or {}
        credential_id = data.get('credential_id')
        row = self.crud.get(int(credential_id)) if credential_id else None
        if credential_id and not row:
            raise AgentCredentialError('凭证不存在', 404)
        raw_key = str(data.get('api_key') or '').strip()
        draft_probe = bool(raw_key)
        if row and not draft_probe:
            self._assert_saved_probe_unchanged(data, row)
            base_url = row.base_url.rstrip('/')
            raw_key = self.secret(row)
            provider = row.provider
            upstream_protocol = credential_upstream_protocol(row)
            timeout = row.request_timeout_seconds
        else:
            base_url = str(data.get('base_url') or '').strip().rstrip('/')
            provider = str(data.get('provider') or '').strip() or self._infer_provider(base_url)
            upstream_protocol = str(data.get('upstream_protocol') or UPSTREAM_OPENAI_CHAT).strip().lower()
            timeout = data.get('request_timeout_seconds') or 30
        proxy_url = self.proxy_secret(row) if row else None
        if 'proxy_url' in data:
            try:
                proxy_url = normalize_proxy_url(data.get('proxy_url'))
            except AgentValidationError as exc:
                raise AgentCredentialError(str(exc)) from exc
        if not base_url:
            raise AgentCredentialError('请先填写 Base URL')
        if not raw_key:
            raise AgentCredentialError('请先填写 API Key')
        try:
            adapter = get_provider_adapter(provider)
            adapter.assert_available()
        except ProviderAdapterError as exc:
            raise AgentCredentialError(exc.message, exc.status_code) from exc
        timeout = int(timeout or 30)
        timeout = min(60, max(5, timeout))
        protocol_meta = UPSTREAM_PROTOCOLS.get(upstream_protocol)
        if protocol_meta and not protocol_meta.get('model_discovery', True):
            return {
                'models': [],
                'latency_ms': 0,
                'model_discovery_supported': False,
            }
        observed_at = datetime.utcnow()
        started = time.time()
        try:
            extra_headers = {}
            if row and not draft_probe and 'extra_headers' not in data:
                extra_headers = row.extra_headers() if hasattr(row, 'extra_headers') else {}
            elif 'extra_headers' in data:
                # 编辑已保存账号时，探测按钮应使用当前表单值，而不是数据库里的旧 Header。
                # 这样刚填写的 User-Agent 无需先保存就能参与 /models 探测；显式传空对象也能清空旧 Header。
                extra_headers = normalize_extra_headers(data)
            models = adapter.discover_models(
                base_url=base_url, api_key=raw_key, timeout=timeout,
                extra_headers=extra_headers or None,
                proxy_url=proxy_url,
            )
            latency_ms = int((time.time() - started) * 1000)
            verifies_health = not protocol_meta or protocol_meta.get(
                'model_discovery_verifies_health', True,
            )
            if update_health and row and not draft_probe and verifies_health:
                self.crud.mark_success(row, latency_ms, checked=True, observed_at=observed_at)
            return {
                'models': models,
                'latency_ms': latency_ms,
                'row': row,
                'model_discovery_supported': True,
                'verified': verifies_health,
            }
        except (AgentCredentialError, ProviderAdapterError) as exc:
            verifies_health = not protocol_meta or protocol_meta.get(
                'model_discovery_verifies_health', True,
            )
            if update_health and row and not draft_probe and verifies_health:
                self.mark_failure(row, str(exc), checked=True, observed_at=observed_at)
            if isinstance(exc, ProviderAdapterError):
                raise AgentCredentialError(exc.message, exc.status_code) from exc
            raise
        except requests.RequestException as exc:
            message = f'上游连接失败：{exc}'
            verifies_health = not protocol_meta or protocol_meta.get(
                'model_discovery_verifies_health', True,
            )
            if update_health and row and not draft_probe and verifies_health:
                self.mark_failure(row, message, checked=True, observed_at=observed_at)
            raise AgentCredentialError(message, 502) from exc

    @staticmethod
    def _assert_saved_probe_unchanged(data, row):
        """使用已保存密钥探测时，目标与 Provider 必须来自同一条凭据。"""
        submitted_base = str(data.get('base_url') or '').strip().rstrip('/')
        if submitted_base and submitted_base != row.base_url.rstrip('/'):
            raise AgentCredentialError('测试已保存 Key 时不能覆盖 Base URL；请先保存修改或填写新 Key')
        submitted_protocol = str(data.get('upstream_protocol') or '').strip()
        if submitted_protocol and submitted_protocol != credential_upstream_protocol(row):
            raise AgentCredentialError('测试已保存 Key 时不能切换上游接口；请先保存修改或填写新 Key')

    def mark_success(self, row, latency_ms=None, *, observed_at=None):
        if getattr(row, 'id', None) is not None:
            self.crud.mark_success(row, latency_ms, observed_at=observed_at)

    def mark_failure(self, row, message, *, checked=False, observed_at=None, immediate=False, soft=False):
        if getattr(row, 'id', None) is not None:
            if soft:
                # 软记账：只留观测痕迹，不进硬阈值，不设冷却。
                # 与 immediate 互斥（fatal 错误必须硬冷却）；当前调用方不会同时传两者，
                # 若同传以 soft 为先——有需要再改成显式断言。
                self.crud.mark_failure(
                    row, message, checked=checked, observed_at=observed_at, soft=True,
                )
                return
            threshold = 1 if immediate else current_app.config.get('AGENT_CREDENTIAL_FAILURE_THRESHOLD', 3)
            cooldown_seconds = int(current_app.config.get('AGENT_CREDENTIAL_COOLDOWN_SECONDS', 60) or 60)
            if immediate:
                cooldown_seconds = max(cooldown_seconds, FATAL_CREDENTIAL_COOLDOWN_SECONDS)
            self.crud.mark_failure(
                row, message,
                threshold=threshold,
                cooldown_seconds=cooldown_seconds,
                checked=checked, observed_at=observed_at,
            )

    @staticmethod
    def _env_fallback():
        cfg = current_app.config
        key = (cfg.get('AGENT_LLM_KEY') or cfg.get('AI_API_KEY') or '').strip()
        base = (cfg.get('AGENT_LLM_BASE') or cfg.get('AI_API_BASE') or '').strip().rstrip('/')
        model = (cfg.get('AGENT_LLM_MODEL') or cfg.get('AI_MODEL') or '').strip()
        # 环境变量回退也必须显式给出模型，避免网关在未配置时偷偷猜一个
        # Provider 的历史默认值。
        if not key or not base or not model:
            return None
        return SimpleNamespace(
            id=None, api_key=key, base_url=base, default_model=model, name='env-fallback',
            provider='openai-compatible', priority=0, weight=1, request_timeout_seconds=120,
            upstream_protocol='openai-chat',
        )

    def touch(self, credential):
        if credential and getattr(credential, 'id', None) is not None:
            try:
                self.crud.touch(credential)
            except Exception:
                pass
