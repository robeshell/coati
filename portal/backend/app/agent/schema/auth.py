"""PAT 与设备授权输入校验。"""

from .common import AgentValidationError, integer, text

PAT_TYPES = {'personal'}
PAT_SCOPES = {'chat', 'profile'}


def normalize_pat_payload(data):
    data = data or {}
    token_type = text(data.get('token_type'), '令牌类型', max_length=20, default='personal')
    if token_type not in PAT_TYPES:
        raise AgentValidationError('令牌类型不合法')
    scopes = data.get('scopes')
    if scopes is None:
        scopes = ['chat', 'profile']
    if not isinstance(scopes, list) or not scopes:
        raise AgentValidationError('至少选择一项令牌权限')
    normalized_scopes = []
    for scope in scopes:
        value = text(scope, '令牌权限', max_length=32)
        if value not in PAT_SCOPES:
            raise AgentValidationError(f'不支持的令牌权限：{value}')
        if value not in normalized_scopes:
            normalized_scopes.append(value)
    return {
        'name': text(data.get('name'), '令牌名称', max_length=100, default='default'),
        'token_type': token_type,
        'scopes': normalized_scopes,
        'note': text(data.get('note'), '备注', max_length=255),
        'expires_days': integer(data.get('expires_days'), '有效期', minimum=1, maximum=3650),
    }


def normalize_pat_update_payload(data):
    """校验 API Key 编辑字段，不接受密钥、权限等不可编辑字段。"""
    data = data or {}
    return {
        'name': text(data.get('name'), '令牌名称', required=True, max_length=100),
        'expires_days': integer(data.get('expires_days'), '有效期', minimum=1, maximum=3650),
    }


def normalize_user_code(value):
    code = text(value, '用户码', required=True, max_length=32)
    return code.upper()


__all__ = [
    'AgentValidationError', 'normalize_pat_payload', 'normalize_pat_update_payload',
    'normalize_user_code',
]
