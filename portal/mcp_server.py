#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
coati MCP Server

暴露 coati 开发工具为 MCP 协议，让 Claude Desktop 等 MCP 客户端
无需命令行即可驱动完整的功能开发流程。

安装依赖：
  pip install mcp

配置到 Claude Desktop（~/Library/Application Support/Claude/claude_desktop_config.json）：
  {
    "mcpServers": {
      "coati": {
        "command": "python3",
        "args": ["/path/to/coati/mcp_server.py"]
      }
    }
  }

工具列表：
  get_project_context   返回 AGENTS.md + 当前模块树（Step 1 用）
  get_menu_tree         返回当前菜单结构（推断 parent_id 用）
  scaffold_feature      生成代码骨架文件
  run_verify            运行 verify_feature.py，返回 JSON
  init_rbac             运行 init_rbac_data.py --incremental
  run_migration         flask db migrate + upgrade
  list_templates        返回可用模板列表
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

try:
    import mcp.server.stdio
    from mcp.server import Server
    from mcp.types import TextContent, Tool
except ImportError:
    print(
        "错误：缺少 mcp 依赖，请运行：pip install mcp",
        file=sys.stderr,
    )
    sys.exit(1)

ROOT = Path(__file__).resolve().parent
VENV_PYTHON = ROOT / 'venv' / 'bin' / 'python'
PYTHON_BIN = str(VENV_PYTHON if VENV_PYTHON.exists() else Path(sys.executable))

server = Server('coati')


# ─── 工具定义 ──────────────────────────────────────────────────────────────────

@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name='get_project_context',
            description=(
                '返回 coati 项目上下文，包含 AGENTS.md 全文和当前模块结构。'
                '实现新功能前必须先调用此工具。'
            ),
            inputSchema={'type': 'object', 'properties': {}, 'required': []},
        ),
        Tool(
            name='get_menu_tree',
            description='返回当前数据库中的菜单树结构，用于确定新菜单的 parent_id 和下一个可用 ID。',
            inputSchema={'type': 'object', 'properties': {}, 'required': []},
        ),
        Tool(
            name='scaffold_feature',
            description=(
                '根据规格生成代码骨架文件（model/crud/service/api + 前端页面）。'
                '生成后还需补充业务逻辑。'
            ),
            inputSchema={
                'type': 'object',
                'properties': {
                    'name': {
                        'type': 'string',
                        'description': '资源名，snake_case，如 customer',
                    },
                    'domain': {
                        'type': 'string',
                        'enum': ['admin', 'component_center'],
                        'description': '所属域',
                    },
                    'fields': {
                        'type': 'string',
                        'description': '字段列表，格式 "name:str,phone:str20,amount:float"',
                    },
                    'dry_run': {
                        'type': 'boolean',
                        'description': '只预览不写文件，默认 false',
                        'default': False,
                    },
                },
                'required': ['name'],
            },
        ),
        Tool(
            name='run_verify',
            description=(
                '运行 verify_feature.py 门禁检查，返回结构化 JSON 结果。'
                '功能实现完成后必须调用，全部通过才算交付。'
            ),
            inputSchema={
                'type': 'object',
                'properties': {
                    'module': {
                        'type': 'string',
                        'description': '模块名，snake_case，如 customer',
                    },
                    'skip_build': {
                        'type': 'boolean',
                        'description': '是否跳过前端构建（耗时），默认 false',
                        'default': False,
                    },
                },
                'required': ['module'],
            },
        ),
        Tool(
            name='init_rbac',
            description='运行 init_rbac_data.py --incremental，同步菜单和权限到数据库。',
            inputSchema={'type': 'object', 'properties': {}, 'required': []},
        ),
        Tool(
            name='run_migration',
            description='执行 flask db migrate + flask db upgrade，生成并应用数据库迁移。',
            inputSchema={
                'type': 'object',
                'properties': {
                    'message': {
                        'type': 'string',
                        'description': '迁移描述，如 "add customer table"',
                    },
                },
                'required': ['message'],
            },
        ),
        Tool(
            name='list_templates',
            description='返回 docs/templates/ 下可用的代码模板列表及说明。',
            inputSchema={'type': 'object', 'properties': {}, 'required': []},
        ),
    ]


# ─── 工具实现 ──────────────────────────────────────────────────────────────────

def _run(cmd: list[str], cwd: Path | None = None) -> tuple[int, str]:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd or ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    return proc.returncode, proc.stdout


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:

    # ── get_project_context ──────────────────────────────────────────────────
    if name == 'get_project_context':
        agents_md = ROOT / 'AGENTS.md'
        content = agents_md.read_text(encoding='utf-8') if agents_md.exists() else '（AGENTS.md 不存在）'

        # 当前模块列表
        be_domains = []
        for domain_dir in (ROOT / 'backend' / 'app').iterdir():
            if domain_dir.is_dir() and not domain_dir.name.startswith('_'):
                api_dir = domain_dir / 'api'
                modules = [p.stem for p in api_dir.glob('*.py') if p.stem not in ('__init__', 'router')] if api_dir.exists() else []
                be_domains.append(f"  {domain_dir.name}/: {', '.join(modules)}")

        result = f"{content}\n\n---\n\n## 当前后端模块\n\n" + '\n'.join(be_domains)
        return [TextContent(type='text', text=result)]

    # ── get_menu_tree ────────────────────────────────────────────────────────
    elif name == 'get_menu_tree':
        script = """
import sys
sys.path.insert(0, '.')
from app import app
from backend.app import db

with app.app_context():
    from sqlalchemy import text
    rows = db.session.execute(text(
        'SELECT id, name, code, parent_id, menu_type, path, component, sort_order '
        'FROM menus ORDER BY COALESCE(parent_id, 0), sort_order, id'
    )).fetchall()
    import json
    print(json.dumps([dict(r._mapping) for r in rows], ensure_ascii=False, default=str))
"""
        code, output = _run([PYTHON_BIN, '-c', script])
        if code != 0:
            return [TextContent(type='text', text=f'查询菜单失败：{output}')]

        menus = json.loads(output.strip())
        # 按层级格式化
        lines = [f"共 {len(menus)} 个菜单项", '']
        by_parent: dict[int | None, list] = {}
        for m in menus:
            by_parent.setdefault(m.get('parent_id'), []).append(m)

        def fmt(items: list, indent: int = 0) -> None:
            for m in items:
                prefix = '  ' * indent
                lines.append(f"{prefix}ID={m['id']}  {m['name']} ({m['code']})  {m.get('menu_type', '')}")
                if m['id'] in {item.get('parent_id') for item in menus}:
                    fmt(by_parent.get(m['id'], []), indent + 1)

        fmt(by_parent.get(None, []))
        max_id = max(m['id'] for m in menus) if menus else 0
        lines.append(f'\n当前最大 ID：{max_id}，建议下一个 ID：{max_id + 1}')
        return [TextContent(type='text', text='\n'.join(lines))]

    # ── scaffold_feature ─────────────────────────────────────────────────────
    elif name == 'scaffold_feature':
        resource_name = arguments['name']
        domain = arguments.get('domain', 'admin')
        fields = arguments.get('fields', 'name:str')
        dry_run = arguments.get('dry_run', False)

        cmd = [PYTHON_BIN, 'backend/scripts/scaffold.py',
               '--name', resource_name,
               '--domain', domain,
               '--fields', fields]
        if dry_run:
            cmd.append('--dry-run')

        code, output = _run(cmd)
        status = '✅ 成功' if code == 0 else '❌ 失败'
        return [TextContent(type='text', text=f'{status}\n\n{output}')]

    # ── run_verify ───────────────────────────────────────────────────────────
    elif name == 'run_verify':
        module = arguments['module']
        skip_build = arguments.get('skip_build', False)

        cmd = [PYTHON_BIN, 'backend/scripts/verify_feature.py',
               '--module', module, '--json']
        if skip_build:
            cmd.append('--skip-build')

        code, output = _run(cmd)
        try:
            result = json.loads(output.strip())
        except json.JSONDecodeError:
            result = {'passed': False, 'raw': output}

        return [TextContent(type='text', text=json.dumps(result, ensure_ascii=False, indent=2))]

    # ── init_rbac ────────────────────────────────────────────────────────────
    elif name == 'init_rbac':
        code, output = _run([PYTHON_BIN, 'backend/scripts/init_rbac_data.py', '--incremental'])
        status = '✅ RBAC 同步成功' if code == 0 else '❌ RBAC 同步失败'
        return [TextContent(type='text', text=f'{status}\n\n{output[-2000:]}')]

    # ── run_migration ────────────────────────────────────────────────────────
    elif name == 'run_migration':
        message = arguments.get('message', 'auto migration')

        # 设置 FLASK_APP 环境变量
        import os
        env = {**os.environ, 'FLASK_APP': 'app.py'}

        # migrate
        proc = subprocess.run(
            ['flask', 'db', 'migrate', '-d', 'backend/migrations', '-m', message],
            cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, env=env,
        )
        migrate_output = proc.stdout

        # upgrade
        proc2 = subprocess.run(
            ['flask', 'db', 'upgrade', '-d', 'backend/migrations'],
            cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, env=env,
        )
        upgrade_output = proc2.stdout

        passed = proc.returncode == 0 and proc2.returncode == 0
        status = '✅ 迁移成功' if passed else '❌ 迁移失败'
        return [TextContent(type='text', text=f'{status}\n\nmigrate:\n{migrate_output}\n\nupgrade:\n{upgrade_output}')]

    # ── list_templates ───────────────────────────────────────────────────────
    elif name == 'list_templates':
        templates_dir = ROOT / 'docs' / 'templates'
        if not templates_dir.exists():
            return [TextContent(type='text', text='docs/templates/ 目录不存在，请先创建模板。')]

        lines = ['可用代码模板：', '']
        for d in sorted(templates_dir.iterdir()):
            if d.is_dir():
                files = [f.name for f in sorted(d.rglob('*')) if f.is_file()]
                lines.append(f'📁 {d.name}/')
                for f in files:
                    lines.append(f'   {f}')
                lines.append('')

        return [TextContent(type='text', text='\n'.join(lines))]

    else:
        return [TextContent(type='text', text=f'未知工具：{name}')]


# ─── 入口 ──────────────────────────────────────────────────────────────────────

async def main():
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


if __name__ == '__main__':
    import asyncio
    asyncio.run(main())
