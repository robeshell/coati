import base64

import pytest
from flask import Blueprint, Flask

import backend.app.agent.api.desktop_updates as desktop_updates_api
from backend.app.agent.api.desktop_updates import init_agent_desktop_updates_api
from backend.app.agent.service.desktop_release_service import (
    DesktopReleaseError,
    DesktopReleaseService,
    electron_metadata,
    normalize_release_payload,
)


SHA512 = base64.b64encode(b'x' * 64).decode()


class FakeResponse:
    status_code = 200
    ok = True

    def json(self):
        return {
            'version': '0.2.0',
            'fileName': 'Coati-0.2.0-arm64-mac.zip',
            'filePath': 'signed_download_token==',
            'fileSize': 123456,
            'sha512': SHA512,
            'changelog': '修复更新流程',
        }


def test_company_release_becomes_electron_metadata():
    release = normalize_release_payload(FakeResponse().json(), 'macos')
    metadata = electron_metadata(release)
    assert 'version: "0.2.0"' in metadata
    assert 'Coati-0.2.0-arm64-mac.zip' in metadata
    assert f'sha512: "{SHA512}"' in metadata
    assert 'releaseNotes: "修复更新流程"' in metadata


def test_company_release_rejects_wrong_artifact_and_checksum():
    payload = FakeResponse().json()
    payload['fileName'] = 'Coati-0.2.0.dmg'
    with pytest.raises(DesktopReleaseError, match='zip'):
        normalize_release_payload(payload, 'macos')
    payload['fileName'] = 'Coati-0.2.0.zip'
    payload['sha512'] = 'invalid'
    with pytest.raises(DesktopReleaseError, match='SHA-512'):
        normalize_release_payload(payload, 'macos')


def test_release_service_uses_default_json_and_https_download():
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse()

    service = DesktopReleaseService({
        'AGENT_DESKTOP_RELEASE_API_BASE': 'https://appv.example',
        'AGENT_DESKTOP_RELEASE_IDENTIFIER': 'cn.net.coatiode',
        'AGENT_DESKTOP_RELEASE_TEMPLATE': 'electron.json',
    }, http_get=get)
    release = service.latest('macos')
    assert release['version'] == '0.2.0'
    assert calls[0][1]['params'] == {
        'identifier': 'cn.net.coatiode',
        'platform': 'macos',
    }
    assert service.download_url(release['file_path']).startswith(
        'https://appv.example/api/open/download/signed_download_token=='
    )


def test_public_feed_and_download_redirect_follow_electron_paths(monkeypatch):
    release = normalize_release_payload(FakeResponse().json(), 'macos')

    class FakeService:
        def latest(self, platform):
            assert platform == 'macos'
            return release

        def download_url(self, file_path):
            assert file_path == release['file_path']
            return f'https://appv.example/api/open/download/{file_path}'

    monkeypatch.setattr(desktop_updates_api, 'DesktopReleaseService', lambda _config: FakeService())
    app = Flask(__name__)
    bp = Blueprint('desktop-updates-test', __name__)
    init_agent_desktop_updates_api(bp, None, None)
    app.register_blueprint(bp)
    client = app.test_client()

    metadata = client.get('/api/agent/desktop-updates/macos/latest-mac.yml')
    assert metadata.status_code == 200
    assert metadata.content_type == 'text/yaml; charset=utf-8'
    download = client.get('/api/agent/desktop-updates/macos/0.2.0/Coati-0.2.0-arm64-mac.zip')
    assert download.status_code == 302
    assert download.location.startswith('https://appv.example/api/open/download/')
