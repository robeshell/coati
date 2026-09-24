# -*- coding: utf-8 -*-
"""缓存命中率测试 API"""

from flask import jsonify, request

from backend.common.auth import get_current_admin_user, has_menu_permission, login_required
from backend.common.pagination import parse_pagination
from backend.app.agent.service.cache_test_service import AgentCacheTestError, AgentCacheTestService
from backend.app.agent.service.gateway_service import AgentGatewayError, AgentGatewayService


def init_agent_cache_test_api(bp, db, models):
    def svc():
        return AgentCacheTestService(db, models)

    @bp.route('/api/admin/agent/cache-tests/models', methods=['GET'])
    @login_required
    def cache_test_models():
        """可用模型下拉：与网关 allowed_models 一致（含路由别名与个人渠道模型）。"""
        if not has_menu_permission('agent_cache_test'):
            return jsonify({'error': '无权限'}), 403
        try:
            gateway = AgentGatewayService(db, models)
            user = get_current_admin_user()
            names = gateway.allowed_models(user=user, inbound_protocol='openai')
            default_model = gateway.default_model()
        except AgentGatewayError:
            names = []
            default_model = None
        return jsonify({'models': names, 'default_model': default_model})

    @bp.route('/api/admin/agent/cache-tests', methods=['GET'])
    @login_required
    def list_cache_tests():
        if not has_menu_permission('agent_cache_test'):
            return jsonify({'error': '无权限'}), 403
        user = get_current_admin_user()
        page, per_page = parse_pagination()
        try:
            return jsonify(svc().list_tests(
                user.id, page=page, per_page=per_page,
                search=request.args.get('search'),
            ))
        except AgentCacheTestError as e:
            return jsonify({'error': e.message}), e.status_code

    @bp.route('/api/admin/agent/cache-tests', methods=['POST'])
    @login_required
    def run_cache_test():
        if not has_menu_permission('agent_cache_test_run'):
            return jsonify({'error': '无权限'}), 403
        user = get_current_admin_user()
        try:
            return jsonify(svc().run(user, request.get_json(silent=True) or {})), 201
        except AgentCacheTestError as e:
            return jsonify({'error': e.message, **e.payload}), e.status_code

    @bp.route('/api/admin/agent/cache-tests/<int:test_id>', methods=['GET'])
    @login_required
    def get_cache_test(test_id):
        if not has_menu_permission('agent_cache_test'):
            return jsonify({'error': '无权限'}), 403
        user = get_current_admin_user()
        try:
            return jsonify(svc().get_test(user.id, test_id))
        except AgentCacheTestError as e:
            return jsonify({'error': e.message}), e.status_code

    @bp.route('/api/admin/agent/cache-tests/<int:test_id>', methods=['DELETE'])
    @login_required
    def delete_cache_test(test_id):
        if not has_menu_permission('agent_cache_test_delete'):
            return jsonify({'error': '无权限'}), 403
        user = get_current_admin_user()
        try:
            return jsonify(svc().delete_test(user.id, test_id))
        except AgentCacheTestError as e:
            return jsonify({'error': e.message}), e.status_code
