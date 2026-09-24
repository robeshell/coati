import base64
import io
import json
from urllib.parse import unquote
from types import SimpleNamespace
import importlib.util
from pathlib import Path

import pytest
from flask import Flask, Blueprint
from itsdangerous import TimestampSigner
from backend.app.agent.api.bootstrap import build_agent_bootstrap
from backend.app.agent.api.desktop_updates import init_agent_desktop_updates_api
from backend.app.agent.service.minio_desktop_release_service import MinioDesktopReleaseService, DesktopReleaseError

CONFIG = {'AGENT_DESKTOP_MINIO_ENDPOINT': 'https://files.example', 'AGENT_DESKTOP_MINIO_BUCKET': 'updates',
          'AGENT_DESKTOP_MINIO_FEED_SECRET': 's' * 48, 'AGENT_DESKTOP_MINIO_TEST_USER_IDS': '7'}
NAME = 'Coati-1.0.1-arm64-mac.zip'


class Body(io.BytesIO):
    def release_conn(self): pass
    def stream(self, size):
        while chunk := self.read(size): yield chunk


class Store:
    def __init__(self):
        self.objects = {}
        self.writes = []
    def bucket_exists(self, bucket): return True
    def get_object(self, bucket, key): return Body(self.objects[key])
    def stat_object(self, bucket, key):
        if key not in self.objects:
            error = RuntimeError('missing')
            error.code = 'NoSuchKey'
            raise error
        return SimpleNamespace(size=len(self.objects[key]))
    def put_object(self, bucket, key, source, length, **kw):
        self.objects[key] = source.read()
        self.writes.append(key)
    def fput_object(self, bucket, key, source, **kw):
        self.objects[key] = Path(source).read_bytes()
        self.writes.append(key)
    def presigned_get_object(self, bucket, key, **kw):
        return 'https://files.example/' + bucket + '/' + key + '?temporary-signature=example'


def setup():
    store = Store()
    service = MinioDesktopReleaseService(CONFIG.copy(), store)
    store.objects['channels/preview/macos/arm64.json'] = b'{"version":"1.0.1"}'
    store.objects['releases/1.0.1/macos/arm64/manifest.json'] = json.dumps(dict(version='1.0.1', platform='macos', arch='arm64', fileName=NAME, fileSize=3, sha512=base64.b64encode(b'x'*64).decode(), blockmap=True)).encode()
    feed = service.feed(7, 'preview')
    ticket = feed.split('/')[4]
    return service, store, ticket


def download(service, ticket):
    yaml = service.latest(ticket, 'preview', 'macos', 'arm64')
    return json.loads(next(line[6:] for line in yaml.splitlines() if line.startswith('path: ')))


def test_bootstrap_isolates_users_and_never_exposes_credentials():
    assert build_agent_bootstrap(CONFIG, [], {}, user_id=8)['desktop_update'] is None
    bootstrap = build_agent_bootstrap(CONFIG, [], {}, user_id=7)
    assert bootstrap['desktop_update']['provider'] == 'minio'
    assert CONFIG['AGENT_DESKTOP_MINIO_FEED_SECRET'] not in json.dumps(bootstrap)


def test_feed_and_download_scopes_pin_version():
    service, store, ticket = setup()
    url = download(service, ticket)
    token = url.split('/')[4]
    result = service.download_url(token, 'preview', 'macos', 'arm64', '1.0.1', NAME)
    assert result.startswith('https://files.example/updates/releases/1.0.1/')
    store.objects['channels/preview/macos/arm64.json'] = b'{"version":"1.0.2"}'
    assert service.download_url(token, 'preview', 'macos', 'arm64', '1.0.1', NAME + '.blockmap')
    for t,channel,arch,version,name in [(ticket,'preview','arm64','1.0.1',NAME), (token,'stable','arm64','1.0.1',NAME),
        (token,'preview','x64','1.0.1',NAME),(token,'preview','arm64','1.0.2',NAME),(token,'preview','arm64','1.0.1','../secret')]:
        with pytest.raises(DesktopReleaseError):
            service.download_url(t,channel,'macos',arch,version,name)


def test_tamper_expiry_and_removed_test_user(monkeypatch):
    service, _, ticket = setup()
    with pytest.raises(DesktopReleaseError): download(service, ticket+'x')
    service.config['AGENT_DESKTOP_MINIO_TEST_USER_IDS'] = ''
    with pytest.raises(DesktopReleaseError): download(service, ticket)
    service.config.update(CONFIG)
    original = TimestampSigner.get_timestamp
    monkeypatch.setattr(TimestampSigner, 'get_timestamp', lambda self: original(self)+86401)
    with pytest.raises(DesktopReleaseError): download(service, ticket)


def test_http_and_bad_manifest_rejected():
    with pytest.raises(DesktopReleaseError):
        MinioDesktopReleaseService({**CONFIG,'AGENT_DESKTOP_MINIO_ENDPOINT':'http://files.example'})
    service, store, ticket = setup()
    store.objects['releases/1.0.1/macos/arm64/manifest.json'] = b'[]'
    with pytest.raises(DesktopReleaseError): download(service,ticket)


def test_routes_redirect_to_presigned_download_without_bearer(monkeypatch):
    import backend.app.agent.service.minio_desktop_release_service as module
    service, _, ticket = setup()
    monkeypatch.setattr(module,'MinioDesktopReleaseService',lambda config:service)
    app=Flask(__name__);bp=Blueprint('test',__name__)
    init_agent_desktop_updates_api(bp,None,{})
    app.register_blueprint(bp)
    client=app.test_client()
    response=client.get(f'/api/agent/minio-updates/{ticket}/preview/macos/arm64/latest-mac.yml')
    assert response.status_code == 200
    assert 'no-store' in response.headers['Cache-Control']
    path=download(service,ticket)
    result=client.get(path,headers={'Range':'bytes=0-15'})
    assert result.status_code == 307
    assert result.headers['Location'].startswith('https://files.example/')
    download_token = path.split('/')[4]
    assert client.get(path.replace(download_token, download_token+'x')).status_code == 403



def test_internal_http_client_is_separate_from_public_https_signer(monkeypatch):
    service = MinioDesktopReleaseService({**CONFIG,
        'AGENT_DESKTOP_MINIO_ENDPOINT': 'http://minio.internal:9000',
        'AGENT_DESKTOP_MINIO_PUBLIC_ENDPOINT': 'https://files.example'})
    calls = []
    def factory(endpoint):
        calls.append(endpoint)
        return object()
    monkeypatch.setattr(service, '_make_client', factory)
    assert service.client is not service.download_client
    assert calls == ['http://minio.internal:9000', 'https://files.example']
    with pytest.raises(DesktopReleaseError):
        MinioDesktopReleaseService({**CONFIG, 'AGENT_DESKTOP_MINIO_PUBLIC_ENDPOINT': 'http://files.example'})
