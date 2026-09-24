# -*- coding: utf-8 -*-
"""系统设置 service 测试：数据库优先合并、环境变量兜底、校验规则"""

from types import SimpleNamespace

import pytest

from backend.app.admin.schema.settings_schema import validate_desktop_update_payload
from backend.app.admin.service.settings_service import (
    SettingsService,
    SettingsServiceError,
    resolve_desktop_update_settings,
)


ENV_CONFIG = {
    'AGENT_DESKTOP_RELEASE_API_BASE': 'https://env.example.com',
    'AGENT_DESKTOP_RELEASE_IDENTIFIER': 'cn.net.coatiode',
    'AGENT_DESKTOP_RELEASE_TEMPLATE': 'electron.json',
    'AGENT_DESKTOP_UPDATE_URL': 'https://env.example.com/updates',
    'AGENT_PUBLIC_API_BASE': 'https://portal.example.com',
}


class FakeAppSetting:
    def __init__(self, rows):
        self.query = SimpleNamespace(all=lambda: rows)


def row(key, value):
    return SimpleNamespace(key=key, value=value)


def test_resolve_env_only_without_db():
    merged = resolve_desktop_update_settings(ENV_CONFIG)
    assert merged == ENV_CONFIG
    # 传入 db/models 为空时同样回退环境变量
    merged = resolve_desktop_update_settings(ENV_CONFIG, db=object(), models={})
    assert merged == ENV_CONFIG


def test_resolve_db_override_env():
    rows = [
        row('AGENT_DESKTOP_RELEASE_API_BASE', 'https://db.example.com'),
        row('UNRELATED_KEY', 'ignored'),
    ]
    merged = resolve_desktop_update_settings(
        ENV_CONFIG, db=object(), models={'AppSetting': FakeAppSetting(rows)}
    )
    assert merged['AGENT_DESKTOP_RELEASE_API_BASE'] == 'https://db.example.com'
    # 未入库的键回退环境变量
    assert merged['AGENT_DESKTOP_RELEASE_IDENTIFIER'] == 'cn.net.coatiode'
    assert merged['AGENT_DESKTOP_UPDATE_URL'] == 'https://env.example.com/updates'
    # 非桌面键不受影响
    assert merged['AGENT_PUBLIC_API_BASE'] == 'https://portal.example.com'


def test_resolve_db_empty_explicitly_unsets():
    rows = [row('AGENT_DESKTOP_RELEASE_API_BASE', '')]
    merged = resolve_desktop_update_settings(
        ENV_CONFIG, db=object(), models={'AppSetting': FakeAppSetting(rows)}
    )
    assert merged['AGENT_DESKTOP_RELEASE_API_BASE'] == ''
    assert merged['AGENT_DESKTOP_RELEASE_IDENTIFIER'] == 'cn.net.coatiode'


def test_service_effective_settings_camelcase():
    rows = [row('AGENT_DESKTOP_RELEASE_API_BASE', 'https://db.example.com')]
    service = SettingsService(object(), FakeAppSetting(rows))
    effective = service.desktop_update_settings(ENV_CONFIG)
    assert effective == {
        'release_api_base': 'https://db.example.com',
        'release_identifier': 'cn.net.coatiode',
        'release_template': 'electron.json',
        'update_url': 'https://env.example.com/updates',
    }


def test_update_rejects_http_non_loopback():
    service = SettingsService(None, FakeAppSetting([]))
    with pytest.raises(SettingsServiceError) as exc:
        service.update_desktop_update_settings({'release_api_base': 'http://example.com'})
    assert 'HTTPS' in exc.value.message


def test_update_requires_pair_of_base_and_identifier():
    service = SettingsService(None, FakeAppSetting([]))
    with pytest.raises(SettingsServiceError) as exc:
        service.update_desktop_update_settings({
            'release_identifier': 'cn.net.coatiode',
        })
    assert '同时填写' in exc.value.message

    with pytest.raises(SettingsServiceError) as exc:
        service.update_desktop_update_settings({
            'release_api_base': 'https://portal.example.com',
        })
    assert '同时填写' in exc.value.message


def test_update_accepts_static_only_mode():
    # 平台模式两个字段同时留空 = 静态目录模式，schema 校验应通过
    normalized = validate_desktop_update_payload({
        'release_api_base': '',
        'release_identifier': '',
        'release_template': 'electron.json',
        'update_url': ' https://static.example.com/updates ',
    })
    assert normalized['AGENT_DESKTOP_RELEASE_API_BASE'] == ''
    assert normalized['AGENT_DESKTOP_UPDATE_URL'] == 'https://static.example.com/updates'
