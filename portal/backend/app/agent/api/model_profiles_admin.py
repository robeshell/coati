# -*- coding: utf-8 -*-
"""统一模型能力档案管理 API。"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.common.pagination import parse_pagination
from backend.app.agent.schema.common import boolean
from backend.app.agent.service.model_profile_service import (
    AgentModelProfileError,
    AgentModelProfileService,
)


def init_agent_model_profiles_admin_api(bp, db, models):
    def svc():
        return AgentModelProfileService(db, models)

    def handle(err):
        return jsonify({'error': err.message, **err.payload}), err.status_code

    @bp.route('/api/admin/agent/model-profiles', methods=['GET'])
    @login_required
    def list_model_profiles():
        if not has_menu_permission('agent_model_profiles'):
            return jsonify({'error': '无权限'}), 403
        page, per_page = parse_pagination()
        return jsonify(svc().list_items(
            page=page, per_page=per_page,
            search=request.args.get('search'), enabled=request.args.get('enabled'),
        ))

    @bp.route('/api/admin/agent/model-profiles/candidates', methods=['GET'])
    @login_required
    def list_model_profile_candidates():
        if not has_menu_permission('agent_model_profiles'):
            return jsonify({'error': '无权限'}), 403
        return jsonify(svc().candidates(request.args.get('search')))

    @bp.route('/api/admin/agent/model-profiles/sync', methods=['POST'])
    @login_required
    def sync_model_profiles():
        if not has_menu_permission('agent_model_profiles_edit'):
            return jsonify({'error': '无权限同步模型能力'}), 403
        body = request.get_json(silent=True) or {}
        force = boolean(body.get('force'), True)
        return jsonify(svc().sync(force=bool(force)))

    @bp.route('/api/admin/agent/model-profiles', methods=['POST'])
    @login_required
    def create_model_profile():
        if not has_menu_permission('agent_model_profiles_add'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().create(request.get_json() or {})), 201
        except AgentModelProfileError as err:
            return handle(err)

    @bp.route('/api/admin/agent/model-profiles/<int:profile_id>', methods=['PUT'])
    @login_required
    def update_model_profile(profile_id):
        if not has_menu_permission('agent_model_profiles_edit'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().update(profile_id, request.get_json() or {}))
        except AgentModelProfileError as err:
            return handle(err)

    @bp.route('/api/admin/agent/model-profiles/<int:profile_id>', methods=['DELETE'])
    @login_required
    def delete_model_profile(profile_id):
        if not has_menu_permission('agent_model_profiles_delete'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().delete(profile_id))
        except AgentModelProfileError as err:
            return handle(err)
