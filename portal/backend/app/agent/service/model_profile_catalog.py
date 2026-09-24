# -*- coding: utf-8 -*-
"""LiteLLM 模型能力目录同步。

LiteLLM 只作为模型能力的默认来源，匹配结果会落到统一模型能力表；
管理员覆盖值单独保存，因此后续同步不会覆盖人工配置。
"""

import threading
import time
from datetime import datetime

import requests
from flask import current_app

from backend.app.agent.crud import AgentCredentialCRUD, AgentModelProfileCRUD, AgentRouteCRUD


DEFAULT_LITELLM_CATALOG_URL = (
    'https://raw.githubusercontent.com/BerriAI/litellm/main/'
    'model_prices_and_context_window.json'
)
DEFAULT_CONTEXT_WINDOW = 128_000
DEFAULT_MAX_OUTPUT_TOKENS = 8_192
PLATFORM_TOKEN_LIMIT = 1_000_000

_CACHE_LOCK = threading.Lock()
_CATALOG_CACHE = {
    'url': None,
    'payload': None,
    'fetched_at': 0.0,
    'fetched_iso': None,
}


class LiteLLMModelCatalog:
    """读取、缓存并将 LiteLLM 能力物化为平台统一模型档案。"""

    def __init__(self, db, models):
        self.Profile = models['AgentModelProfile']
        self.profiles = AgentModelProfileCRUD(db, models)
        self.credentials = AgentCredentialCRUD(db, models)
        self.routes = AgentRouteCRUD(db, models)

    @staticmethod
    def _positive_int(value, fallback=None):
        if value in (None, ''):
            return fallback
        try:
            number = int(value)
        except (TypeError, ValueError):
            return fallback
        return number if number > 0 else fallback

    @classmethod
    def _token_value(cls, value):
        """兼容 LiteLLM 中的整数和 128K/1M 形式。"""
        if isinstance(value, str):
            text = value.strip().lower().replace(',', '')
            multiplier = 1
            if text.endswith('k'):
                multiplier = 1_000
                text = text[:-1]
            elif text.endswith('m'):
                multiplier = 1_000_000
                text = text[:-1]
            try:
                value = float(text) * multiplier
            except (TypeError, ValueError):
                return None
        try:
            number = int(value)
        except (TypeError, ValueError):
            return None
        if number <= 0:
            return None
        return min(number, PLATFORM_TOKEN_LIMIT)

    @staticmethod
    def _enabled():
        raw = current_app.config.get('AGENT_LITELLM_AUTO_SYNC_ENABLED', True)
        if isinstance(raw, bool):
            return raw
        return str(raw).strip().lower() not in ('0', 'false', 'no', 'off')

    @staticmethod
    def _model_names_from_database(catalog):
        values = set()
        for row in catalog.credentials.list_all():
            values.update(row.supported_models())
        for row in catalog.routes.list_all():
            values.update(
                str(value).strip() for value in (
                    row.model_name, row.upstream_model, row.vision_model,
                ) if str(value or '').strip()
            )
        values.update(row.model_name for row in catalog.profiles.list_all())
        return sorted(values)

    @classmethod
    def _parse_entry(cls, value):
        if not isinstance(value, dict):
            return None
        context_window = cls._token_value(
            value.get('max_input_tokens')
            or value.get('context_window')
            or value.get('max_context_window')
            or value.get('max_tokens')
        )
        max_output_tokens = cls._token_value(
            value.get('max_output_tokens')
            or value.get('max_completion_tokens')
        )
        if context_window is None and max_output_tokens is None:
            return None
        return {
            'context_window': context_window,
            'max_output_tokens': max_output_tokens,
        }

    @classmethod
    def _lookup(cls, payload, model_name):
        if not isinstance(payload, dict):
            return None, None
        exact = payload.get(model_name)
        if exact is not None:
            return model_name, cls._parse_entry(exact)
        lowered = model_name.lower()
        matches = [key for key in payload if str(key).lower() == lowered]
        if len(matches) == 1:
            key = matches[0]
            return key, cls._parse_entry(payload[key])
        return None, None

    def _fetch_catalog(self, force=False):
        if not self._enabled():
            return {}, {'status': 'disabled', 'message': 'LiteLLM 自动同步已关闭'}
        if current_app.config.get('TESTING') and not current_app.config.get('AGENT_LITELLM_SYNC_IN_TESTS', False):
            return {}, {'status': 'disabled', 'message': '测试环境默认不访问外部 LiteLLM 数据源'}

        url = str(current_app.config.get('AGENT_LITELLM_MODEL_CATALOG_URL') or DEFAULT_LITELLM_CATALOG_URL).strip()
        ttl = self._positive_int(
            current_app.config.get('AGENT_LITELLM_SYNC_INTERVAL_SECONDS'),
            86_400,
        )
        now = time.monotonic()
        with _CACHE_LOCK:
            if (
                not force
                and _CATALOG_CACHE['url'] == url
                and _CATALOG_CACHE['payload'] is not None
                and now - _CATALOG_CACHE['fetched_at'] < ttl
            ):
                return _CATALOG_CACHE['payload'], {
                    'status': 'ok',
                    'cached': True,
                    'fetched_at': _CATALOG_CACHE['fetched_iso'],
                }

            timeout = self._positive_int(
                current_app.config.get('AGENT_LITELLM_SYNC_TIMEOUT_SECONDS'),
                10,
            )
            try:
                response = requests.get(url, timeout=timeout)
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError('LiteLLM 数据不是 JSON 对象')
            except (requests.RequestException, ValueError, TypeError) as exc:
                stale = _CATALOG_CACHE['payload'] if _CATALOG_CACHE['url'] == url else None
                return stale or {}, {
                    'status': 'error',
                    'cached': bool(stale),
                    'message': f'LiteLLM 同步失败：{exc}',
                    'fetched_at': _CATALOG_CACHE['fetched_iso'] if stale else None,
                }

            fetched_iso = datetime.utcnow().isoformat(timespec='seconds') + 'Z'
            _CATALOG_CACHE.update({
                'url': url,
                'payload': payload,
                'fetched_at': now,
                'fetched_iso': fetched_iso,
            })
            return payload, {'status': 'ok', 'cached': False, 'fetched_at': fetched_iso}

    def reset_transaction(self):
        self.profiles.rollback()

    @staticmethod
    def apply_effective_values(row):
        context = (
            row.context_window_override
            or row.litellm_context_window
            or row.context_window
            or DEFAULT_CONTEXT_WINDOW
        )
        output = (
            row.max_output_tokens_override
            or row.litellm_max_output_tokens
            or row.max_output_tokens
            or DEFAULT_MAX_OUTPUT_TOKENS
        )
        row.context_window = min(int(context), PLATFORM_TOKEN_LIMIT)
        row.max_output_tokens = min(int(output), PLATFORM_TOKEN_LIMIT)
        return row

    def sync(self, model_names=None, *, force=False):
        names = sorted({str(name).strip() for name in (model_names or self._model_names_from_database(self)) if str(name).strip()})
        if not names:
            return {'status': 'idle', 'matched_count': 0, 'created_count': 0, 'updated_count': 0, 'missing_models': []}

        payload, fetch_info = self._fetch_catalog(force=force)
        if fetch_info['status'] == 'disabled':
            return {**fetch_info, 'matched_count': 0, 'created_count': 0, 'updated_count': 0, 'missing_models': names}

        matched_count = 0
        created_count = 0
        updated_count = 0
        missing = []
        changed = False
        for model_name in names:
            matched_name, spec = self._lookup(payload, model_name)
            if not spec:
                missing.append(model_name)
                continue
            matched_count += 1
            row = self.profiles.get_by_model(model_name)
            if not row:
                row = self.Profile(
                    model_name=model_name,
                    context_window=DEFAULT_CONTEXT_WINDOW,
                    max_output_tokens=DEFAULT_MAX_OUTPUT_TOKENS,
                    enabled=True,
                )
                self.profiles.add_pending(row)
                created_count += 1
                changed = True

            before = (
                row.litellm_model_name,
                row.litellm_context_window,
                row.litellm_max_output_tokens,
                row.context_window,
                row.max_output_tokens,
            )
            row.litellm_model_name = str(matched_name)
            row.litellm_context_window = spec['context_window']
            row.litellm_max_output_tokens = spec['max_output_tokens']
            row.litellm_synced_at = datetime.utcnow()
            self.apply_effective_values(row)
            after = (
                row.litellm_model_name,
                row.litellm_context_window,
                row.litellm_max_output_tokens,
                row.context_window,
                row.max_output_tokens,
            )
            if before != after:
                updated_count += 1
                changed = True

        if changed:
            self.profiles.commit()
        return {
            **fetch_info,
            'matched_count': matched_count,
            'created_count': created_count,
            'updated_count': updated_count,
            'missing_models': missing,
            'model_count': len(payload),
        }


__all__ = ['LiteLLMModelCatalog']
