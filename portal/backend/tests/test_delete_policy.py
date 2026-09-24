from types import SimpleNamespace

import pytest

from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete


@pytest.mark.parametrize(
    ('item', 'expected'),
    [
        (SimpleNamespace(), False),
        (SimpleNamespace(enabled=True), True),
        (SimpleNamespace(enabled=False), False),
        (SimpleNamespace(is_active=True), True),
        (SimpleNamespace(is_active=False), False),
        (SimpleNamespace(is_active=None), True),
        (SimpleNamespace(enabled=False, is_active=True), True),
    ],
)
def test_is_enabled_for_delete_supports_legacy_active_field_names(item, expected):
    assert is_enabled_for_delete(item) is expected


def test_enabled_delete_message_is_actionable():
    assert enabled_delete_message('模型账号') == '启用中的模型账号不能删除，请先停用后再删除'
