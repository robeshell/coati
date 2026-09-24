"""渠道出站代理的小型工具函数。"""

from urllib.parse import urlsplit


def proxy_mapping(proxy_url):
    """返回 requests/urllib 都能使用的代理映射。"""
    value = str(proxy_url or '').strip()
    if not value:
        return None
    return {'http': value, 'https': value}


def proxy_hint(proxy_url):
    """只保留协议、主机和端口，绝不回显代理认证信息。"""
    value = str(proxy_url or '').strip()
    if not value:
        return ''
    parsed = urlsplit(value)
    host = parsed.hostname or ''
    if ':' in host and not host.startswith('['):
        host = f'[{host}]'
    try:
        port = parsed.port
    except ValueError:
        port = None
    netloc = f'{host}:{port}' if port else host
    return f'{parsed.scheme}://{netloc}'


__all__ = ['proxy_hint', 'proxy_mapping']
