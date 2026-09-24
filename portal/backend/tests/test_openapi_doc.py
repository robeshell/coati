# -*- coding: utf-8 -*-
"""OpenAPI 文档骨架路径识别验证"""

from backend.scripts.verify_feature import _openapi_is_stub_path


def test_generated_stub_is_stub():
    stub = {'GET': {'summary': 'GET /x', 'responses': {'200': {'description': '成功'}}}}
    assert _openapi_is_stub_path(stub) is True


def test_detailed_with_content_is_not_stub():
    detailed = {
        'GET': {
            'summary': 'GET /x',
            'responses': {'200': {'description': '成功', 'content': {'application/json': {}}}},
        },
    }
    assert _openapi_is_stub_path(detailed) is False


def test_with_parameters_is_not_stub():
    with_params = {
        'GET': {
            'summary': 'GET /x',
            'parameters': [{'name': 'page', 'in': 'query'}],
            'responses': {'200': {'description': '成功'}},
        },
    }
    assert _openapi_is_stub_path(with_params) is False
