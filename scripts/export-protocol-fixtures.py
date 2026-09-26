#!/usr/bin/env python3
"""Run the unchanged Python bridge tests and export deterministic JSON call fixtures.

Requires pytest. Loads only the bridge module, not the Flask application or a database.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import uuid

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'portal/backend/app/agent/service/protocol_bridge.py'
TEST = ROOT / 'portal/backend/tests/test_protocol_bridge.py'
NAME = 'backend.app.agent.service.protocol_bridge'
for name in ['backend', 'backend.app', 'backend.app.agent', 'backend.app.agent.service']:
    module = types.ModuleType(name)
    module.__path__ = []
    sys.modules[name] = module
spec = importlib.util.spec_from_file_location(NAME, SOURCE)
bridge = importlib.util.module_from_spec(spec)
sys.modules[NAME] = bridge
spec.loader.exec_module(bridge)
# Patch only the loaded module's clock/UUID, never the Python reference file.
bridge.time = types.SimpleNamespace(time=lambda: 1700000000)
bridge.uuid4 = lambda: uuid.UUID('00000000-0000-4000-8000-000000000001')
records = []
stream_records = []
current_test = ''

def wrap(name, fn):
    def recorded(*args, **kwargs):
        row = {'test': current_test, 'function': name, 'args': copy.deepcopy(args), 'kwargs': copy.deepcopy(kwargs)}
        try:
            result = fn(*args, **kwargs)
        except bridge.ProtocolBridgeError as exc:
            row['error'] = str(exc)
            records.append(row)
            raise
        row['expected'] = copy.deepcopy(result)
        records.append(row)
        return result
    return recorded

for name in list(vars(bridge)):
    fn = getattr(bridge, name)
    if callable(fn) and not name.startswith('_') and (name.endswith('_body') or name.endswith('_message')):
        setattr(bridge, name, wrap(name, fn))
def wire_value(value):
    if isinstance(value, bytes):
        return {'bytes': value.decode('utf-8')}
    if isinstance(value, list):
        return [wire_value(item) for item in value]
    return copy.deepcopy(value)


def traced_stream(name, cls):
    class Traced(cls):
        def __init__(self, *args, **kwargs):
            self._capture_depth = 0
            self._trace = {'test': current_test, 'class': name, 'args': copy.deepcopy(args), 'kwargs': copy.deepcopy(kwargs), 'calls': []}
            stream_records.append(self._trace)
            super().__init__(*args, **kwargs)
    def trace_method(method, fn):
        def invoke(self, *args, **kwargs):
            outer = self._capture_depth == 0
            row = {'method': method, 'args': copy.deepcopy(args), 'kwargs': copy.deepcopy(kwargs)}
            self._capture_depth += 1
            try:
                result = fn(self, *args, **kwargs)
                row['expected'] = wire_value(result)
                return result
            except bridge.ProtocolBridgeError as exc:
                row['error'] = str(exc)
                raise
            finally:
                self._capture_depth -= 1
                if outer:
                    row['finished'] = self.finished
                    self._trace['calls'].append(row)
        return invoke
    for method in ['start', 'feed', 'feed_line', 'finish']:
        if hasattr(cls, method):
            setattr(Traced, method, trace_method(method, getattr(cls, method)))
    return Traced

for name in ['OpenAIToAnthropicStream', 'AnthropicToOpenAIStream', 'OpenAIToResponsesStream', 'ResponsesToOpenAIStream']:
    setattr(bridge, name, traced_stream(name, getattr(bridge, name)))

spec = importlib.util.spec_from_file_location('coati_python_bridge_tests', TEST)
tests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tests)
count = 0
for name, fn in vars(tests).items():
    if name.startswith('test_') and callable(fn):
        current_test = name
        fn()  # Preserve all original assertions, including pytest.raises.
        count += 1
# Additional migration fixtures exercise edge cases absent from the original suite.
current_test = 'migration_anthropic_images_tool_order_and_user'
bridge.anthropic_to_openai_body({
    'model': 'public', 'stream': True, 'temperature': 0, 'top_p': 0.8,
    'stop_sequences': ['END'], 'metadata': {'user_id': 'user-1'},
    'messages': [{'role': 'user', 'content': [
        {'type': 'text', 'text': 'result follows'},
        {'type': 'image', 'source': {'type': 'url', 'url': 'https://example.invalid/image.png'}},
        {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': 'AA=='}},
        {'type': 'tool_result', 'tool_use_id': 'call-1', 'content': [{'type': 'text', 'text': 'ok'}]},
    ]}],
    'tools': [{'name': 'read', 'input_schema': {}}], 'tool_choice': {'type': 'tool', 'name': 'read'},
})
for choice in ['none', 'auto', 'any']:
    current_test = 'migration_tool_choice_' + choice
    bridge.anthropic_to_openai_body({'model': 'public', 'tools': [{'name': 'read'}], 'tool_choice': {'type': choice}})
for stop in ['end_turn', 'stop_sequence', 'tool_use', 'max_tokens']:
    current_test = 'migration_response_cache_' + stop
    bridge.anthropic_to_openai_message({
        'id': 'msg-1', 'model': 'upstream', 'stop_reason': stop,
        'content': [{'type': 'thinking', 'thinking': 'plan'}, {'type': 'tool_use', 'id': 'call-1', 'name': 'read', 'input': {'path': '中文.py', 'nested': [1, True]}}],
        'usage': {'input_tokens': 7, 'output_tokens': 4, 'cache_read_input_tokens': 3, 'cache_creation_input_tokens': 2},
    }, client_model='public')
# Explicit nine-pair coverage, including native paths and response converters not
# directly exercised by the original tests. Inputs contain tools and cache usage.
requests = {
    'openai': {'model': 'public', 'messages': [{'role': 'user', 'content': '你好'}, {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'call1', 'type': 'function', 'function': {'name': 'read', 'arguments': '{"path":"a"}'}}]}, {'role': 'tool', 'tool_call_id': 'call1', 'content': 'ok'}], 'tools': [{'type': 'function', 'function': {'name': 'read', 'parameters': {'type': 'object'}}}]},
    'anthropic': {'model': 'public', 'messages': [{'role': 'user', 'content': '你好'}, {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'call1', 'name': 'read', 'input': {'path': 'a'}}]}, {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'call1', 'content': 'ok'}]}], 'tools': [{'name': 'read', 'input_schema': {'type': 'object'}}]},
    'responses': {'model': 'public', 'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': '你好'}]}, {'type': 'function_call', 'call_id': 'call1', 'name': 'read', 'arguments': '{"path":"a"}'}, {'type': 'function_call_output', 'call_id': 'call1', 'output': 'ok'}], 'tools': [{'type': 'function', 'name': 'read', 'parameters': {'type': 'object'}}]},
}
responses = {
    'openai': {'id': 'chat1', 'model': 'upstream', 'choices': [{'message': {'role': 'assistant', 'content': '你好', 'tool_calls': [{'id': 'call1', 'type': 'function', 'function': {'name': 'read', 'arguments': '{"path":"a"}'}}]}, 'finish_reason': 'tool_calls'}], 'usage': {'prompt_tokens': 12, 'completion_tokens': 4, 'prompt_tokens_details': {'cached_tokens': 3}, 'cache_creation_input_tokens': 2}},
    'anthropic': {'id': 'msg1', 'model': 'upstream', 'content': [{'type': 'text', 'text': '你好'}, {'type': 'tool_use', 'id': 'call1', 'name': 'read', 'input': {'path': 'a'}}], 'stop_reason': 'tool_use', 'usage': {'input_tokens': 7, 'output_tokens': 4, 'cache_read_input_tokens': 3, 'cache_creation_input_tokens': 2}},
    'responses': {'id': 'resp1', 'model': 'upstream', 'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '你好'}]}, {'type': 'function_call', 'call_id': 'call1', 'name': 'read', 'arguments': '{"path":"a"}'}], 'usage': {'input_tokens': 12, 'output_tokens': 4, 'input_tokens_details': {'cached_tokens': 3, 'cache_write_tokens': 2}}},
}
protocols = {'openai': 'openai-chat', 'anthropic': 'anthropic-messages', 'responses': 'openai-responses'}
for inbound in protocols:
    for upstream, native in protocols.items():
        current_test = f'migration_matrix_{inbound}_to_{upstream}'
        bridge.bridge_request_body(copy.deepcopy(requests[inbound]), inbound, native)
        bridge.bridge_response_body(copy.deepcopy(responses[upstream]), native, inbound, 'public')
artifact = {
    'source': str(SOURCE.relative_to(ROOT)),
    'sha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    'testSha256': hashlib.sha256(TEST.read_bytes()).hexdigest(),
    'pythonTestsPassed': count,
    'note': 'JSON converter calls; public stream traces are exported separately in python-stream-golden.json.',
    'cases': records,
}
out = ROOT / 'apps/api/test/fixtures/protocol/python-golden.json'
text = json.dumps(artifact, indent=2, ensure_ascii=False) + '\n'
if '--check' in sys.argv:
    if not out.exists() or out.read_text() != text:
        raise SystemExit('Python bridge fixtures drifted; inspect before regeneration')
else:
    out.write_text(text)
stream_artifact = {key: artifact[key] for key in ['source', 'sha256', 'testSha256', 'pythonTestsPassed']}
stream_artifact['note'] = 'Public method traces from unchanged Python stream tests; not Node runtime acceptance.'
stream_artifact['cases'] = stream_records
stream_out = out.with_name('python-stream-golden.json')
stream_text = json.dumps(stream_artifact, indent=2, ensure_ascii=False) + '\n'
if '--check' in sys.argv:
    if not stream_out.exists() or stream_out.read_text() != stream_text:
        raise SystemExit('Python stream fixtures drifted; inspect before regeneration')
else:
    stream_out.write_text(stream_text)
print(f'{count} Python tests passed; {len(records)} JSON fixtures and {len(stream_records)} stream traces verified')
