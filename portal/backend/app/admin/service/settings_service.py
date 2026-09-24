# -*- coding: utf-8 -*-
"""系统设置 service 层"""

from backend.app.admin.crud.settings_crud import SettingsCRUD
from backend.app.admin.schema.settings_schema import (
    DESKTOP_UPDATE_KEYS,
    SITE_DOWNLOAD_FIELD_MAP,
    SITE_DOWNLOAD_KEYS,
    SettingsSchemaError,
    WEB_SEARCH_KEY_PLACEHOLDER,
    WEB_SEARCH_KEYS,
    validate_desktop_update_payload,
    validate_site_download_payload,
    validate_web_search_payload,
)
from backend.app.agent.service.credential_crypto import decrypt_secret, encrypt_secret


class SettingsServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


# 配置项中文说明（入库 description）
DESKTOP_UPDATE_DESCRIPTIONS = {
    'AGENT_DESKTOP_RELEASE_API_BASE': '平台版本平台地址（平台模式必填）',
    'AGENT_DESKTOP_RELEASE_IDENTIFIER': '桌面端应用标识',
    'AGENT_DESKTOP_RELEASE_TEMPLATE': '版本平台输出模板名',
    'AGENT_DESKTOP_UPDATE_URL': '静态更新目录地址（备用模式）',
}

# 数据库键 → 前端字段名
DESKTOP_UPDATE_FIELD_MAP = {
    'AGENT_DESKTOP_RELEASE_API_BASE': 'release_api_base',
    'AGENT_DESKTOP_RELEASE_IDENTIFIER': 'release_identifier',
    'AGENT_DESKTOP_RELEASE_TEMPLATE': 'release_template',
    'AGENT_DESKTOP_UPDATE_URL': 'update_url',
}

# 产品站下载配置项中文说明（入库 description）
SITE_DOWNLOAD_DESCRIPTIONS = {
    'SITE_DOWNLOAD_MAC_DMG': '产品站 macOS 安装包下载地址',
    'SITE_DOWNLOAD_MAC_ZIP': '产品站 macOS 压缩包下载地址',
    'SITE_DOWNLOAD_WINDOWS_EXE': '产品站 Windows 安装包下载地址',
    'SITE_DOWNLOAD_CLI_NPM': '产品站 CLI npm 页面地址',
}


def resolve_site_download_settings(env_config, db=None, models=None):
    """数据库优先合并产品站下载配置，返回以数据库键为键的字典。

    已保存的配置项（含空值，空值视为显式未配置）覆盖环境变量；
    未保存的配置项回退到环境变量。
    """
    merged = dict(env_config or {})
    app_setting_model = (models or {}).get('AppSetting')
    stored = {}
    if db is not None and app_setting_model is not None:
        try:
            rows = app_setting_model.query.all()
        except Exception:
            rows = []
        stored = {row.key: (row.value or '') for row in rows if row.key in SITE_DOWNLOAD_KEYS}
    for key in SITE_DOWNLOAD_KEYS:
        if key in stored:
            merged[key] = stored[key]
    return merged


def get_site_download_effective_config(env_config, db=None, models=None):
    """产品站下载配置的对外只读视图（camelCase 字段，数据库优先，环境变量兜底）"""
    merged = resolve_site_download_settings(env_config, db, models)
    return {field: (merged.get(key) or '') for field, key in SITE_DOWNLOAD_FIELD_MAP.items()}


def resolve_desktop_update_settings(env_config, db=None, models=None):
    """数据库优先合并桌面端更新配置。

    已保存的配置项（含空值，空值视为显式未配置）覆盖环境变量；
    未保存的配置项回退到环境变量。返回完整配置字典副本，
    可直接传给 DesktopReleaseService / build_agent_bootstrap。
    """
    merged = dict(env_config or {})
    app_setting_model = (models or {}).get('AppSetting')
    stored = {}
    if db is not None and app_setting_model is not None:
        try:
            rows = app_setting_model.query.all()
        except Exception:
            rows = []
        stored = {row.key: (row.value or '') for row in rows if row.key in DESKTOP_UPDATE_KEYS}
    for key in DESKTOP_UPDATE_KEYS:
        if key in stored:
            merged[key] = stored[key]
    return merged


class SettingsService:
    def __init__(self, db, app_setting_model):
        self.db = db
        self.AppSetting = app_setting_model
        self.crud = SettingsCRUD(db, app_setting_model)

    def desktop_update_settings(self, env_config):
        """当前生效的桌面端更新配置（数据库优先，环境变量兜底）"""
        merged = resolve_desktop_update_settings(env_config, self.db, {'AppSetting': self.AppSetting})
        return {
            'release_api_base': merged.get('AGENT_DESKTOP_RELEASE_API_BASE') or '',
            'release_identifier': merged.get('AGENT_DESKTOP_RELEASE_IDENTIFIER') or '',
            'release_template': merged.get('AGENT_DESKTOP_RELEASE_TEMPLATE') or 'electron.json',
            'update_url': merged.get('AGENT_DESKTOP_UPDATE_URL') or '',
        }

    def update_desktop_update_settings(self, payload):
        """校验并保存桌面端更新配置，保存后立即生效（无需重启）"""
        try:
            values = validate_desktop_update_payload(payload)
        except SettingsSchemaError as e:
            raise SettingsServiceError(e.message, 400)

        base = values['AGENT_DESKTOP_RELEASE_API_BASE']
        identifier = values['AGENT_DESKTOP_RELEASE_IDENTIFIER']
        if bool(base) != bool(identifier):
            raise SettingsServiceError('平台模式需同时填写版本平台地址与应用标识，或两者同时留空', 400)

        for key in DESKTOP_UPDATE_KEYS:
            self.crud.upsert(key, values[key], DESKTOP_UPDATE_DESCRIPTIONS.get(key))
        self.db.session.commit()

        # 四个键均已入库，直接按库中值返回当前生效配置
        return self.desktop_update_settings({})

    def web_search_settings(self, env_config):
        """当前生效的网页搜索后端配置（数据库优先，环境变量兜底）。

        永远不回显 API Key：前端只拿到掩码和「是否已配置」，
        提交时原样传回掩码即表示保持不变。
        """
        merged = resolve_web_search_settings(
            env_config, self.db, {'AppSetting': self.AppSetting},
        )
        raw_key = str(merged.get('AGENT_WEBSEARCH_API_KEY') or '').strip()
        return {
            'provider': str(merged.get('AGENT_WEBSEARCH_PROVIDER') or '').strip().lower(),
            'api_key': WEB_SEARCH_KEY_PLACEHOLDER if raw_key else '',
            'has_api_key': bool(raw_key),
            'proxy_url': str(merged.get('AGENT_WEBSEARCH_PROXY_URL') or '').strip(),
            'timeout_seconds': str(merged.get('AGENT_WEBSEARCH_TIMEOUT_SECONDS') or '').strip(),
        }

    def update_web_search_settings(self, payload, env_config=None):
        """校验并保存网页搜索后端配置，保存后立即生效（无需重启）。"""
        try:
            values = validate_web_search_payload(payload)
        except SettingsSchemaError as e:
            raise SettingsServiceError(e.message, 400)

        new_key = values.pop('AGENT_WEBSEARCH_API_KEY')
        for key, value in values.items():
            self.crud.upsert(key, value, WEB_SEARCH_DESCRIPTIONS.get(key))
        if new_key is not None:
            # 与上游凭据一致：只存密文，明文不落库也不回显。
            stored = encrypt_secret(new_key) if new_key else ''
            self.crud.upsert(
                'AGENT_WEBSEARCH_API_KEY', stored,
                WEB_SEARCH_DESCRIPTIONS['AGENT_WEBSEARCH_API_KEY'],
            )
        self.db.session.commit()
        return self.web_search_settings(env_config or {})

    def test_web_search_settings(self, env_config):
        """用当前生效的配置真打一次搜索，确认 Key 和网络可用。"""
        from backend.app.agent.service.search_providers import (
            SearchProviderError, build_search_provider,
        )
        merged = resolve_web_search_settings(
            env_config, self.db, {'AppSetting': self.AppSetting},
        )
        provider = build_search_provider(merged)
        if provider is None:
            raise SettingsServiceError('尚未配置搜索后端或 API Key', 400)
        try:
            sources = provider.search('coati coding agent gateway', limit=3)
        except SearchProviderError as e:
            raise SettingsServiceError(e.message, e.status_code)
        return {
            'ok': True,
            'provider': provider.code,
            'result_count': len(sources),
            'sample': [s.get('url') for s in sources[:3]],
        }

    def site_download_settings(self, env_config):
        """当前生效的产品站下载配置（数据库优先，环境变量兜底）"""
        return get_site_download_effective_config(
            env_config, self.db, {'AppSetting': self.AppSetting}
        )

    def update_site_download_settings(self, payload):
        """校验并保存产品站下载配置，保存后立即生效（无需重启）"""
        try:
            values = validate_site_download_payload(payload)
        except SettingsSchemaError as e:
            raise SettingsServiceError(e.message, 400)

        for key in SITE_DOWNLOAD_KEYS:
            self.crud.upsert(key, values[key], SITE_DOWNLOAD_DESCRIPTIONS.get(key))
        self.db.session.commit()

        return self.site_download_settings({})


# 网页搜索后端配置项中文说明（入库 description）
WEB_SEARCH_DESCRIPTIONS = {
    'AGENT_WEBSEARCH_PROVIDER': '网页搜索后端（留空表示不启用，回退委托模型账号）',
    'AGENT_WEBSEARCH_API_KEY': '搜索后端 API Key（密文存储）',
    'AGENT_WEBSEARCH_PROXY_URL': '搜索后端出站代理（可选）',
    'AGENT_WEBSEARCH_TIMEOUT_SECONDS': '搜索请求超时秒数',
}


def resolve_web_search_settings(env_config, db=None, models=None):
    """数据库优先合并网页搜索后端配置。

    已保存的配置项（含空值，空值视为显式未配置）覆盖环境变量。
    """
    merged = dict(env_config or {})
    app_setting_model = (models or {}).get('AppSetting')
    stored = {}
    if db is not None and app_setting_model is not None:
        try:
            rows = app_setting_model.query.all()
        except Exception:
            rows = []
        stored = {row.key: (row.value or '') for row in rows if row.key in WEB_SEARCH_KEYS}
    for key in WEB_SEARCH_KEYS:
        if key in stored:
            merged[key] = stored[key]
    return merged
