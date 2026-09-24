# -*- coding: utf-8 -*-
"""请求记录与配额管理查询。"""

from flask import jsonify, request

from backend.common.auth import get_current_admin_user, has_menu_permission, login_required
from backend.common.pagination import parse_pagination
from backend.app.agent.service.usage_service import AgentUsageError, AgentUsageService
from backend.app.agent.schema.common import AgentValidationError
from backend.app.agent.schema.usage import normalize_usage_filters


def init_agent_usage_api(bp, db, models):
    def svc():
        return AgentUsageService(db, models)

    @bp.route('/api/admin/agent/usage', methods=['GET'])
    @login_required
    def admin_list_usage():
        if not has_menu_permission('agent_usage'):
            return jsonify({'error': '无权限'}), 403
        page, per_page = parse_pagination()
        try:
            filters = normalize_usage_filters(request.args)
            return jsonify(svc().list_admin(page=page, per_page=per_page, **filters))
        except AgentValidationError as e:
            return jsonify({'error': str(e)}), 400

    @bp.route('/api/admin/agent/usage/analytics', methods=['GET'])
    @login_required
    def admin_usage_analytics():
        if not has_menu_permission('agent_usage'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().analytics(**normalize_usage_filters(request.args)))
        except AgentValidationError as e:
            return jsonify({'error': str(e)}), 400

    @bp.route('/api/admin/agent/quotas', methods=['GET'])
    @login_required
    def admin_list_quotas():
        if not has_menu_permission('agent_usage'):
            return jsonify({'error': '无权限'}), 403
        page, per_page = parse_pagination()
        return jsonify(svc().list_quotas(
            page=page, per_page=per_page, search=request.args.get('search'),
        ))

    @bp.route('/api/agent/me/usage', methods=['GET'])
    @login_required
    def my_usage():
        user = get_current_admin_user()
        page, per_page = parse_pagination()
        try:
            filters = normalize_usage_filters(request.args)
            filters.pop('user_id', None)
            return jsonify(svc().list_mine(user.id, page=page, per_page=per_page, **filters))
        except AgentValidationError as e:
            return jsonify({'error': str(e)}), 400

    @bp.route('/api/agent/me/usage/analytics', methods=['GET'])
    @login_required
    def my_usage_analytics():
        user = get_current_admin_user()
        try:
            filters = normalize_usage_filters(request.args)
            filters.pop('user_id', None)
            return jsonify(svc().analytics_mine(user.id, **filters))
        except AgentValidationError as e:
            return jsonify({'error': str(e)}), 400

    @bp.route('/api/agent/me/usage/export', methods=['POST'])
    @login_required
    def my_usage_export():
        if not has_menu_permission('agent_my_usage_export'):
            return jsonify({'error': '无权限'}), 403
        user = get_current_admin_user()
        try:
            return svc().export_mine(user.id, request.get_json() or {})
        except AgentUsageError as e:
            return jsonify({'error': e.message, **e.payload}), e.status_code

    @bp.route('/api/admin/agent/quotas/<int:user_id>', methods=['PUT'])
    @login_required
    def admin_update_quota(user_id):
        if not has_menu_permission('agent_usage_quota_edit'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().update_quota(user_id, request.get_json() or {}))
        except AgentUsageError as e:
            return jsonify({'error': e.message, **e.payload}), e.status_code
