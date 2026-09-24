#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
coati 功能验证门禁

用法：
  python3 backend/scripts/verify_feature.py --module customer
  python3 backend/scripts/verify_feature.py --module customer --skip-build
  python3 backend/scripts/verify_feature.py --module agent --service-only
  python3 backend/scripts/verify_feature.py --module customer --json   # 输出结构化 JSON（供 AI/MCP 读取）

检查项：
  1. Python 语法编译（全量，含 backend/scripts 与 migrations）
  2. 后端路由文件存在
  3. 前端页面文件存在
  4. 前端 API 文件存在
  5. Router 注册检查
  6. RBAC 种子文件包含权限编码
  7. 迁移链完整（单根线性无分叉，可拦截多 head）
  8. OpenAPI 文档同步（告警）
  9. 前端构建通过（可选，耗时）
  10. 前端 Vitest 测试通过（可选，耗时）
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VENV_PYTHON = ROOT / '.venv' / 'bin' / 'python'
PYTHON_BIN = str(VENV_PYTHON if VENV_PYTHON.exists() else Path(sys.executable))


def run(cmd: list[str], cwd: Path | None = None) -> tuple[int, str]:
    process = subprocess.run(
        cmd,
        cwd=str(cwd or ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return process.returncode, process.stdout


# ─── 单项检查 ──────────────────────────────────────────────────────────────────

def check_python_compile() -> dict:
    """Python 语法编译检查（全量，含 scripts 与 migrations）"""
    targets = ['app.py']
    for layer_dir in ['backend/common', 'backend/app', 'backend/scripts', 'backend/migrations/versions']:
        base = ROOT / layer_dir
        if base.exists():
            targets += [str(p.relative_to(ROOT)) for p in sorted(base.rglob('*.py'))]

    code, output = run([PYTHON_BIN, '-m', 'py_compile', *targets])
    if code != 0:
        return {'name': 'python_compile', 'passed': False, 'error': output.strip()[:500]}
    return {'name': 'python_compile', 'passed': True}


def check_migration_chain() -> dict:
    """迁移链完整性：单根、线性（无分叉）、无缺失 down_revision。

    分叉会造成多个 head，`flask db upgrade` 会报 Multiple head revisions 失败；
    本检查直接读取迁移文件还原依赖图，无需连接数据库。
    """
    versions_dir = ROOT / 'backend' / 'migrations' / 'versions'
    if not versions_dir.exists():
        return {'name': 'migration_chain', 'passed': True, 'skipped': True}

    rev_re = re.compile(r"^revision\s*=\s*'([^']+)'", re.MULTILINE)
    down_re = re.compile(r"^down_revision\s*=\s*'([^']+)'", re.MULTILINE)

    revs = {}   # revision -> (down_revision, filename)
    for f in sorted(versions_dir.glob('*.py')):
        text = f.read_text(encoding='utf-8')
        m = rev_re.search(text)
        if not m:
            continue
        d = down_re.search(text)
        revs[m.group(1)] = (d.group(1) if d else None, f.name)

    if not revs:
        return {'name': 'migration_chain', 'passed': True, 'skipped': True}

    # 非根迁移必须声明 down_revision；多根/多 head 即分叉
    orphans = [r for r, (d, _) in revs.items() if d is not None and d not in revs]

    children = {r: [] for r in revs}
    for r, (d, _) in revs.items():
        if d in children:
            children[d].append(r)

    roots = [r for r in revs if revs[r][0] is None]
    heads = [r for r in revs if not children[r]]
    # 线性链：有向图无分叉 ⇔ 根/头各只有一个且节点数一致
    branched = len(roots) != 1 or len(heads) != 1

    if orphans or branched:
        details = []
        if len(roots) != 1:
            details.append(f'多个根（多支缺失 down_revision）: {roots}')
        if len(heads) != 1:
            details.append(f'多个 head: {heads}（存在分叉，flask db upgrade 会失败）')
        if orphans:
            details.append(f'down_revision 指向未定义祖先: {orphans}')
        return {
            'name': 'migration_chain', 'passed': False,
            'error': '迁移链异常：' + '；'.join(details),
        }
    return {'name': 'migration_chain', 'passed': True, 'head': heads[0]}


def check_backend_file(module: str) -> dict:
    """后端路由/API 文件存在"""
    domain_api = ROOT / 'backend' / 'app' / module / 'api'
    if domain_api.is_dir() and any(domain_api.glob('*.py')):
        return {'name': 'backend_file', 'passed': True, 'path': str(domain_api.relative_to(ROOT))}
    singular = module[:-1] if module.endswith('s') else module
    candidates = [
        ROOT / 'backend' / 'app' / 'admin' / 'api' / f'{module}.py',
        ROOT / 'backend' / 'app' / 'admin' / 'api' / f'{singular}.py',
        ROOT / 'backend' / 'app' / 'component_center' / 'api' / f'{module}.py',
        ROOT / 'backend' / 'app' / 'component_center' / 'api' / f'{singular}.py',
        # 带 _page 后缀的 component_center 页面
        ROOT / 'backend' / 'app' / 'component_center' / 'api' / f'{module}_page.py',
    ]
    found = next((p for p in candidates if p.exists()), None)
    if found:
        return {'name': 'backend_file', 'passed': True, 'path': str(found.relative_to(ROOT))}
    return {
        'name': 'backend_file', 'passed': False,
        'error': f'未找到后端 API 文件，检查路径：' + ', '.join(str(p.relative_to(ROOT)) for p in candidates[:3]),
    }


def check_frontend_page(module: str) -> dict:
    """前端页面 index.jsx 存在"""
    singular = module[:-1] if module.endswith('s') else module
    domain_pages = ROOT / 'frontend' / 'src' / 'modules' / module / 'pages'
    if domain_pages.is_dir() and any(domain_pages.rglob('index.jsx')):
        return {'name': 'frontend_page', 'passed': True, 'path': str(domain_pages.relative_to(ROOT))}

    # 搜索所有模块下的页面目录
    search_dirs = [
        ROOT / 'frontend' / 'src' / 'modules' / module / 'pages',
        ROOT / 'frontend' / 'src' / 'modules' / 'admin' / 'pages',
        ROOT / 'frontend' / 'src' / 'modules' / 'component_center' / 'pages',
    ]
    for base in search_dirs:
        if not base.exists():
            continue
        # 递归搜索匹配的 index.jsx
        for p in base.rglob('index.jsx'):
            parent = p.parent.name
            if parent in (module, singular, f'{module}_page', f'{singular}_page'):
                return {'name': 'frontend_page', 'passed': True, 'path': str(p.relative_to(ROOT))}

    return {
        'name': 'frontend_page', 'passed': False,
        'error': f'未找到前端页面文件 index.jsx，目录名应为 {module} 或 {singular} 或 {module}_page',
    }


def check_frontend_api(module: str) -> dict:
    """前端 API 文件存在"""
    singular = module[:-1] if module.endswith('s') else module
    domain_api = ROOT / 'frontend' / 'src' / 'modules' / module / 'api'
    if domain_api.is_dir() and any(domain_api.glob('*.js')):
        return {'name': 'frontend_api', 'passed': True, 'path': str(domain_api.relative_to(ROOT))}
    candidates = [
        ROOT / 'frontend' / 'src' / 'modules' / 'admin' / 'api' / f'{module}.js',
        ROOT / 'frontend' / 'src' / 'modules' / 'admin' / 'api' / f'{singular}.js',
        ROOT / 'frontend' / 'src' / 'modules' / 'component_center' / 'api' / f'{module}.js',
        ROOT / 'frontend' / 'src' / 'modules' / 'component_center' / 'api' / f'{singular}.js',
        ROOT / 'frontend' / 'src' / 'modules' / 'component_center' / 'api' / f'{module}_page.js',
    ]
    found = next((p for p in candidates if p.exists()), None)
    if found:
        return {'name': 'frontend_api', 'passed': True, 'path': str(found.relative_to(ROOT))}
    return {
        'name': 'frontend_api', 'passed': False,
        'error': f'未找到前端 API 文件，检查路径：' + ', '.join(str(p.relative_to(ROOT)) for p in candidates[:3]),
    }


def check_router_registration(module: str) -> dict:
    """Router 注册检查：解析 router 文件中真实调用的 init_*_api，精确匹配"""
    singular = module[:-1] if module.endswith('s') else module
    router_files = [
        ROOT / 'backend' / 'app' / 'router.py',
        ROOT / 'backend' / 'app' / 'admin' / 'api' / 'router.py',
        ROOT / 'backend' / 'app' / 'component_center' / 'api' / 'router.py',
    ]
    registered = set()
    domain_registration = f'register_{module}_routes'
    for f in router_files:
        if f.exists():
            router_text = f.read_text(encoding='utf-8')
            registered.update(re.findall(r'init_([a-z0-9_]+)_api\s*\(', router_text))
            if re.search(rf'\b{re.escape(domain_registration)}\s*\(', router_text):
                return {'name': 'router_registration', 'passed': True, 'registered': [domain_registration]}

    matched = {module, singular} & registered
    if matched:
        return {'name': 'router_registration', 'passed': True, 'registered': sorted(matched)}
    return {
        'name': 'router_registration', 'passed': False,
        'error': (
            f'router 中未注册 init_{module}_api / init_{singular}_api；'
            f'已注册: {sorted(registered) or "无"}。请在 domain/api/router.py 中调用'
        ),
    }


def check_rbac_seed(module: str) -> dict:
    """RBAC 种子：菜单数据里必须有对应 component 路径或 cc_<module> 权限码（精确匹配）"""
    singular = module[:-1] if module.endswith('s') else module
    seed_file = ROOT / 'backend' / 'scripts' / 'init_rbac_data.py'
    if not seed_file.exists():
        return {'name': 'rbac_seed', 'passed': False, 'error': 'init_rbac_data.py 不存在'}

    text = seed_file.read_text(encoding='utf-8')
    codes = set(re.findall(r"'code':\s*'([^']+)'", text))
    components = set(re.findall(r"'component':\s*'([^']+)'", text))

    # 组件路径以 /<module> 或 /<module>_page 结尾（如 component_center/ai/ai_sql_page / admin/users）
    comp_match = any(
        comp.endswith(f'/{module}') or comp.endswith(f'/{module}_page')
        or comp.endswith(f'/{singular}') or comp.endswith(f'/{singular}_page')
        for comp in components
    )
    code_match = module in codes or singular in codes or f'cc_{module}' in codes or f'cc_{singular}' in codes

    if comp_match or code_match:
        return {'name': 'rbac_seed', 'passed': True}
    return {
        'name': 'rbac_seed', 'passed': False,
        'error': (
            f'种子数据中未找到 {module} 的菜单（component 路径或 cc_{module} 权限码），'
            '请在 init_rbac_data.py 添加菜单/按钮后运行 --incremental'
        ),
    }


def check_no_local_has_permission() -> dict:
    """API 层不允许自定义 has_permission"""
    api_root = ROOT / 'backend' / 'app'
    if not api_root.exists():
        return {'name': 'no_local_has_permission', 'passed': True}

    offenders = []
    for path in sorted(api_root.rglob('*.py')):
        if '/api/' not in path.as_posix():
            continue
        if 'def has_permission(' in path.read_text(encoding='utf-8'):
            offenders.append(str(path.relative_to(ROOT)))

    if offenders:
        return {
            'name': 'no_local_has_permission', 'passed': False,
            'error': f'以下文件含有非法的 has_permission 定义（应使用 backend/common/auth.py）：{offenders}',
        }
    return {'name': 'no_local_has_permission', 'passed': True}


def check_service_layer(module: str) -> dict:
    """领域 Service 不得越层直接查询或提交数据库。"""
    service_dir = ROOT / 'backend' / 'app' / module / 'service'
    if not service_dir.is_dir():
        return {'name': 'service_layer', 'passed': True, 'skipped': True}
    offenders = []
    for path in service_dir.glob('*.py'):
        text = path.read_text(encoding='utf-8')
        if '.query' in text or 'db.session' in text or 'self.db' in text:
            offenders.append(str(path.relative_to(ROOT)))
    if offenders:
        return {'name': 'service_layer', 'passed': False,
                'error': f'Service 存在越层数据库访问，应下沉到 CRUD：{offenders}'}
    return {'name': 'service_layer', 'passed': True}


def _openapi_is_stub_path(entry) -> bool:
    """骨架路径：所有 method 只有通用 responses，无 requestBody/parameters/content。

    由 generate_openapi.py 自动补齐的条目，不含人工维护的 schema，不计入真实覆盖率。
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


def check_openapi_sync() -> dict:
    """OpenAPI 文档同步度（告警性质，不阻断门禁；骨架路径不计入覆盖率）"""
    doc_path = ROOT / 'docs' / 'apifox-full.openapi.json'
    if not doc_path.exists():
        return {'name': 'openapi_sync', 'passed': True, 'skipped': True}
    try:
        doc = json.loads(doc_path.read_text(encoding='utf-8'))
        doc_paths = {
            path: entry
            for path, entry in (doc.get('paths', {}) or {}).items()
            if not _openapi_is_stub_path(entry)
        }
    except Exception:
        return {'name': 'openapi_sync', 'passed': True, 'skipped': True}

    api_root = ROOT / 'backend' / 'app'
    routes = set()
    route_re = re.compile(r"@bp\.route\(['\"]([^'\"]+)")
    for path in api_root.rglob('*.py'):
        if '/api/' not in path.as_posix():
            continue
        for m in route_re.finditer(path.read_text(encoding='utf-8')):
            routes.add(m.group(1))

    ratio = (len(doc_paths) / len(routes) * 100) if routes else 0
    if ratio < 80:
        return {
            'name': 'openapi_sync', 'passed': True, 'warn': True,
            'detail': (
                f'OpenAPI 详细路径 {len(doc_paths)} vs 后端路由 {len(routes)}（覆盖率 {ratio:.0f}%），'
                '建议运行 backend/scripts/generate_openapi.py 补齐并补充 schema'
            ),
        }
    return {'name': 'openapi_sync', 'passed': True}


def check_frontend_build(skip: bool) -> dict:
    """前端构建"""
    if skip:
        return {'name': 'frontend_build', 'passed': True, 'skipped': True}
    code, output = run(['npm', 'run', 'build'], cwd=ROOT / 'frontend')
    if code != 0:
        return {'name': 'frontend_build', 'passed': False, 'error': output[-1000:]}
    return {'name': 'frontend_build', 'passed': True}


def check_frontend_tests(skip: bool) -> dict:
    """前端 Vitest 测试（含 @ 别名导入完整性回归）"""
    if skip:
        return {'name': 'frontend_tests', 'passed': True, 'skipped': True}
    code, output = run(['npm', 'test'], cwd=ROOT / 'frontend')
    if code != 0:
        return {'name': 'frontend_tests', 'passed': False, 'error': output[-1000:]}
    return {'name': 'frontend_tests', 'passed': True}


# ─── 主流程 ────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description='coati 功能验证门禁')
    parser.add_argument('--module', help='模块名（snake_case），如 customer')
    parser.add_argument(
        '--service-only', action='store_true',
        help='内部服务能力：跳过页面、API 路由与 RBAC 检查',
    )
    parser.add_argument('--skip-build', action='store_true', help='跳过前端构建检查（耗时）')
    parser.add_argument('--skip-frontend-tests', action='store_true', help='跳过前端 Vitest 检查（耗时）')
    parser.add_argument('--json', action='store_true', dest='output_json', help='输出结构化 JSON（供 AI/MCP 读取）')
    parser.add_argument('--run-rbac-sync', action='store_true', help='执行 init_rbac_data.py --incremental')
    args = parser.parse_args()

    results: list[dict] = []

    # 全局检查
    results.append(check_python_compile())
    results.append(check_no_local_has_permission())
    results.append(check_migration_chain())
    results.append(check_openapi_sync())

    # 模块级检查
    if args.module:
        if not args.service_only:
            results.append(check_backend_file(args.module))
            results.append(check_frontend_page(args.module))
            results.append(check_frontend_api(args.module))
            results.append(check_router_registration(args.module))
            results.append(check_rbac_seed(args.module))
        results.append(check_service_layer(args.module))

    # RBAC 同步
    if args.run_rbac_sync:
        code, output = run([PYTHON_BIN, 'backend/scripts/init_rbac_data.py', '--incremental'])
        results.append({
            'name': 'rbac_sync',
            'passed': code == 0,
            'error': output.strip()[:500] if code != 0 else None,
        })

    # 前端构建 + 测试
    results.append(check_frontend_build(skip=args.skip_build))
    results.append(check_frontend_tests(skip=args.skip_frontend_tests))

    # 汇总
    passed = all(r['passed'] for r in results)
    failures = [r for r in results if not r['passed'] and not r.get('skipped')]

    if args.output_json:
        print(json.dumps({
            'passed': passed,
            'module': args.module,
            'service_only': args.service_only,
            'checks': results,
            'summary': f"{len(results) - len(failures)}/{len(results)} 项通过",
        }, ensure_ascii=False, indent=2))
        return 0 if passed else 1

    # 人类可读输出
    print('== coati 功能验证 ==')
    print()
    for r in results:
        icon = '✅' if r['passed'] else ('⏭️ ' if r.get('skipped') else '❌')
        name = r['name'].replace('_', ' ')
        print(f"  {icon} {name}")
        if not r['passed'] and not r.get('skipped') and r.get('error'):
            print(f"      → {r['error']}")
        elif r.get('warn') and r.get('detail'):
            print(f"      ⚠️ {r['detail']}")
    print()

    if passed:
        print('✅ 全部检查通过，功能可交付！')
    else:
        print(f'❌ {len(failures)} 项检查未通过，请修复后重新验证。')

    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
