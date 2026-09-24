# -*- coding: utf-8 -*-
"""AI 对话页 API - SSE 流式响应"""

import json
import os
import requests
from flask import jsonify, request, Response, stream_with_context
from backend.common.auth import has_menu_permission, login_required



def init_ai_chat_api(bp, db, models):

    @bp.route('/api/admin/component-center/ai/chat/stream', methods=['POST'])
    @login_required
    def ai_chat_stream():
        if not has_menu_permission('cc_ai_chat'):
            return jsonify({'error': '无权限'}), 403

        kimi_base = os.environ.get('AI_API_BASE', '')
        kimi_key = os.environ.get('AI_API_KEY', '')
        kimi_model = os.environ.get('AI_MODEL', '')

        if not kimi_key:
            return jsonify({'error': '未配置 AI_API_KEY'}), 500

        data = request.get_json() or {}
        # 前端传来完整的消息历史，格式：[{role, content}, ...]
        messages = data.get('messages') or []
        if not messages:
            return jsonify({'error': '消息不能为空'}), 400

        # 在最前面注入系统提示词，让 AI 了解 coati 项目背景
        system_prompt = {
            'role': 'system',
            'content': (
                '你是 coati 项目的专属 AI 助手。\n\n'
                '## 关于 coati\n'
                'coati 是一个 AI-First 的企业级全栈脚手架，核心理念是：PM 用自然语言描述需求，AI Agent 端到端实现功能。\n\n'
                '## 技术栈\n'
                '- 后端：Flask 3 + Flask-SQLAlchemy + PostgreSQL\n'
                '- 前端：React 18 + Vite + React Router\n'
                '- UI：Semi Design（字节跳动企业级组件库）\n'
                '- 图表：ECharts 6\n'
                '- 3D：Three.js\n'
                '- 编辑器：Monaco Editor（代码）、React Quill（富文本）\n'
                '- 权限：完整的 RBAC 菜单权限体系（用户/角色/菜单三张表）\n\n'
                '## 核心功能模块\n'
                '1. 系统管理：用户管理、角色权限、菜单管理、日志审计、数据字典、定时任务\n'
                '2. 组件示例中心（共 28 个页面）：\n'
                '   - 管理系统类：列表页、统计列表、卡片列表、树形列表、动态表单、看板、详情标签、甘特图、高级表格\n'
                '   - 数据可视化：数据大屏、实时折线图、热力日历图、地图热力图\n'
                '   - 3D/创意：粒子连线、CSS 3D 卡片、Three.js 地球、粒子形态变换\n'
                '   - AI 应用：AI 对话（即你当前所在页面）、AI 提示词工坊、AI 数据查询\n'
                '   - 编辑器：富文本、代码编辑器、JSON 编辑器、Markdown 预览\n'
                '   - 工程工具：拖拽布局、虚拟滚动、WebSocket 通信、性能监控\n\n'
                '## 开发约定\n'
                '- API 路由统一前缀：/api/admin/...\n'
                '- 前端动态路由：通过 import.meta.glob 扫描 pages/**/index.jsx\n'
                '- 权限检查：has_menu_permission(code) 装饰器\n'
                '- 默认账号：admin（密码以部署配置为准）\n'
                '- 开发端口：后端 5001，前端 5173（Vite）\n\n'
                '请用中文回答，回答要结合 coati 的实际技术栈和实现方式。'
            ),
        }
        full_messages = [system_prompt] + messages

        def generate():
            try:
                resp = requests.post(
                    f'{kimi_base}/chat/completions',
                    headers={
                        'Authorization': f'Bearer {kimi_key}',
                        'Content-Type': 'application/json',
                    },
                    json={
                        'model': kimi_model,
                        'messages': full_messages,
                        'stream': True,
                    },
                    stream=True,
                    timeout=60,
                )

                if resp.status_code != 200:
                    # 不向客户端透传上游响应体（可能含内部信息），仅给通用错误码
                    yield f'data: {json.dumps({"error": f"AI 服务暂时不可用（{resp.status_code}），请稍后重试"}, ensure_ascii=False)}\n\n'
                    yield 'data: [DONE]\n\n'
                    return

                for line in resp.iter_lines():
                    if not line:
                        continue
                    line = line.decode('utf-8')
                    if not line.startswith('data:'):
                        continue
                    raw = line[5:].strip()
                    if raw == '[DONE]':
                        yield 'data: [DONE]\n\n'
                        return
                    try:
                        chunk = json.loads(raw)
                        delta = chunk['choices'][0]['delta']
                        content = delta.get('content', '')
                        if content:
                            yield f'data: {json.dumps({"content": content}, ensure_ascii=False)}\n\n'
                    except Exception:
                        continue

                yield 'data: [DONE]\n\n'

            except requests.exceptions.Timeout:
                yield f'data: {json.dumps({"error": "请求超时，请重试"}, ensure_ascii=False)}\n\n'
                yield 'data: [DONE]\n\n'
            except Exception:
                # 不向客户端输出原始异常（str(e) 可能含内部细节），仅通用文案
                yield f'data: {json.dumps({"error": "AI 响应异常，请稍后重试"}, ensure_ascii=False)}\n\n'
                yield 'data: [DONE]\n\n'

        return Response(
            stream_with_context(generate()),
            mimetype='text/event-stream',
            headers={
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',
            }
        )
