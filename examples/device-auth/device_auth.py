#!/usr/bin/env python3
"""Coati device authorization example. Python standard library only."""
import argparse
import ipaddress
import json
import time
import webbrowser
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class ApiError(RuntimeError):
    def __init__(self, status, payload):
        self.status = status
        self.code = payload.get('error_code') if isinstance(payload, dict) else None
        # Never echo error bodies: upstream responses can contain credentials.
        super().__init__(f'网关请求失败（HTTP {status}）')


def decode_response(status, data):
    if not 200 <= status < 300:
        raise ApiError(status, data)
    if not isinstance(data, dict):
        raise RuntimeError('网关返回了无效的 JSON 对象')
    return data


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Do not forward bearer credentials or device codes to another URL.
        return None


class Client:
    def __init__(self, portal, timeout=30):
        parsed = urlsplit(portal)
        try:
            loopback = ipaddress.ip_address(parsed.hostname or '').is_loopback
        except ValueError:
            loopback = parsed.hostname == 'localhost'
        if (not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment
                or parsed.scheme not in ('http', 'https')
                or (parsed.scheme == 'http' and not loopback)):
            raise ValueError('门户须为 HTTPS 地址；仅本机允许 HTTP，地址不能包含账号、查询参数或片段')
        self.portal = portal.rstrip('/')
        self.timeout = timeout
        self.opener = build_opener(NoRedirect())

    def browser_url(self, path):
        url = urljoin(self.portal + '/', path)
        if urlsplit(url)[:2] != urlsplit(self.portal)[:2]:
            raise ValueError('网关返回了不同来源的授权地址，请检查门户配置')
        return url

    def request(self, method, path, body=None, token=None):
        headers = {'Accept': 'application/json'}
        if token:
            headers['Authorization'] = f'Bearer {token}'
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        req = Request(self.portal + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=self.timeout) as response:
                status, raw = response.status, response.read()
        except HTTPError as exc:
            status, raw = exc.code, exc.read()
            exc.close()
        except (URLError, TimeoutError) as exc:
            raise RuntimeError('连接网关失败或超时，请检查地址与服务状态') from exc
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeError):
            payload = None
        return decode_response(status, payload)


def wait_for_token(client, flow, sleep=time.sleep, clock=time.monotonic):
    deadline = clock() + max(0, float(flow['expires_in']))
    interval = max(1, float(flow.get('interval', 5)))
    while clock() < deadline:
        sleep(min(interval, max(0, deadline - clock())))
        if clock() >= deadline:
            break
        try:
            result = client.request('POST', '/api/agent/auth/device/poll',
                                    {'device_code': flow['device_code']})
            token = result.get('access_token')
            if not isinstance(token, str) or not token:
                raise RuntimeError('授权响应缺少访问令牌')
            return token
        except ApiError as exc:
            if exc.status == 400 and exc.code == 'authorization_pending':
                continue
            if exc.status in (400, 429) and exc.code == 'slow_down':
                interval += 5
                continue
            if exc.code == 'expired_token':
                raise RuntimeError('设备授权已过期，请重新运行示例') from exc
            raise
    raise RuntimeError('设备授权已超时，请重新运行示例')


def run_example(client, model=None, prompt='Reply with a short hello.', *,
                open_browser=webbrowser.open, ask=input, emit=print,
                sleep=time.sleep, clock=time.monotonic):
    flow = client.request('POST', '/api/agent/auth/device/start', {})
    verify = client.browser_url(flow['verification_uri_complete'])
    emit(f"授权码：{flow['user_code']}\n请登录门户并确认：{verify}")
    try:
        open_browser(verify)
    except webbrowser.Error:
        emit('无法自动打开浏览器，请手动访问上方地址。')
    token = wait_for_token(client, flow, sleep=sleep, clock=clock)
    emit('授权成功。令牌仅保存在本进程内存，不打印、不写入文件。')
    token_name = 'device-' + flow['user_code']
    try:
        me = client.request('GET', '/api/agent/me', token=token)
        emit(f"当前用户：{me['user'].get('username', me['user'].get('id'))}")
        models = client.request('GET', '/api/agent/v1/models', token=token)
        names = [item['id'] for item in models.get('data', [])]
        emit('可用模型：' + (', '.join(names) or '无'))
        selected = model or (names[0] if names else None)
        if selected is None or selected not in names:
            raise RuntimeError('没有匹配的可用模型，请先在门户配置模型账号与路由')
        reply = client.request('POST', '/api/agent/v1/chat/completions', {
            'model': selected, 'messages': [{'role': 'user', 'content': prompt}],
            'stream': False, 'max_tokens': 64,
        }, token=token)
        emit('模型回复：' + str(reply['choices'][0]['message'].get('content') or '（无文本）'))
    finally:
        emit(f'请在 {client.portal}/agent/tokens 中撤销本次设备令牌：{token_name}')
        # Browser-session authorization is intentionally not impersonated here.
        ask('撤销后按 Enter，验证原令牌是否已失效：')
        try:
            client.request('GET', '/api/agent/me', token=token)
        except ApiError as exc:
            if exc.status != 401:
                raise RuntimeError('撤销验证未通过：网关未返回 401') from exc
            emit('撤销验证通过：原令牌返回 HTTP 401。')
        else:
            raise RuntimeError('原令牌仍可使用，请确认已撤销正确的设备令牌')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--portal', default='http://localhost:8080')
    parser.add_argument('--model', help='模型名；默认使用第一个可用模型')
    parser.add_argument('--prompt', default='Reply with a short hello.')
    parser.add_argument('--no-browser', action='store_true', help='只显示授权地址')
    args = parser.parse_args()
    try:
        run_example(Client(args.portal), args.model, args.prompt,
                    open_browser=(lambda url: None) if args.no_browser else webbrowser.open)
    except (KeyboardInterrupt, EOFError):
        print('\n示例已中断。如已完成授权，请在门户“访问令牌”中撤销本次 device- 令牌。')
        return 130
    except RuntimeError as exc:
        print(str(exc))
        return 1
    except (ValueError, KeyError, TypeError):
        # No traceback/raw response: authorization codes and tokens stay private.
        print('示例未完成，请检查门户地址、授权状态、模型配置及令牌撤销状态。')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
