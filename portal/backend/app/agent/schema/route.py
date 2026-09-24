"""模型路由输入校验。"""

from .common import AgentValidationError, boolean, http_url, integer, text


def normalize_route_payload(data, *, partial=False):
    data = data or {}
    out = {}
    if not partial or 'model_name' in data:
        out['model_name'] = text(data.get('model_name'), '模型名称', required=True, max_length=128)
    if not partial or 'upstream_base' in data:
        out['upstream_base'] = http_url(data.get('upstream_base'), '上游地址')
    if not partial or 'upstream_model' in data:
        out['upstream_model'] = text(data.get('upstream_model'), '上游模型', max_length=128)
    if not partial or 'vision_model' in data:
        out['vision_model'] = text(data.get('vision_model'), '含图时模型', max_length=128)
    if not partial or 'credential_id' in data:
        out['credential_id'] = integer(data.get('credential_id'), '上游凭证', minimum=1)
    if not partial or 'description' in data:
        out['description'] = text(data.get('description'), '路由说明', max_length=255)
    if not partial or 'fallback_enabled' in data:
        out['fallback_enabled'] = boolean(data.get('fallback_enabled'), False)
    if not partial or 'enabled' in data:
        out['enabled'] = boolean(data.get('enabled'), True)
    return out


__all__ = ['AgentValidationError', 'normalize_route_payload']
