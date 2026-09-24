# -*- coding: utf-8 -*-
"""AI 提示词工坊 API - 基于数据库的模板管理"""

import re

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete

# 内置模板种子（表为空时自动写入，保证首次启动有示例数据）
_SEED_TEMPLATES = [
    {
        'name': '产品需求分析',
        'category': 'product',
        'description': '将原始需求整理为用户故事、验收标准与优先级建议',
        'content': '你是一位资深产品经理。请分析以下需求，给出用户故事、验收标准和优先级建议。\n\n需求描述：{{requirement}}\n\n目标用户：{{target_users}}\n\n请按以下格式输出：\n1. 用户故事\n2. 验收标准\n3. 优先级（P0/P1/P2）\n4. 技术风险',
        'variables': ['requirement', 'target_users'],
        'tags': '产品,需求',
    },
    {
        'name': '代码 Review',
        'category': 'dev',
        'description': '从性能、安全性、可读性和最佳实践角度审查代码',
        'content': '请对以下代码进行 Code Review，重点关注：性能、安全性、可读性和最佳实践。\n\n语言：{{language}}\n\n代码：\n```\n{{code}}\n```\n\n请给出具体的改进建议和示例。',
        'variables': ['language', 'code'],
        'tags': '开发,Review',
    },
    {
        'name': '市场文案生成',
        'category': 'marketing',
        'description': '为产品生成标题、卖点与 CTA 文案',
        'content': '你是一位专业文案策划师。请为以下产品撰写吸引用户的市场文案。\n\n产品名称：{{product_name}}\n产品特点：{{features}}\n目标受众：{{audience}}\n文案风格：{{tone}}\n\n请生成：1) 主标题  2) 副标题  3) 核心卖点（3条）  4) CTA 按钮文字',
        'variables': ['product_name', 'features', 'audience', 'tone'],
        'tags': '营销,文案',
    },
    {
        'name': '数据分析报告',
        'category': 'data',
        'description': '基于数据生成摘要、趋势与改进建议',
        'content': '请根据以下数据，生成一份专业的分析报告。\n\n数据时间范围：{{date_range}}\n数据来源：{{data_source}}\n关键指标：{{metrics}}\n\n请包含：摘要、趋势分析、异常点说明、改进建议。',
        'variables': ['date_range', 'data_source', 'metrics'],
        'tags': '数据,报告',
    },
    {
        'name': '会议纪要整理',
        'category': 'office',
        'description': '把会议记录整理成规范纪要并给出行动计划',
        'content': '请将以下会议记录整理成规范的会议纪要。\n\n会议主题：{{meeting_topic}}\n参会人员：{{participants}}\n会议时间：{{meeting_time}}\n\n原始记录：\n{{raw_notes}}\n\n输出格式：1) 会议背景  2) 讨论要点  3) 决议事项  4) 行动计划（负责人+截止日期）',
        'variables': ['meeting_topic', 'participants', 'meeting_time', 'raw_notes'],
        'tags': '办公,效率',
    },
]


def init_ai_prompt_api(bp, db, models):
    AiPromptTemplate = models['AiPromptTemplate']

    def normalize_tags(raw):
        """tags 兼容列表或逗号分隔字符串，统一存为逗号分隔字符串。"""
        if raw is None:
            return ''
        if isinstance(raw, list):
            return ','.join(str(t).strip() for t in raw if str(t).strip())
        return ','.join(t.strip() for t in str(raw).split(',') if t.strip())

    def seed_builtin_templates():
        """表为空时写入内置模板（按名称幂等，避免并发重复插入）。"""
        try:
            existing_names = {name for (name,) in db.session.query(AiPromptTemplate.name).all()}
        except Exception:
            db.session.rollback()
            return
        for data in _SEED_TEMPLATES:
            if data['name'] not in existing_names:
                db.session.add(AiPromptTemplate(**data))
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()

    @bp.route('/api/admin/component-center/ai/prompt/templates', methods=['GET'])
    @login_required
    def ai_prompt_templates_list():
        if not has_menu_permission('cc_ai_prompt'):
            return jsonify({'error': '无权限'}), 403
        seed_builtin_templates()
        category = (request.args.get('category') or '').strip()
        query = AiPromptTemplate.query
        if category:
            query = query.filter(AiPromptTemplate.category == category)
        items = query.order_by(AiPromptTemplate.id.asc()).all()
        result = [t.to_dict() for t in items]
        return jsonify({'data': result, 'total': len(result)})

    @bp.route('/api/admin/component-center/ai/prompt/templates', methods=['POST'])
    @login_required
    def ai_prompt_templates_create():
        if not has_menu_permission('cc_ai_prompt_add'):
            return jsonify({'error': '无权限新建模板'}), 403
        data = request.get_json() or {}
        name = (data.get('name') or '').strip()
        content = (data.get('content') or '').strip()
        if not name or not content:
            return jsonify({'error': '模板名称和内容不能为空'}), 400

        variables = list(set(re.findall(r'\{\{(\w+)\}\}', content)))
        template = AiPromptTemplate(
            name=name,
            category=(data.get('category') or 'custom').strip() or 'custom',
            description=(data.get('description') or '').strip() or None,
            content=content,
            variables=variables,
            tags=normalize_tags(data.get('tags')),
            is_active=data.get('is_active', True),
        )
        try:
            db.session.add(template)
            db.session.commit()
        except Exception:
            db.session.rollback()
            return jsonify({'error': '保存模板失败，请稍后重试'}), 500
        return jsonify(template.to_dict()), 201

    @bp.route('/api/admin/component-center/ai/prompt/templates/<int:template_id>', methods=['PUT'])
    @login_required
    def ai_prompt_templates_update(template_id):
        if not has_menu_permission('cc_ai_prompt_edit'):
            return jsonify({'error': '无权限编辑模板'}), 403
        template = db.session.get(AiPromptTemplate, template_id)
        if not template:
            return jsonify({'error': '模板不存在'}), 404
        data = request.get_json() or {}
        if 'name' in data:
            name = str(data.get('name') or '').strip()
            if not name:
                return jsonify({'error': '模板名称不能为空'}), 400
            template.name = name
        if 'category' in data:
            template.category = str(data.get('category') or 'custom').strip() or 'custom'
        if 'description' in data:
            template.description = str(data.get('description') or '').strip() or None
        if 'content' in data:
            content = str(data.get('content') or '').strip()
            if not content:
                return jsonify({'error': '模板内容不能为空'}), 400
            template.content = content
        if 'tags' in data:
            template.tags = normalize_tags(data.get('tags'))
        if 'is_active' in data:
            template.is_active = bool(data.get('is_active'))
        # 保存后根据正文重新提取变量
        template.variables = list(set(re.findall(r'\{\{(\w+)\}\}', template.content)))
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            return jsonify({'error': '保存模板失败，请稍后重试'}), 500
        return jsonify(template.to_dict())

    @bp.route('/api/admin/component-center/ai/prompt/templates/<int:template_id>', methods=['DELETE'])
    @login_required
    def ai_prompt_templates_delete(template_id):
        if not has_menu_permission('cc_ai_prompt_delete'):
            return jsonify({'error': '无权限删除模板'}), 403
        template = db.session.get(AiPromptTemplate, template_id)
        if not template:
            return jsonify({'error': '模板不存在'}), 404
        if is_enabled_for_delete(template):
            return jsonify({'error': enabled_delete_message('提示词模板')}), 409
        try:
            db.session.delete(template)
            db.session.commit()
        except Exception:
            db.session.rollback()
            return jsonify({'error': '删除模板失败，请稍后重试'}), 500
        return jsonify({'message': '删除成功'})

    @bp.route('/api/admin/component-center/ai/prompt/preview', methods=['POST'])
    @login_required
    def ai_prompt_preview():
        if not has_menu_permission('cc_ai_prompt'):
            return jsonify({'error': '无权限'}), 403
        data = request.get_json() or {}
        content = data.get('content') or ''
        variables = data.get('variables') or {}
        result = content
        for key, val in variables.items():
            result = result.replace(f'{{{{{key}}}}}', str(val))
        undefined_vars = re.findall(r'\{\{(\w+)\}\}', result)
        return jsonify({'preview': result, 'undefined_vars': undefined_vars})
