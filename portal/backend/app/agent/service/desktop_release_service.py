# -*- coding: utf-8 -*-
"""平台版本平台到 Electron 更新清单的适配层。"""

import base64
import json
import re
from urllib.parse import quote, urljoin, urlsplit

import requests


PLATFORMS = {
    'macos': {'metadata': 'latest-mac.yml', 'extension': '.zip'},
    'windows': {'metadata': 'latest.yml', 'extension': '.exe'},
}
TOKEN_PATTERN = re.compile(r'^[A-Za-z0-9_=-]+$')


class DesktopReleaseError(RuntimeError):
    def __init__(self, message, status_code=502):
        super().__init__(message)
        self.status_code = status_code


def normalize_release_service_url(value):
    raw = str(value or '').strip().rstrip('/')
    if not raw:
        return ''
    parsed = urlsplit(raw)
    loopback = parsed.hostname in {'localhost', '127.0.0.1', '::1'}
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and loopback):
        raise DesktopReleaseError('版本平台地址必须使用 HTTPS', 503)
    query = getattr(parsed, 'query', '')
    fragment = getattr(parsed, 'fragment', '')
    if not parsed.netloc or query or fragment:
        raise DesktopReleaseError('版本平台地址无效', 503)
    return raw


def validate_sha512(value):
    checksum = str(value or '').strip()
    try:
        decoded = base64.b64decode(checksum, validate=True)
    except (ValueError, TypeError):
        decoded = b''
    if len(decoded) != 64:
        raise DesktopReleaseError('版本记录缺少有效的 SHA-512 校验值', 503)
    return checksum


def normalize_release_payload(payload, platform):
    rules = PLATFORMS.get(platform)
    if not rules:
        raise DesktopReleaseError('不支持该更新平台', 404)
    if not isinstance(payload, dict):
        raise DesktopReleaseError('版本平台返回内容无效')

    version = str(payload.get('version') or '').strip()
    file_name = str(payload.get('fileName') or '').strip()
    file_path = str(payload.get('filePath') or '').strip()
    if not version or not file_name or not file_path:
        raise DesktopReleaseError('版本记录不完整', 503)
    if not file_name.lower().endswith(rules['extension']):
        raise DesktopReleaseError(f'{platform} 更新文件必须是 {rules["extension"]} 格式', 503)
    if '/' in file_name or '\\' in file_name or not TOKEN_PATTERN.fullmatch(file_path):
        raise DesktopReleaseError('版本文件信息无效', 503)

    try:
        file_size = int(payload.get('fileSize'))
    except (TypeError, ValueError):
        file_size = 0
    if file_size <= 0:
        raise DesktopReleaseError('版本记录缺少文件大小', 503)

    return {
        'version': version,
        'file_name': file_name,
        'file_path': file_path,
        'file_size': file_size,
        'sha512': validate_sha512(payload.get('sha512')),
        'release_notes': str(payload.get('releaseNotes') or payload.get('changelog') or '').strip(),
        'release_date': str(payload.get('releaseDate') or payload.get('createdAt') or '').strip(),
    }


def electron_metadata(release):
    relative_url = f'{quote(release["version"], safe="")}/{quote(release["file_name"], safe="")}'
    lines = [
        f'version: {json.dumps(release["version"], ensure_ascii=False)}',
        'files:',
        f'  - url: {json.dumps(relative_url, ensure_ascii=False)}',
        f'    sha512: {json.dumps(release["sha512"])}',
        f'    size: {release["file_size"]}',
        f'path: {json.dumps(relative_url, ensure_ascii=False)}',
        f'sha512: {json.dumps(release["sha512"])}',
    ]
    if release['release_notes']:
        lines.append(f'releaseNotes: {json.dumps(release["release_notes"], ensure_ascii=False)}')
    if release['release_date']:
        lines.append(f'releaseDate: {json.dumps(release["release_date"], ensure_ascii=False)}')
    return '\n'.join(lines) + '\n'


class DesktopReleaseService:
    def __init__(self, config, http_get=requests.get):
        self.base_url = normalize_release_service_url(config.get('AGENT_DESKTOP_RELEASE_API_BASE'))
        self.identifier = str(config.get('AGENT_DESKTOP_RELEASE_IDENTIFIER') or '').strip()
        self.http_get = http_get

    @property
    def enabled(self):
        return bool(self.base_url and self.identifier)

    def latest(self, platform):
        if not self.enabled:
            raise DesktopReleaseError('桌面更新服务尚未配置', 404)
        if platform not in PLATFORMS:
            raise DesktopReleaseError('不支持该更新平台', 404)
        url = urljoin(f'{self.base_url}/', 'api/open/latest')
        try:
            response = self.http_get(url, params={
                'identifier': self.identifier,
                'platform': platform,
            }, timeout=10)
        except requests.RequestException as exc:
            raise DesktopReleaseError('暂时无法连接版本平台') from exc
        if response.status_code == 404:
            raise DesktopReleaseError('当前平台暂无可用版本', 404)
        if not response.ok:
            raise DesktopReleaseError('版本平台暂时不可用')
        try:
            payload = response.json()
        except ValueError as exc:
            raise DesktopReleaseError('版本平台返回内容无效') from exc
        return normalize_release_payload(payload, platform)

    def download_url(self, file_path):
        if not TOKEN_PATTERN.fullmatch(str(file_path or '')):
            raise DesktopReleaseError('版本文件信息无效', 404)
        path = f'api/open/download/{file_path}'
        return urljoin(f'{self.base_url}/', path)
