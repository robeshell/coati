# -*- coding: utf-8 -*-
"""系统设置 schema 层：字段校验与标准化"""

from urllib.parse import urlsplit


class SettingsSchemaError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


# 桌面端更新配置项（与 config.py 环境变量一一对应）
DESKTOP_UPDATE_KEYS = (
    'AGENT_DESKTOP_RELEASE_API_BASE',
    'AGENT_DESKTOP_RELEASE_IDENTIFIER',
    'AGENT_DESKTOP_RELEASE_TEMPLATE',
    'AGENT_DESKTOP_UPDATE_URL',
)


def normalize_optional_string(value, field_name, max_length):
    if value is None:
        return ''
    text = str(value).strip()
    if len(text) > max_length:
        raise SettingsSchemaError(f'{field_name}长度不能超过 {max_length} 个字符')
    return text


def validate_release_api_base(value):
    """版本平台地址必须为 HTTPS（本机回环地址允许 HTTP）"""
    raw = value.strip().rstrip('/')
    if not raw:
        return ''
    parsed = urlsplit(raw)
    loopback = parsed.hostname in {'localhost', '127.0.0.1', '::1'}
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and loopback):
        raise SettingsSchemaError('版本平台地址必须使用 HTTPS（本机地址除外）')
    if not parsed.netloc or parsed.query or parsed.fragment:
        raise SettingsSchemaError('版本平台地址无效')
    return raw


def validate_desktop_update_payload(payload):
    """校验并标准化桌面端更新配置，返回以环境变量名为键的字典"""
    payload = payload or {}
    return {
        'AGENT_DESKTOP_RELEASE_API_BASE': validate_release_api_base(
            normalize_optional_string(payload.get('release_api_base'), '版本平台地址', 500)
        ),
        'AGENT_DESKTOP_RELEASE_IDENTIFIER': normalize_optional_string(
            payload.get('release_identifier'), '应用标识', 100
        ),
        'AGENT_DESKTOP_RELEASE_TEMPLATE': normalize_optional_string(
            payload.get('release_template'), '输出模板名', 100
        ),
        'AGENT_DESKTOP_UPDATE_URL': normalize_optional_string(
            payload.get('update_url'), '静态更新目录地址', 500
        ),
    }


# 产品站下载配置项（与 site/ 的 window.COATI_SITE_CONFIG.downloads 字段一一对应）
SITE_DOWNLOAD_KEYS = (
    'SITE_DOWNLOAD_MAC_DMG',
    'SITE_DOWNLOAD_MAC_ZIP',
    'SITE_DOWNLOAD_WINDOWS_EXE',
    'SITE_DOWNLOAD_CLI_NPM',
)

# API 字段名（camelCase，产品站 site.js 使用） → 数据库键
SITE_DOWNLOAD_FIELD_MAP = {
    'macDmg': 'SITE_DOWNLOAD_MAC_DMG',
    'macZip': 'SITE_DOWNLOAD_MAC_ZIP',
    'windowsExe': 'SITE_DOWNLOAD_WINDOWS_EXE',
    'cliNpm': 'SITE_DOWNLOAD_CLI_NPM',
}

# API 字段名 → 中文名（用于校验报错提示）
SITE_DOWNLOAD_LABELS = {
    'macDmg': 'macOS 安装包',
    'macZip': 'macOS 压缩包',
    'windowsExe': 'Windows 安装包',
    'cliNpm': 'CLI npm 页面',
}


def validate_download_url(value, field_name, max_length=500):
    """下载地址必须为 http/https（内部 CDN/静态目录允许 http）；允许留空。"""
    raw = normalize_optional_string(value, field_name, max_length)
    if not raw:
        return ''
    parsed = urlsplit(raw)
    if parsed.scheme not in {'http', 'https'}:
        raise SettingsSchemaError(f'{field_name}必须是 http/https 链接')
    if not parsed.netloc:
        raise SettingsSchemaError(f'{field_name}地址无效')
    return raw


def validate_site_download_payload(payload):
    """校验并标准化产品站下载配置，返回以数据库键为键的字典"""
    payload = payload or {}
    values = {}
    for field, db_key in SITE_DOWNLOAD_FIELD_MAP.items():
        values[db_key] = validate_download_url(
            payload.get(field), SITE_DOWNLOAD_LABELS.get(field, '下载地址')
        )
    return values


# 网页搜索后端配置项（与 config.py 环境变量一一对应）
WEB_SEARCH_KEYS = (
    'AGENT_WEBSEARCH_PROVIDER',
    'AGENT_WEBSEARCH_API_KEY',
    'AGENT_WEBSEARCH_PROXY_URL',
    'AGENT_WEBSEARCH_TIMEOUT_SECONDS',
)

# 已支持的搜索后端。新增一家只需在 agent/service/search_providers.py 里加实现，
# 并把 code 补进这里。
WEB_SEARCH_PROVIDERS = ('', 'tavily')

# API Key 不回显；前端拿到的是这个占位符，原样提交表示「保持不变」。
WEB_SEARCH_KEY_PLACEHOLDER = '••••••••'


def validate_web_search_payload(payload):
    """校验并标准化网页搜索后端配置。

    api_key 为 None 表示「保持数据库中已有的值」——前端只拿得到掩码，
    不该也无法把原值提交回来。
    """
    payload = payload or {}
    provider = normalize_optional_string(payload.get('provider'), '搜索后端', 32).lower()
    if provider not in WEB_SEARCH_PROVIDERS:
        raise SettingsSchemaError(f'不支持的搜索后端：{provider}')

    raw_timeout = payload.get('timeout_seconds')
    if raw_timeout in (None, ''):
        timeout = ''
    else:
        try:
            timeout = str(min(60, max(3, int(raw_timeout))))
        except (TypeError, ValueError):
            raise SettingsSchemaError('超时时间必须是整数秒')

    proxy = normalize_optional_string(payload.get('proxy_url'), '代理地址', 500)
    if proxy and not proxy.lower().startswith(('http://', 'https://', 'socks5://', 'socks5h://')):
        raise SettingsSchemaError('代理地址需以 http(s):// 或 socks5(h):// 开头')

    api_key = payload.get('api_key')
    if api_key is not None:
        api_key = str(api_key).strip()
        if api_key == WEB_SEARCH_KEY_PLACEHOLDER:
            api_key = None
        elif len(api_key) > 500:
            raise SettingsSchemaError('API Key 长度不能超过 500 个字符')

    if provider and api_key == '':
        raise SettingsSchemaError('启用搜索后端时必须填写 API Key')

    return {
        'AGENT_WEBSEARCH_PROVIDER': provider,
        'AGENT_WEBSEARCH_API_KEY': api_key,
        'AGENT_WEBSEARCH_PROXY_URL': proxy,
        'AGENT_WEBSEARCH_TIMEOUT_SECONDS': timeout,
    }
