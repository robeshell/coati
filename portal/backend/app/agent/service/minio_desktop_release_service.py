"""Private MinIO releases. Only short-lived download capabilities leave the portal."""
import json
import re
from datetime import timedelta
from urllib.parse import quote, urlsplit

from itsdangerous import URLSafeTimedSerializer, BadSignature
from backend.app.agent.service.desktop_release_service import DesktopReleaseError, validate_sha512

PREFIX = 'AGENT_DESKTOP_MINIO_'


def validate_target(channel, platform, arch):
    if channel not in ('stable', 'preview') or platform not in ('macos', 'windows') or arch not in ('arm64', 'x64'):
        raise DesktopReleaseError('未知更新渠道或平台', 404)


def validate_version(version):
    if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise DesktopReleaseError('更新版本号无效', 503)
    return version


def release_prefix(version, platform, arch):
    validate_version(version)
    validate_target('preview', platform, arch)
    return f'releases/{version}/{platform}/{arch}'


class MinioDesktopReleaseService:
    def __init__(self, config, client=None):
        self.config = config
        self.bucket = str(config.get(PREFIX + 'BUCKET') or '')
        self.endpoint = str(config.get(PREFIX + 'ENDPOINT') or '')
        parsed = urlsplit(self.endpoint)
        self.public_endpoint = str(config.get(PREFIX + 'PUBLIC_ENDPOINT') or self.endpoint)
        public = urlsplit(self.public_endpoint)
        secret = str(config.get(PREFIX + 'FEED_SECRET') or '')
        if (parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password
                or parsed.path not in ('', '/') or getattr(parsed, 'query', '') or parsed.fragment
                or public.scheme != 'https' or not public.netloc or public.username or public.password
                or public.path not in ('', '/') or getattr(public, 'query', '') or public.fragment
                or not self.bucket or len(secret) < 32):
            raise DesktopReleaseError('MinIO 更新服务配置不完整', 503)
        self.signer = URLSafeTimedSerializer(secret, salt='coati-minio-update-v1')
        self._client = client
        self._download_client = client

    def _make_client(self, endpoint):
        from minio import Minio
        import urllib3
        import os
        from urllib.request import proxy_bypass
        key, secret = (self.config.get(PREFIX + name) for name in ('ACCESS_KEY', 'SECRET_KEY'))
        if not key or not secret:
            raise DesktopReleaseError('MinIO 更新凭据未配置', 503)
        parsed = urlsplit(endpoint)
        # Internal HTTP is an explicitly configured trusted server connection.
        proxy = (os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')) if parsed.scheme == 'https' and not proxy_bypass(parsed.hostname) else None
        options = dict(timeout=urllib3.Timeout(connect=5, read=30), retries=False, cert_reqs='CERT_REQUIRED')
        transport = urllib3.ProxyManager(proxy, **options) if proxy else urllib3.PoolManager(**options)
        return Minio(parsed.netloc, access_key=key, secret_key=secret, secure=parsed.scheme == 'https',
                     region=self.config.get(PREFIX + 'REGION') or None, http_client=transport)

    @property
    def client(self):
        if self._client is None:
            self._client = self._make_client(self.endpoint)
        return self._client

    @property
    def download_client(self):
        if self._download_client is None:
            self._download_client = self._make_client(self.public_endpoint)
        return self._download_client

    def feed(self, user_id, channel):
        if channel not in ('stable', 'preview'):
            raise DesktopReleaseError('未知更新渠道', 404)
        ticket = self.signer.dumps({'user': str(user_id), 'channel': channel, 'bucket': self.bucket, 'kind': 'feed'})
        return f'/api/agent/minio-updates/{ticket}/{channel}/{{platform}}/{{arch}}'

    def authorize(self, ticket, channel):
        try:
            claims = self.signer.loads(ticket, max_age=24 * 3600)
        except BadSignature as error:
            raise DesktopReleaseError('更新授权已过期，请重新检查更新', 403) from error
        if not isinstance(claims, dict) or claims.get('channel') != channel or claims.get('bucket') != self.bucket:
            raise DesktopReleaseError('无效更新授权', 403)
        if channel == 'preview':
            users = {x.strip() for x in str(self.config.get(PREFIX + 'TEST_USER_IDS') or '').split(',') if x.strip()}
            if claims.get('user') not in users:
                raise DesktopReleaseError('测试更新未开放', 403)
        elif channel != 'stable' or self.config.get('AGENT_DESKTOP_UPDATE_PROVIDER') != 'minio':
            raise DesktopReleaseError('正式更新未开放', 403)
        return claims

    def read_json(self, key):
        response = None
        try:
            response = self.client.get_object(self.bucket, key)
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError('oversize')
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError('not an object')
            return value
        except Exception as error:
            if isinstance(error, DesktopReleaseError):
                raise
            status = 404 if getattr(error, 'code', '') in ('NoSuchKey', 'NoSuchBucket') else 503
            raise DesktopReleaseError('更新清单不存在或不可用', status) from error
        finally:
            if response is not None:
                response.close()
                response.release_conn()

    def manifest(self, version, platform, arch):
        prefix = release_prefix(version, platform, arch)
        data = self.read_json(f'{prefix}/manifest.json')
        name = data.get('fileName')
        ext = '.zip' if platform == 'macos' else '.exe'
        if (data.get('version') != version or data.get('platform') != platform or data.get('arch') != arch
                or not isinstance(name, str) or not name.endswith(ext)
                or any(c in name for c in '/\\') or any(ord(c) < 32 for c in name)
                or type(data.get('fileSize')) is not int or data['fileSize'] <= 0):
            raise DesktopReleaseError('更新清单与平台或制品不匹配', 503)
        validate_sha512(data.get('sha512'))
        return data

    def latest(self, ticket, channel, platform, arch):
        validate_target(channel, platform, arch)
        claims = self.authorize(ticket, channel)
        if claims.get('kind') != 'feed':
            raise DesktopReleaseError('无效清单授权', 403)
        pointer = self.read_json(f'channels/{channel}/{platform}/{arch}.json')
        version = validate_version(pointer.get('version'))
        data = self.manifest(version, platform, arch)
        download_ticket = self.signer.dumps({**claims, 'kind': 'download', 'version': version, 'platform': platform, 'arch': arch})
        url = f'/api/agent/minio-updates/{download_ticket}/{channel}/{platform}/{arch}/{version}/{quote(data["fileName"], safe="")}'
        return '\n'.join([f'version: {json.dumps(version)}', 'files:', f'  - url: {json.dumps(url)}',
                          f'    sha512: {json.dumps(data["sha512"])}', f'    size: {data["fileSize"]}',
                          f'path: {json.dumps(url)}', f'sha512: {json.dumps(data["sha512"])}',
                          f'releaseNotes: {json.dumps(str(data.get("releaseNotes") or ""), ensure_ascii=False)}']) + '\n'

    def download_url(self, ticket, channel, platform, arch, version, name):
        validate_target(channel, platform, arch)
        claims = self.authorize(ticket, channel)
        if any(claims.get(k) != v for k, v in {'kind': 'download', 'version': version, 'platform': platform, 'arch': arch}.items()):
            raise DesktopReleaseError('下载授权与版本不匹配', 403)
        data = self.manifest(version, platform, arch)
        allowed = [data['fileName']]
        if data.get('blockmap') is True:
            allowed.append(data['fileName'] + '.blockmap')
        if name not in allowed:
            raise DesktopReleaseError('未找到更新附件', 404)
        try:
            return self.download_client.presigned_get_object(self.bucket, f'{release_prefix(version, platform, arch)}/{name}',
                                                   expires=timedelta(hours=1))
        except Exception as error:
            raise DesktopReleaseError('无法获取更新下载地址', 503) from error
