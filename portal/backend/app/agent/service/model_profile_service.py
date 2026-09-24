"""统一模型能力档案业务服务。"""

from backend.app.agent.crud import AgentCredentialCRUD, AgentModelProfileCRUD, AgentRouteCRUD
from backend.app.agent.schema.common import AgentValidationError, boolean
from backend.app.agent.schema.model_profile import normalize_model_profile_payload
from backend.app.agent.service.model_profile_catalog import (
    DEFAULT_CONTEXT_WINDOW,
    DEFAULT_MAX_OUTPUT_TOKENS,
    LiteLLMModelCatalog,
)
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete


class AgentModelProfileError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class AgentModelProfileService:
    def __init__(self, db, models):
        self.Profile = models['AgentModelProfile']
        self.crud = AgentModelProfileCRUD(db, models)
        self.credentials = AgentCredentialCRUD(db, models)
        self.routes = AgentRouteCRUD(db, models)
        self.catalog = LiteLLMModelCatalog(db, models)

    def list_items(self, page=1, per_page=20, search=None, enabled=None):
        page = max(1, int(page or 1))
        per_page = min(100, max(1, int(per_page or 20)))
        enabled = None if enabled in (None, '') else boolean(enabled)
        sync = self._sync_safely()
        rows, total = self.crud.page(page, per_page, (search or '').strip() or None, enabled)
        return {
            'items': [row.to_dict() for row in rows],
            'total': total,
            'page': page,
            'per_page': per_page,
            'sync': sync,
        }

    def _sync_safely(self, model_names=None, *, force=False):
        try:
            return self.catalog.sync(model_names, force=force)
        except Exception as exc:  # 外部目录和自动物化不能阻塞管理员页面或网关启动
            self.catalog.reset_transaction()
            return {
                'status': 'error',
                'message': f'LiteLLM 同步失败：{exc}',
                'matched_count': 0,
                'created_count': 0,
                'updated_count': 0,
                'missing_models': [],
            }

    def sync(self, *, force=False, model_names=None):
        return self._sync_safely(model_names, force=force)

    def candidates(self, search=None):
        """返回账号/路由中已出现的模型名，供统一配置页选择。"""
        values = set()
        for row in self.credentials.list_all():
            values.update(row.supported_models())
        for row in self.routes.list_all():
            values.update(item for item in (row.model_name, row.upstream_model, row.vision_model) if item)
        configured = {row.model_name for row in self.crud.list_all()}
        needle = (search or '').strip().lower()
        return {
            'items': sorted(
                model for model in values | configured
                if not needle or needle in model.lower()
            )[:200],
        }

    def create(self, data):
        try:
            payload = normalize_model_profile_payload(data)
        except AgentValidationError as exc:
            raise AgentModelProfileError(str(exc)) from exc
        if self.crud.get_by_model(payload['model_name']):
            raise AgentModelProfileError('该模型已经配置能力档案', 409)

        # The legacy field names are treated as explicit overrides. New clients
        # use nullable *_override fields so an empty value follows LiteLLM.
        context_override = payload.pop(
            'context_window_override', payload.pop('context_window', None),
        )
        output_override = payload.pop(
            'max_output_tokens_override', payload.pop('max_output_tokens', None),
        )
        row = self.Profile(
            **payload,
            context_window=DEFAULT_CONTEXT_WINDOW,
            max_output_tokens=DEFAULT_MAX_OUTPUT_TOKENS,
            context_window_override=context_override,
            max_output_tokens_override=output_override,
        )
        self.catalog.apply_effective_values(row)
        self.crud.add(row)
        self._sync_safely([row.model_name])
        return row.to_dict()

    def update(self, profile_id, data):
        row = self.crud.get(profile_id)
        if not row:
            raise AgentModelProfileError('模型能力档案不存在', 404)
        try:
            payload = normalize_model_profile_payload(data, partial=True)
        except AgentValidationError as exc:
            raise AgentModelProfileError(str(exc)) from exc
        duplicate = self.crud.get_by_model(payload.get('model_name')) if payload.get('model_name') else None
        if duplicate and duplicate.id != row.id:
            raise AgentModelProfileError('该模型已经配置能力档案', 409)

        if 'context_window' in payload:
            payload['context_window_override'] = payload.pop('context_window')
        if 'max_output_tokens' in payload:
            payload['max_output_tokens_override'] = payload.pop('max_output_tokens')
        for field, value in payload.items():
            setattr(row, field, value)
        self.catalog.apply_effective_values(row)
        self.crud.commit()
        self._sync_safely([row.model_name])
        return row.to_dict()

    def delete(self, profile_id):
        row = self.crud.get(profile_id)
        if not row:
            raise AgentModelProfileError('模型能力档案不存在', 404)
        if is_enabled_for_delete(row):
            raise AgentModelProfileError(enabled_delete_message('模型能力档案'), 409)
        self.crud.delete(row)
        return {'ok': True}
