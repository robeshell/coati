# -*- coding: utf-8 -*-
"""Agent 鉴权 API：PAT + Device Code"""

from flask import g, jsonify, request

from backend.common.auth import get_current_admin_user, has_menu_permission, login_required
from backend.common.pagination import parse_pagination
from backend.app.agent.service.auth_service import AgentAuthError, AgentAuthService
from backend.app.agent.schema.auth import normalize_pat_payload, normalize_pat_update_payload
from backend.app.agent.schema.common import AgentValidationError
from backend.app.agent.schema.usage import normalize_usage_filters
from backend.app.agent.service.bearer import agent_scope_required
from backend.app.agent.service.usage_service import AgentUsageService


def init_agent_auth_api(bp, db, models):
    def svc():
        return AgentAuthService(db, models)

    def handle(err: AgentAuthError):
        body = {'error': err.message, **err.payload}
        return jsonify(body), err.status_code

    @bp.route('/api/agent/auth/pat', methods=['POST'])
    @login_required
    def create_pat():
        if not has_menu_permission('agent_pat_add'):
            return jsonify({'error': '无权限'}), 403
        user = get_current_admin_user()
        data = request.get_json() or {}
        try:
            payload = normalize_pat_payload(data)
            return jsonify(svc().create_pat(user.id, **payload)), 201
        except AgentValidationError as e:
            return jsonify({'error': str(e)}), 400
        except AgentAuthError as e:
            return handle(e)

    @bp.route('/api/agent/auth/pat', methods=['GET'])
    @login_required
    def list_pats():
        if not has_menu_permission('agent_pat'):
            return jsonify({'error': '无权限'}), 403
        user = get_current_admin_user()
        page, per_page = parse_pagination()
        return jsonify(svc().list_pats(
            user.id, page=page, per_page=per_page, search=request.args.get('search'),
            status=request.args.get('status'), token_type=request.args.get('token_type'),
        ))

    @bp.route('/api/agent/auth/pat/<int:pat_id>/rotate', methods=['POST'])
    @login_required
    def rotate_pat(pat_id):
        if not has_menu_permission('agent_pat_rotate'):
            return jsonify({'error': '无权限'}), 403
        user = get_current_admin_user()
        try:
            return jsonify(svc().rotate_pat(user.id, pat_id)), 201
        except AgentAuthError as e:
            return handle(e)

    @bp.route('/api/agent/auth/pat/<int:pat_id>', methods=['PUT'])
    @login_required
    def update_pat(pat_id):
        if not has_menu_permission('agent_pat_edit'):
            return jsonify({'error': '无权限'}), 403
        user = get_current_admin_user()
        try:
            payload = normalize_pat_update_payload(request.get_json() or {})
            return jsonify(svc().update_pat(user.id, pat_id, **payload))
        except AgentValidationError as e:
            return jsonify({'error': str(e)}), 400
        except AgentAuthError as e:
            return handle(e)

    @bp.route('/api/agent/auth/pat/<int:pat_id>/usage', methods=['GET'])
    @login_required
    def pat_usage(pat_id):
        if not has_menu_permission('agent_pat'):
            return jsonify({'error': '无权限'}), 403
        user = get_current_admin_user()
        if not svc().crud.get_pat_for_user(pat_id, user.id):
            return jsonify({'error': '令牌不存在'}), 404
        page, per_page = parse_pagination()
        try:
            filters = normalize_usage_filters(request.args)
            filters.pop('user_id', None)
            filters['pat_id'] = pat_id
            return jsonify(AgentUsageService(db, models).list_mine(
                user.id, page=page, per_page=per_page, **filters,
            ))
        except AgentValidationError as e:
            return jsonify({'error': str(e)}), 400

    @bp.route('/api/agent/auth/pat/<int:pat_id>', methods=['DELETE'])
    @login_required
    def revoke_pat(pat_id):
        if not has_menu_permission('agent_pat_delete'):
            return jsonify({'error': '无权限'}), 403
        user = get_current_admin_user()
        try:
            return jsonify(svc().revoke_pat(user.id, pat_id))
        except AgentAuthError as e:
            return handle(e)

    @bp.route('/api/agent/auth/device/start', methods=['POST'])
    def device_start():
        try:
            return jsonify(svc().start_device_flow())
        except AgentAuthError as e:
            return handle(e)

    @bp.route('/api/agent/auth/device/poll', methods=['POST'])
    def device_poll():
        data = request.get_json() or {}
        try:
            return jsonify(svc().poll_device(data.get('device_code')))
        except AgentAuthError as e:
            return handle(e)

    @bp.route('/api/agent/auth/device/confirm', methods=['POST'])
    @login_required
    def device_confirm():
        if not has_menu_permission('agent_device_confirm_action'):
            return jsonify({'error': '无权限'}), 403
        user = get_current_admin_user()
        data = request.get_json() or {}
        try:
            return jsonify(svc().confirm_device(user.id, data.get('user_code')))
        except AgentAuthError as e:
            return handle(e)

    @bp.route('/api/agent/me', methods=['GET'])
    @agent_scope_required('profile')
    def agent_me():
        from backend.app.agent.service.usage_service import AgentUsageService
        user = g.agent_user
        quota = AgentUsageService(db, models).quota_summary(user.id)
        payload = user.to_dict() if hasattr(user, 'to_dict') else {'id': user.id, 'username': getattr(user, 'username', None)}
        return jsonify({'user': payload, 'quota': quota})
