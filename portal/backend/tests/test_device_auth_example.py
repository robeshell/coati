"""Example contract tests: real gateway routes, isolated DB, mocked upstream/browser."""
import importlib.util
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app.agent.api import auth as auth_api
from backend.app.agent.service.bearer import hash_token
from test_agent_web_search_api import _agent_app, _make_credential, _FakeUpstream, gateway_urlrequest

path = Path(__file__).resolve().parents[3] / 'examples/device-auth/device_auth.py'
spec = importlib.util.spec_from_file_location('device_auth_example', path)
example = importlib.util.module_from_spec(spec)
spec.loader.exec_module(example)


class Timer:
    def __init__(self):
        self.now = 0
        self.waits = []

    def sleep(self, seconds):
        self.waits.append(seconds)
        self.now += seconds

    def clock(self):
        return self.now


@pytest.mark.parametrize('bad', ['http://example.com', 'https://user:pass@example.com',
                                  'https://example.com?token=secret', 'file:///tmp/a'])
def test_unsafe_portal_rejected(bad):
    with pytest.raises(ValueError):
        example.Client(bad)


def test_authorization_link_must_share_origin():
    client = example.Client('https://portal.example')
    assert client.browser_url('/agent/device-confirm?user_code=ABCD') == 'https://portal.example/agent/device-confirm?user_code=ABCD'
    with pytest.raises(ValueError):
        client.browser_url('https://attacker.example/confirm')


def test_transport_does_not_forward_credentials_on_redirect():
    paths = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            paths.append(self.path)
            self.send_response(302)
            self.send_header('Location', '/credential-sink')
            self.end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = example.Client(f'http://127.0.0.1:{server.server_port}')
        with pytest.raises(example.ApiError) as error:
            client.request('GET', '/start', token='test-only-bearer')
        assert error.value.status == 302
        assert paths == ['/start']
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_poll_pending_slowdown_and_success():
    timer = Timer()
    replies = iter([example.ApiError(400, {'error_code': 'authorization_pending'}),
                    example.ApiError(400, {'error_code': 'slow_down'}),
                    {'access_token': 'test-token'}])

    def request(*args):
        value = next(replies)
        if isinstance(value, Exception):
            raise value
        return value

    token = example.wait_for_token(SimpleNamespace(request=request),
                                   {'device_code': 'code', 'expires_in': 30, 'interval': 2},
                                   timer.sleep, timer.clock)
    assert token == 'test-token'
    assert timer.waits == [2, 2, 7]


@pytest.mark.parametrize('code', ['expired_token', 'access_denied'])
def test_poll_terminal_errors_do_not_retry(code):
    timer = Timer()
    calls = []

    def request(*args):
        calls.append(args)
        raise example.ApiError(400, {'error_code': code})

    with pytest.raises(RuntimeError):
        example.wait_for_token(SimpleNamespace(request=request),
                               {'device_code': 'code', 'expires_in': 20}, timer.sleep, timer.clock)
    assert len(calls) == 1


def test_poll_deadline_stops_without_requesting_expired_code():
    timer = Timer()
    client = SimpleNamespace(request=lambda *args: pytest.fail('request after deadline'))
    with pytest.raises(RuntimeError, match='超时'):
        example.wait_for_token(client, {'device_code': 'code', 'expires_in': 1, 'interval': 5},
                               timer.sleep, timer.clock)
    assert timer.now == 1


@pytest.mark.parametrize('revoke,configured', [(True, True), (False, True), (True, False)])
def test_example_against_real_auth_and_gateway_routes(monkeypatch, revoke, configured):
    app, db, models = _agent_app()
    app.secret_key = 'test-session-key'
    if configured:
        _make_credential(app, db, models)
    browser = app.test_client()
    device = app.test_client()
    output, seen_tokens, model_calls = [], [], []
    monkeypatch.setattr(auth_api, 'has_menu_permission', lambda code: True)
    monkeypatch.setattr(auth_api, 'get_current_admin_user', lambda: SimpleNamespace(id=1))

    def upstream(request, timeout=None):
        model_calls.append(json.loads(request.data))
        return _FakeUpstream({'id': 'test-reply', 'object': 'chat.completion',
                              'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': 'Hello'},
                                           'finish_reason': 'stop'}],
                              'usage': {'prompt_tokens': 5, 'completion_tokens': 1, 'total_tokens': 6}})

    monkeypatch.setattr(gateway_urlrequest, 'urlopen', upstream)

    class LocalClient(example.Client):
        def request(self, method, path, body=None, token=None):
            if token:
                seen_tokens.append(token)
            response = device.open(path, method=method, json=body,
                                   headers={'Authorization': f'Bearer {token}'} if token else {})
            return example.decode_response(response.status_code, response.get_json())

    client = LocalClient('http://localhost')

    def open_browser(url):
        from urllib.parse import parse_qs, urlsplit
        code = parse_qs(urlsplit(url).query)['user_code'][0]
        # Verify confirmation cannot be performed by an anonymous device client.
        assert device.post('/api/agent/auth/device/confirm', json={'user_code': code}).status_code == 401
        with browser.session_transaction() as session:
            session['logged_in'] = True
        assert browser.post('/api/agent/auth/device/confirm', json={'user_code': code}).status_code == 200

    def revoke_in_portal(prompt):
        with app.app_context():
            pat = models['AgentPat'].query.filter_by(token_hash=hash_token(seen_tokens[0])).one()
            assert pat.scopes() == ['chat', 'profile']
            pat_id = pat.id
        if revoke:
            assert browser.delete(f'/api/agent/auth/pat/{pat_id}').status_code == 200
        return ''

    timer = Timer()
    args = dict(open_browser=open_browser, ask=revoke_in_portal, emit=output.append,
                sleep=timer.sleep, clock=timer.clock)
    if not revoke or not configured:
        with pytest.raises(RuntimeError, match='仍可使用' if not revoke else '没有匹配'):
            example.run_example(client, **args)
    else:
        example.run_example(client, **args)
    assert bool(model_calls) == configured
    if configured:
        assert model_calls[0]['messages'][0]['content'] == 'Reply with a short hello.'
    assert ('撤销验证通过' in '\n'.join(output)) == revoke
    assert all(token not in '\n'.join(output) for token in seen_tokens)
    with app.app_context():
        db.session.remove()
        db.drop_all()
        db.engine.dispose()
