# -*- coding: utf-8 -*-
"""定时任务 URL 防 SSRF 校验验证"""

import socket
from unittest.mock import patch

import pytest

from backend.app.admin.schema.scheduled_task import (
    ScheduledTaskSchemaError,
    validate_request_url,
)


def test_allows_public_https():
    with patch.object(socket, 'getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 0, '', ('93.184.216.34', 0))]):
        assert validate_request_url('https://api.example.com/v1/data') == 'https://api.example.com/v1/data'


def test_allows_public_http():
    assert validate_request_url('http://8.8.8.8/x') == 'http://8.8.8.8/x'


def test_blocks_non_http_scheme():
    with pytest.raises(ScheduledTaskSchemaError):
        validate_request_url('file:///etc/passwd')
    with pytest.raises(ScheduledTaskSchemaError):
        validate_request_url('ftp://example.com/x')


def test_blocks_localhost():
    with pytest.raises(ScheduledTaskSchemaError, match='内网'):
        validate_request_url('http://localhost:8000/x')
    with pytest.raises(ScheduledTaskSchemaError, match='内网'):
        validate_request_url('http://127.0.0.1/x')


def test_blocks_private_ip():
    for url in ['http://10.0.0.1/x', 'http://192.168.1.1/x', 'http://172.16.0.1/x',
                'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/x']:
        with pytest.raises(ScheduledTaskSchemaError, match='内网'):
            validate_request_url(url)


def test_blocks_missing_host():
    with pytest.raises(ScheduledTaskSchemaError):
        validate_request_url('http:///path')


def test_blocks_bad_port():
    with pytest.raises(ScheduledTaskSchemaError, match='端口'):
        validate_request_url('http://example.com:99999/x')
