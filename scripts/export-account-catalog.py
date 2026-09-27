"""Export immutable catalog contracts from the local Python migration reference."""
import ast
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
constants = root / 'portal/backend/app/agent/constants.py'
adapters = root / 'portal/backend/app/agent/service/provider_adapters.py'
values = {}
for node in ast.parse(constants.read_text()).body:
    if isinstance(node, ast.Assign):
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(constants), 'exec'), {}, values)
classes = {}
fields = ('code', 'label', 'protocol', 'available', 'description', 'default_base_url', 'default_model', 'default_models')
for node in ast.parse(adapters.read_text()).body:
    if not isinstance(node, ast.ClassDef):
        continue
    data = {}
    for base in node.bases:
        if isinstance(base, ast.Name):
            data.update(classes.get(base.id, {}))
    for entry in node.body:
        if isinstance(entry, ast.Assign):
            for name in entry.targets:
                if isinstance(name, ast.Name) and name.id in fields:
                    data[name.id] = ast.literal_eval(entry.value)
    classes[node.name] = data
providers = []
for name in ('DeepSeekAdapter', 'OpenAIAdapter', 'GenericOpenAIAdapter', 'AnthropicAdapter', 'GeminiReservedAdapter'):
    row = classes[name]
    providers.append({**row, 'status': 'available' if row['available'] else 'reserved'})
result = {
    'sources': {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in (constants, adapters)},
    'providers': providers,
    'protocols': list(values['UPSTREAM_PROTOCOLS'].values()),
}
output = root / 'apps/api/test/fixtures/python-account-catalog.json'
output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
