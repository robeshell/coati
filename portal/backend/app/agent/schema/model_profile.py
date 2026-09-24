"""统一模型能力档案输入校验。"""

from .common import AgentValidationError, boolean, integer, text


def normalize_model_profile_payload(data, *, partial=False):
    data = data or {}
    out = {}
    if not partial or 'model_name' in data:
        out['model_name'] = text(
            data.get('model_name'), '模型名称', required=True, max_length=128,
        )
    # New clients send nullable override fields. Keep accepting the old field
    # names as administrator overrides so older portal clients remain safe.
    if 'context_window_override' in data:
        out['context_window_override'] = integer(
            data.get('context_window_override'), '上下文窗口覆盖值',
            minimum=1, maximum=1_000_000,
        )
    elif not partial or 'context_window' in data:
        out['context_window'] = integer(
            data.get('context_window'), '上下文窗口',
            minimum=1, maximum=1_000_000, default=131072,
        )
    if 'max_output_tokens_override' in data:
        out['max_output_tokens_override'] = integer(
            data.get('max_output_tokens_override'), '最大输出 Token 覆盖值',
            minimum=1, maximum=1_000_000,
        )
    elif not partial or 'max_output_tokens' in data:
        out['max_output_tokens'] = integer(
            data.get('max_output_tokens'), '最大输出 Token',
            minimum=1, maximum=1_000_000, default=8192,
        )
    if not partial or 'enabled' in data:
        out['enabled'] = boolean(data.get('enabled'), True)
    if not partial or 'note' in data:
        out['note'] = text(data.get('note'), '备注', max_length=255)
    return {
        key: value for key, value in out.items()
        if value is not None or key == 'note'
    }


__all__ = ['AgentValidationError', 'normalize_model_profile_payload']
