"""Authenticated Gitea Release adapter; credentials never leave the portal."""
import json
import re
from urllib.parse import quote, urlsplit

import requests
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from backend.app.agent.service.desktop_release_service import (
    DesktopReleaseError, normalize_release_service_url, validate_sha512,
)


class GiteaDesktopReleaseService:
    def __init__(self, config, http_get=requests.get):
        self.base = normalize_release_service_url(config.get('AGENT_DESKTOP_GITEA_URL'))
        self.repo = str(config.get('AGENT_DESKTOP_GITEA_REPO') or '').strip()
        self.token = str(config.get('AGENT_DESKTOP_GITEA_TOKEN') or '').strip()
        self.secret = str(config.get('AGENT_DESKTOP_GITEA_DOWNLOAD_SECRET') or '')
        self.test_tag = config.get('AGENT_DESKTOP_GITEA_TEST_TAG') or ''
        self.http_get = http_get
        if not self.base or not re.fullmatch(r'[\w.-]+/[\w.-]+', self.repo) or not self.token or len(self.secret) < 32:
            raise DesktopReleaseError('Gitea 更新服务配置不完整', 503)
        self.signer = URLSafeTimedSerializer(self.secret, salt='coati-desktop-download-v1')

    def _get(self, url, *, stream=False, headers=None):
        # Do not forward the service credential through arbitrary redirects.
        if urlsplit(url)[:2] != urlsplit(self.base)[:2]:
            raise DesktopReleaseError('Gitea 制品地址不在配置的服务内', 503)
        try:
            result = self.http_get(url, headers={'Authorization': f'token {self.token}', **(headers or {})},
                                   timeout=(10, 60), stream=stream, allow_redirects=False)
        except requests.RequestException as exc:
            raise DesktopReleaseError('暂时无法连接 Gitea 更新服务', 502) from exc
        if result.status_code not in (200, 206, 416):
            result.close()
            raise DesktopReleaseError('Gitea 更新制品不可用或服务账号无权访问', 503)
        return result

    def _json(self, url):
        response = self._get(url, stream=True)
        try:
            data = bytearray()
            for chunk in response.iter_content(65536):
                data.extend(chunk)
                if len(data) > 2 * 1024 * 1024:
                    raise DesktopReleaseError('Gitea 更新清单过大', 503)
            return json.loads(data)
        except (ValueError, requests.RequestException) as exc:
            raise DesktopReleaseError('Gitea 更新清单无效', 503) from exc
        finally:
            response.close()

    def _release(self, channel):
        api = f'{self.base}/api/v1/repos/{self.repo}/releases'
        if channel == 'preview':
            if not self.test_tag:
                raise DesktopReleaseError('未配置测试版本', 404)
            release = self._json(f'{api}/tags/{quote(self.test_tag, safe="")}')
        elif channel == 'stable':
            # Gitea latest excludes drafts and prereleases; validate as well.
            release = self._json(f'{api}/latest')
        else:
            raise DesktopReleaseError('未知更新渠道', 404)
        if not isinstance(release, dict) or release.get('draft') or (channel == 'stable' and release.get('prerelease')):
            raise DesktopReleaseError('该版本尚未开放更新', 404)
        return release

    def latest(self, platform, arch, channel='stable'):
        if platform not in ('macos', 'windows') or arch not in ('arm64', 'x64'):
            raise DesktopReleaseError('不支持该更新平台', 404)
        release = self._release(channel)
        assets = release.get('assets') or []
        if not isinstance(assets, list) or any(not isinstance(a, dict) for a in assets):
            raise DesktopReleaseError('更新附件列表无效', 503)
        metadata_name = f'coati-update-{platform}-{arch}.json'
        matches = [a for a in assets if a.get('name') == metadata_name]
        if len(matches) != 1:
            raise DesktopReleaseError('该版本尚无此平台的更新清单', 404)
        metadata = self._json(matches[0].get('browser_download_url', ''))
        if not isinstance(metadata, dict):
            raise DesktopReleaseError('更新清单无效', 503)
        version = str(metadata.get('version') or '')
        if not re.fullmatch(r'\d+\.\d+\.\d+', version):
            raise DesktopReleaseError('更新清单版本号无效', 503)
        name = str(metadata.get('fileName') or '')
        extension = '.zip' if platform == 'macos' else '.exe'
        if any(ord(c) < 32 for c in name) or '/' in name or '\\' in name or not name.endswith(extension):
            raise DesktopReleaseError('更新文件名无效', 503)
        files = [a for a in assets if a.get('name') == name]
        if len(files) != 1 or files[0].get('size', 0) != metadata.get('fileSize') or type(metadata.get('fileSize')) is not int or metadata['fileSize'] <= 0:
            raise DesktopReleaseError('更新文件与发布清单不一致', 503)
        checksum = validate_sha512(metadata.get('sha512'))
        allowed = [files[0]] + [a for a in assets if a.get('name') == name + '.blockmap']
        urls = {a['name']: a.get('browser_download_url') or '' for a in allowed}
        for url in urls.values():
            if urlsplit(url)[:2] != urlsplit(self.base)[:2]:
                raise DesktopReleaseError('更新附件指向未配置的服务', 503)
        ticket = self.signer.dumps({'repo': self.repo, 'urls': urls})
        relative = f'download/{ticket}/{quote(name, safe="")}'
        # Keep URLs relative to this channel/platform/arch feed for updater compatibility.
        lines = [f'version: {json.dumps(version)}', 'files:', f'  - url: {json.dumps(relative)}',
                 f'    sha512: {json.dumps(checksum)}', f'    size: {metadata["fileSize"]}',
                 f'path: {json.dumps(relative)}', f'sha512: {json.dumps(checksum)}',
                 f'releaseNotes: {json.dumps(str(metadata.get("releaseNotes") or release.get("body") or ""), ensure_ascii=False)}']
        return '\n'.join(lines) + '\n'

    def download(self, ticket, file_name, range_header=None):
        try:
            claims = self.signer.loads(ticket, max_age=24 * 3600)
        except (BadSignature, SignatureExpired) as exc:
            raise DesktopReleaseError('更新下载授权已失效，请重新检查更新', 403) from exc
        if not isinstance(claims, dict):
            raise DesktopReleaseError('无效的更新下载授权', 403)
        if claims.get('repo') != self.repo or file_name not in claims.get('urls', {}):
            raise DesktopReleaseError('无效的更新下载授权', 403)
        headers = {}
        if range_header:
            if not re.fullmatch(r'bytes=\d*-\d*(?:,\s*\d*-\d*)*', range_header):
                raise DesktopReleaseError('无效的 Range 请求', 416)
            headers['Range'] = range_header
        return self._get(claims['urls'][file_name], stream=True, headers=headers)
