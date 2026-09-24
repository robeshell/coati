#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 Flask 路由生成/补齐 OpenAPI paths，合并到 docs/apifox-full.openapi.json。

- 保留文档中已有的详细路径定义，只为缺失的路由补上基础条目（通用响应）。
- 补出的条目是「骨架」（仅通用 responses、无 requestBody/parameters/content），
  覆盖率统计会区分 详细路径 vs 骨架路径，避免骨架虚高覆盖率。
- 用法：
    python3 backend/scripts/generate_openapi.py             # 补齐并写回
    python3 backend/scripts/generate_openapi.py --dry-run   # 只统计，不写回
    python3 backend/scripts/generate_openapi.py --strict    # 存在骨架路径则退出非 0
"""

import argparse
import json
import sys
from pathlib import Path

current_dir = Path(__file__).resolve().parent
project_root = current_dir.parents[1]
sys.path.insert(0, str(project_root))

DOC_PATH = project_root / 'docs' / 'apifox-full.openapi.json'

# 跳过的方法
_SKIP_METHODS = {'HEAD', 'OPTIONS', 'TRACE'}


def _flask_to_openapi_path(rule: str) -> str:
    """把 Flask 路由 <int:user_id> 转成 OpenAPI {user_id}"""
    return rule.replace('<', '{').replace('>', '}')


def _is_stub_entry(entry) -> bool:
    """骨架路径：所有 method 都只有通用 responses，无 requestBody/parameters/content。

    这类条目由本脚本自动补齐，不含人工维护的 schema 细节。
    """
    if not isinstance(entry, dict):
        return True
    for op in entry.values():
        if not isinstance(op, dict):
            continue
        if op.get('requestBody') or op.get('parameters'):
            return False
        responses = op.get('responses') or {}
        for resp in responses.values():
            if isinstance(resp, dict) and resp.get('content'):
                return False
    return True


def _path_stats(paths) -> dict:
    total = len(paths)
    stubs = sum(1 for entry in paths.values() if _is_stub_entry(entry))
    return {'total': total, 'detailed': total - stubs, 'stubs': stubs}


def main() -> int:
    parser = argparse.ArgumentParser(description='从 Flask 路由补齐 OpenAPI paths')
    parser.add_argument('--dry-run', action='store_true', help='只统计不写回')
    parser.add_argument('--strict', action='store_true', help='存在骨架路径时退出非 0（供 CI 把关）')
    args = parser.parse_args()

    from app import app

    doc = json.loads(DOC_PATH.read_text(encoding='utf-8'))
    paths = doc.setdefault('paths', {})

    added = 0
    for rule in app.url_map.iter_rules():
        if not rule.rule.startswith('/api/'):
            continue
        path = _flask_to_openapi_path(rule.rule)
        if path in paths:
            continue
        entry = {}
        for method in sorted(rule.methods or []):
            method = method.upper()
            if method in _SKIP_METHODS:
                continue
            entry[method] = {
                'summary': f'{method} {path}',
                'responses': {
                    '200': {'description': '成功'},
                    '400': {'description': '请求参数错误'},
                    '401': {'description': '未授权'},
                    '403': {'description': '无权限'},
                    '404': {'description': '资源不存在'},
                    '500': {'description': '服务器内部错误'},
                },
            }
        if entry:
            paths[path] = entry
            added += 1

    stats = _path_stats(paths)
    print(f'补齐 {added} 个路径（均为骨架，需人工补 schema）')
    print(
        f'文档路径统计：总数 {stats["total"]}，'
        f'详细 {stats["detailed"]}（{stats["detailed"] / stats["total"] * 100:.0f}%），'
        f'骨架 {stats["stubs"]}'
    )

    if not args.dry_run:
        doc['paths'] = dict(sorted(paths.items()))
        DOC_PATH.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'已写回 {DOC_PATH.relative_to(project_root)}')

    if args.strict and stats['stubs']:
        print(f'❌ --strict：仍有 {stats["stubs"]} 个骨架路径，请补充 schema 后再提交')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
