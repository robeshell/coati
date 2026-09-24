# -*- coding: utf-8 -*-
"""模型路由业务服务。"""

from urllib.parse import urlsplit

from backend.app.agent.constants import AUTO_ROUTE_MODEL
from backend.app.agent.crud import AgentCredentialCRUD, AgentRouteCRUD
from backend.app.agent.schema.common import AgentValidationError, boolean
from backend.app.agent.schema.route import normalize_route_payload
from backend.app.agent.service.provider_adapters import ProviderAdapterError, get_provider_adapter
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete


class AgentRouteError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class AgentRouteService:
    def __init__(self, db, models):
        self.Route = models['AgentRouteConfig']
        self.crud = AgentRouteCRUD(db, models)
        self.credentials = AgentCredentialCRUD(db, models)

    def list_routes(
        self, page=1, per_page=20, search=None, enabled=None,
        provider=None, credential_id=None, include_summary=False,
    ):
        page = max(1, int(page or 1))
        per_page = min(100, max(1, int(per_page or 20)))
        enabled = None if enabled in (None, '') else boolean(enabled)
        credential_id = int(credential_id) if credential_id not in (None, '') else None
        include_summary = False if include_summary in (None, '') else boolean(include_summary)
        rows, total = self.crud.page(
            page, per_page, (search or '').strip() or None, enabled,
            (provider or '').strip() or None, credential_id,
        )
        credentials = self.crud.credentials_map(rows)
        usage = self.crud.usage_stats(rows)
        items = [self._serialize(row, credentials.get(row.credential_id), usage.get(row.model_name)) for row in rows]
        payload = {'items': items, 'total': total, 'page': page, 'per_page': per_page}
        if include_summary:
            payload['summary'] = self.summary()
        return payload

    def summary(self):
        rows = self.crud.list_all()
        credentials = self.crud.credentials_map(rows)
        attention = sum(
            1 for row in rows
            if self._serialize(row, credentials.get(row.credential_id)).get('readiness') == 'attention'
        )
        return {
            'total': len(rows),
            'enabled': sum(1 for row in rows if row.enabled),
            'disabled': sum(1 for row in rows if not row.enabled),
            'attention': attention,
        }

    @staticmethod
    def _credential_supports_model(credential, model):
        model = (model or '').strip()
        if not model:
            return True
        matcher = getattr(credential, 'matches_model', None)
        if callable(matcher):
            return bool(matcher(model, allow_upstream=True))
        supported_getter = getattr(credential, 'supported_models', None)
        supported = supported_getter() if callable(supported_getter) else []
        return model in (supported or [])

    def _validate_credential(self, credential_id, *, enabled=True, upstream_model=None, vision_model=None):
        credential = self.credentials.get(credential_id) if credential_id else None
        if credential_id and not credential:
            raise AgentRouteError('选择的上游凭证不存在')
        if credential:
            if (
                (getattr(credential, 'scope', None) or 'platform') == 'personal'
                or getattr(credential, 'owner_user_id', None)
            ):
                raise AgentRouteError('个人渠道不能绑定全局模型路由', 422)
            try:
                get_provider_adapter(credential.provider).assert_available()
            except ProviderAdapterError as exc:
                raise AgentRouteError(exc.message, exc.status_code) from exc
            if enabled and not credential.enabled:
                raise AgentRouteError('生效的模型路由不能绑定已停用的模型账号', 422)
            unsupported = [
                ('实际模型', upstream_model),
                ('含图时模型', vision_model),
            ]
            for label, model in unsupported:
                if model and not self._credential_supports_model(credential, model):
                    raise AgentRouteError(
                        f'绑定的模型账号不支持{label}「{model}」，请修改模型配置或更换账号',
                        422,
                    )
        return credential

    @staticmethod
    def _validate_overrides(payload, row=None, credential=None):
        credential_id = payload.get('credential_id', getattr(row, 'credential_id', None))
        upstream_base = payload.get('upstream_base', getattr(row, 'upstream_base', None))
        if upstream_base and not credential_id:
            raise AgentRouteError('覆盖上游地址时必须绑定一把 Key，避免将随机 Key 发往错误服务', 422)
        if upstream_base and credential:
            override = urlsplit(upstream_base)
            original = urlsplit(credential.base_url)
            if (override.scheme, override.hostname, override.port) != (
                original.scheme, original.hostname, original.port,
            ):
                raise AgentRouteError('路由覆盖地址只能调整同一上游域名下的路径；切换域名请修改 Key 配置', 422)

    @staticmethod
    def _validate_auto_route(payload, row=None):
        """自动路由（coati-auto）必须配置明确的纯文本目标（实际模型）。"""
        model_name = (payload.get('model_name') or getattr(row, 'model_name', None) or '').strip()
        if model_name != AUTO_ROUTE_MODEL:
            return
        upstream_model = payload.get('upstream_model', getattr(row, 'upstream_model', None))
        if not upstream_model:
            raise AgentRouteError('自动路由（coati-auto）必须配置「实际模型」作为纯文本目标', 422)

    def _serialize(self, row, credential=None, usage=None):
        data = row.to_dict()
        effective_model = row.upstream_model or row.model_name
        warnings = []
        if credential:
            if not credential.enabled:
                warnings.append('绑定的 Key 已停用')
            if credential.health_status in ('unhealthy', 'cooldown'):
                warnings.append(f'绑定的 Key 当前{credential.health_status}')
            if not self._credential_supports_model(credential, effective_model):
                warnings.append('上游模型不在该 Key 已发现的模型列表中')
            if row.vision_model and not self._credential_supports_model(credential, row.vision_model):
                warnings.append('含图时模型不在该 Key 已发现的模型列表中')
        data.update({
            'credential': {
                'id': credential.id, 'name': credential.name, 'provider': credential.provider,
                'upstream_protocol': credential.upstream_protocol,
                'health_status': credential.health_status, 'enabled': credential.enabled,
            } if credential else None,
            'effective_model': effective_model,
            'effective_base': row.upstream_base or (credential.base_url if credential else None),
            'selection_mode': 'bound' if credential else 'automatic',
            'readiness': 'attention' if warnings else 'ready',
            'warnings': warnings,
            'usage_7d': usage or {'requests': 0, 'tokens': 0, 'last_used_at': None},
        })
        return data

    def create(self, data):
        try:
            payload = normalize_route_payload(data)
        except AgentValidationError as exc:
            raise AgentRouteError(str(exc)) from exc
        if self.crud.get_by_model(payload['model_name']):
            raise AgentRouteError('模型名称已存在', 409)
        self._validate_auto_route(payload)
        credential = self._validate_credential(
            payload.get('credential_id'),
            enabled=payload.get('enabled', True),
            upstream_model=payload.get('upstream_model'),
            vision_model=payload.get('vision_model'),
        )
        self._validate_overrides(payload, credential=credential)
        row = self.Route(**payload)
        self.crud.add(row)
        return row.to_dict()

    def update(self, route_id, data):
        row = self.crud.get(route_id)
        if not row:
            raise AgentRouteError('路由不存在', 404)
        try:
            payload = normalize_route_payload(data, partial=True)
        except AgentValidationError as exc:
            raise AgentRouteError(str(exc)) from exc
        duplicate = self.crud.get_by_model(payload.get('model_name')) if payload.get('model_name') else None
        if duplicate and duplicate.id != row.id:
            raise AgentRouteError('模型名称已存在', 409)
        self._validate_auto_route(payload, row=row)
        effective_enabled = payload.get('enabled', row.enabled)
        effective_credential_id = payload.get('credential_id', row.credential_id)
        credential = self._validate_credential(
            effective_credential_id,
            enabled=effective_enabled,
            upstream_model=payload.get('upstream_model', row.upstream_model),
            vision_model=payload.get('vision_model', row.vision_model),
        )
        self._validate_overrides(payload, row=row, credential=credential)
        for field, value in payload.items():
            setattr(row, field, value)
        self.crud.commit()
        return row.to_dict()

    def upsert(self, data):
        existing = self.crud.get_by_model((data.get('model_name') or '').strip())
        return self.update(existing.id, data) if existing else self.create(data)

    def delete(self, route_id):
        row = self.crud.get(route_id)
        if not row:
            raise AgentRouteError('路由不存在', 404)
        if is_enabled_for_delete(row):
            raise AgentRouteError(enabled_delete_message('模型路由'), 409)
        self.crud.delete(row)
        return {'ok': True}
