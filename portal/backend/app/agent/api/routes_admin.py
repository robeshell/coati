# -*- coding: utf-8 -*-
"""模型路由管理 API"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.common.pagination import parse_pagination
from backend.app.agent.service.route_service import AgentRouteError, AgentRouteService


def init_agent_routes_admin_api(bp, db, models):
    def svc():
        return AgentRouteService(db, models)

    @bp.route('/api/admin/agent/routes', methods=['GET'])
    @login_required
    def list_routes():
        if not has_menu_permission('agent_routes'):
            return jsonify({'error': '无权限'}), 403
        page, per_page = parse_pagination()
        return jsonify(svc().list_routes(
            page=page, per_page=per_page, search=request.args.get('search'),
            enabled=request.args.get('enabled'), provider=request.args.get('provider'),
            credential_id=request.args.get('credential_id'),
            include_summary=request.args.get('include_summary'),
        ))

    @bp.route('/api/admin/agent/routes', methods=['POST'])
    @login_required
    def create_route():
        if not has_menu_permission('agent_routes_add'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().create(request.get_json() or {})), 201
        except AgentRouteError as e:
            return jsonify({'error': e.message, **e.payload}), e.status_code

    @bp.route('/api/admin/agent/routes/<int:route_id>', methods=['PUT'])
    @login_required
    def update_route(route_id):
        if not has_menu_permission('agent_routes_edit'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().update(route_id, request.get_json() or {}))
        except AgentRouteError as e:
            return jsonify({'error': e.message, **e.payload}), e.status_code

    @bp.route('/api/admin/agent/routes/<int:route_id>', methods=['DELETE'])
    @login_required
    def delete_route(route_id):
        if not has_menu_permission('agent_routes_delete'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().delete(route_id))
        except AgentRouteError as e:
            return jsonify({'error': e.message, **e.payload}), e.status_code
