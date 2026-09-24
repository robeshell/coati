import base64
import json
from types import SimpleNamespace
from urllib.parse import unquote

import pytest
from flask import Blueprint, Flask, g
from itsdangerous import TimestampSigner

from backend.app.agent.api.bootstrap import build_agent_bootstrap
from backend.app.agent.api.desktop_updates import init_agent_desktop_updates_api
from backend.app.agent.service.gitea_desktop_release_service import GiteaDesktopReleaseService, DesktopReleaseError

BASE = 'https://git.example'
CONFIG = dict(AGENT_DESKTOP_GITEA_URL=BASE, AGENT_DESKTOP_GITEA_REPO='org/repo',
              AGENT_DESKTOP_GITEA_TOKEN='server-secret', AGENT_DESKTOP_GITEA_DOWNLOAD_SECRET='s' * 40,
              AGENT_DESKTOP_GITEA_TEST_TAG='preview-1', AGENT_DESKTOP_GITEA_TEST_USER_IDS='7')
NAME = 'Coati-1.0.1-arm64-mac.zip'
SHA = base64.b64encode(b'x' * 64).decode()


class Response:
    def __init__(self, body, status=200):
        self.body = body
        self.status_code = status
        self.headers = {'Content-Type': 'application/octet-stream', 'Content-Length': str(len(body))}
        self.closed = False
    def iter_content(self, size):
        yield self.body
    def close(self):
        self.closed = True


def fixture_service():
    release = {'assets': [{'name': n, 'size': 3, 'browser_download_url': BASE + '/assets/' + n}
                          for n in ['coati-update-macos-arm64.json', NAME, NAME + '.blockmap']]}
    metadata = dict(version='1.0.1', fileName=NAME, fileSize=3, sha512=SHA)
    calls = []
    def get(url, **kw):
        calls.append((url, kw))
        if '/releases/' in url:
            return Response(json.dumps(release).encode())
        if url.endswith('.json'):
            return Response(json.dumps(metadata).encode())
        return Response(b'zip', 206 if kw['headers'].get('Range') else 200)
    return GiteaDesktopReleaseService(CONFIG, get), release, metadata, calls


def download_path(service):
    text = service.latest('macos', 'arm64', 'preview')
    path = json.loads(next(line[6:] for line in text.splitlines() if line.startswith('path: ')))
    return text, path.split('/')[1], unquote(path.split('/')[2])


def test_signed_download_is_pinned_and_keeps_server_token_private():
    service, release, _, calls = fixture_service()
    text, ticket, name = download_path(service)
    assert 'server-secret' not in text
    release['assets'] = []  # a later release change must not break an existing download
    response = service.download(ticket, name, 'bytes=0-2')
    assert response.status_code == 206
    assert calls[-1][1]['headers'] == {'Authorization': 'token server-secret', 'Range': 'bytes=0-2'}
    assert calls[-1][1]['allow_redirects'] is False
    service.download(ticket, name + '.blockmap')
    for bad in [name + '.exe', '../secret']:
        with pytest.raises(DesktopReleaseError):
            service.download(ticket, bad)
    with pytest.raises(DesktopReleaseError):
        service.download(ticket + 'x', name)


def test_ticket_expiry(monkeypatch):
    service, *_ = fixture_service()
    _, ticket, name = download_path(service)
    original = TimestampSigner.get_timestamp
    monkeypatch.setattr(TimestampSigner, 'get_timestamp', lambda self: original(self) + 86401)
    with pytest.raises(DesktopReleaseError, match='失效'):
        service.download(ticket, name)


def test_reject_bad_release_and_cross_origin_assets():
    service, release, metadata, _ = fixture_service()
    release['prerelease'] = True
    with pytest.raises(DesktopReleaseError):
        service.latest('macos', 'arm64')
    release['prerelease'] = False
    metadata['fileSize'] = 5
    with pytest.raises(DesktopReleaseError):
        service.latest('macos', 'arm64')
    metadata['fileSize'] = 3
    release['assets'][1]['browser_download_url'] = 'https://evil.example/file.zip'
    with pytest.raises(DesktopReleaseError):
        service.latest('macos', 'arm64')


def test_preview_auth_and_bootstrap_isolation(monkeypatch):
    import backend.app.agent.api.desktop_updates as api
    service, *_ = fixture_service()
    monkeypatch.setattr(api, 'GiteaDesktopReleaseService', lambda config: service)
    app = Flask(__name__)
    app.config.update(CONFIG)
    bp = Blueprint('test', __name__)
    init_agent_desktop_updates_api(bp, None, {})
    app.register_blueprint(bp)
    user_id = [8]
    @app.before_request
    def identity():
        g.agent_user = SimpleNamespace(id=user_id[0])
        g.agent_pat = SimpleNamespace(scopes=lambda: ['profile'])
    client = app.test_client()
    path = '/api/agent/gitea-updates/preview/macos/arm64/latest-mac.yml'
    assert client.get(path).status_code == 401
    assert client.get(path, headers={'Authorization': 'Bearer test'}).status_code == 403
    user_id[0] = 7
    result = client.get(path, headers={'Authorization': 'Bearer test'})
    assert result.status_code == 200
    assert result.headers['Cache-Control'] == 'no-store'
    assert client.get(path.replace('preview', 'stable'), headers={'Authorization': 'Bearer test'}).status_code == 404
    for uid in [None, 8]:
        assert build_agent_bootstrap(CONFIG, [], {}, user_id=uid)['desktop_update'] is None
    assert '/preview/' in build_agent_bootstrap(CONFIG, [], {}, user_id=7)['desktop_update']['feed_url']
    _, ticket, name = download_path(service)
    downloaded = client.get('/api/agent/gitea-updates/preview/macos/arm64/download/' + ticket + '/' + name,
                            headers={'Range': 'bytes=0-2'})
    assert downloaded.status_code == 206
    assert downloaded.data == b'zip'
