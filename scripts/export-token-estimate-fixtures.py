#!/usr/bin/env python3
"""Export count_tokens expectations by executing unchanged Python reference code, without Flask or DB."""
import ast
import base64
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import types

root = Path(__file__).resolve().parents[1]
base = root / 'portal/backend/app/agent/service'
for name in ['backend', 'backend.app', 'backend.app.agent', 'backend.app.agent.service']:
    module = types.ModuleType(name)
    module.__path__ = []
    sys.modules[name] = module
for name in ['protocol_bridge', 'server_tools']:
    full = 'backend.app.agent.service.' + name
    spec = importlib.util.spec_from_file_location(full, base / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[full] = module
    spec.loader.exec_module(module)
server = module

def method(file, name, scope):
    tree = ast.parse((base / file).read_text())
    node = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == name)
    node.decorator_list = []
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(base / file), 'exec'), scope)
    return scope[name]

estimate = method('usage_service.py', 'estimate_tokens', {'json': json, 'math': math})
count = method('gateway_service.py', 'count_tokens', {'extract_server_tools': server.extract_server_tools, 'normalize_server_tool_history': server.normalize_server_tool_history})
service = types.SimpleNamespace(usage=types.SimpleNamespace(estimate_tokens=estimate, new_request_id=lambda: 'fixture'))
bodies = [{}, {'messages': []}]
for text in ['hello', '你好，世界🌍', 'a\\b\n"quoted"', 'x' * 10000]:
    bodies.append({'messages': [{'role': 'user', 'content': text}], 'model': 'ignored', 'max_tokens': 100})
bodies += [
    {'messages': [], 'system': [{'type': 'text', 'text': 'system'}], 'tool_choice': {'type': 'auto'}},
    {'messages': [], 'tools': [{'type': 'web_search_20250305', 'name': 'search'}, {'type': 'web_fetch_20250910'}, {'type': 'code_execution_20250522'}]},
    {'messages': [], 'tools': [{'name': 'web_search', 'input_schema': {'type': 'object', 'properties': {'q': {'type': 'string'}}}}]},
]
blocks = [
    {'type': 'server_tool_use', 'name': 'web_search', 'input': {'query': 'hello'}},
    {'type': 'server_tool_use', 'name': 'web_fetch', 'input': {'url': 'https://example.com'}},
    {'type': 'web_search_tool_result', 'content': []},
    {'type': 'web_search_tool_result', 'content': {'error_code': 'unavailable'}},
    {'type': 'web_search_tool_result', 'content': [{'url': 'https://example.com', 'title': '标题', 'encrypted_content': server._encrypt_content({'content': '网页正文', 'page_age': 'today'})}]},
    {'type': 'web_search_tool_result', 'content': [{'encrypted_content': 'coati1:invalid'}]},
    {'type': 'web_fetch_tool_result', 'content': None},
    {'type': 'web_fetch_tool_result', 'content': {'type': 'web_fetch_tool_result_error', 'error_code': 'url_not_allowed'}},
    {'type': 'web_fetch_tool_result', 'content': {'url': 'https://example.com', 'content': {'title': '页面', 'source': {'data': '内容'}}}},
    {'type': 'tool_result', 'content': 'ordinary client tool result'},
]
for block in blocks:
    bodies.append({'messages': [{'role': 'assistant', 'content': [block, {'type': 'text', 'text': '保留'}]}]})
result = {'sources': {file: hashlib.sha256((base / file).read_bytes()).hexdigest() for file in ['usage_service.py', 'gateway_service.py', 'server_tools.py']}, 'cases': [{'body': body, 'expected': count(service, None, body)[0]} for body in bodies]}
(root / 'apps/api/test/fixtures/python-token-estimate.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(f'Exported {len(bodies)} Python count_tokens cases')
