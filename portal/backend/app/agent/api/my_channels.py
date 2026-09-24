# -*- coding: utf-8 -*-
"""用户自己的模型渠道 API。"""

from flask import jsonify, request

from backend.common.auth import get_current_admin_user, has_menu_permission, login_required
from backend.common.pagination import parse_pagination
from backend.app.agent.service.credential_service import AgentCredentialError, AgentCredentialService


def init_agent_my_channels_api(bp, db, models):
    def svc():
        return AgentCredentialService(db, models)

    def handle(err: AgentCredentialError):
        return jsonify({'error': err.message, **err.payload}), err.status_code

    def current_user_id():
        return get_current_admin_user().id

    @bp.route('/api/admin/agent/my-channels/providers', methods=['GET'])
    @login_required
    def list_my_channel_providers():
        if not has_menu_permission('agent_my_channels'):
            return jsonify({'error': '无权限'}), 403
        return jsonify(svc().providers())

    @bp.route('/api/admin/agent/my-channels/upstream-protocols', methods=['GET'])
    @login_required
    def list_my_channel_upstream_protocols():
        if not has_menu_permission('agent_my_channels'):
            return jsonify({'error': '无权限'}), 403
        return jsonify(svc().upstream_protocols())

    @bp.route('/api/admin/agent/my-channels', methods=['GET'])
    @login_required
    def list_my_channels():
        if not has_menu_permission('agent_my_channels'):
            return jsonify({'error': '无权限'}), 403
        page, per_page = parse_pagination()
        return jsonify(svc().list_personal(
            current_user_id(),
            page=page, per_page=per_page, search=request.args.get('search'),
            enabled=request.args.get('enabled'),
            upstream_protocol=request.args.get('upstream_protocol'),
            provider=request.args.get('provider'),
            health_status=request.args.get('health_status'),
        ))

    @bp.route('/api/admin/agent/my-channels/discover-models', methods=['POST'])
    @login_required
    def discover_my_channel_models():
        if not has_menu_permission('agent_my_channels_test'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().discover_personal(current_user_id(), request.get_json() or {}))
        except AgentCredentialError as e:
            return handle(e)

    @bp.route('/api/admin/agent/my-channels/<int:channel_id>/check', methods=['POST'])
    @login_required
    def check_my_channel(channel_id):
        if not has_menu_permission('agent_my_channels_test'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().check_personal(current_user_id(), channel_id))
        except AgentCredentialError as e:
            return handle(e)

    @bp.route('/api/admin/agent/my-channels', methods=['POST'])
    @login_required
    def create_my_channel():
        if not has_menu_permission('agent_my_channels_add'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().create_personal(current_user_id(), request.get_json() or {})), 201
        except AgentCredentialError as e:
            return handle(e)

    @bp.route('/api/admin/agent/my-channels/<int:channel_id>', methods=['PUT'])
    @login_required
    def update_my_channel(channel_id):
        if not has_menu_permission('agent_my_channels_edit'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().update_personal(current_user_id(), channel_id, request.get_json() or {}))
        except AgentCredentialError as e:
            return handle(e)

    @bp.route('/api/admin/agent/my-channels/<int:channel_id>', methods=['DELETE'])
    @login_required
    def delete_my_channel(channel_id):
        if not has_menu_permission('agent_my_channels_delete'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().delete_personal(current_user_id(), channel_id))
        except AgentCredentialError as e:
            return handle(e)
