# -*- coding: utf-8 -*-
"""网页搜索后端配置 API。

配置本身存在通用的 app_settings 表里（复用 SettingsService），但它是网关的
能力配置而不是站点配置，所以走 agent 的菜单与权限。
"""

from flask import current_app, jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.admin.service.settings_service import SettingsService, SettingsServiceError


def init_agent_websearch_admin_api(bp, db, models):
    def svc():
        return SettingsService(db, models['AppSetting'])

    @bp.route('/api/admin/agent/web-search', methods=['GET', 'PUT'])
    @login_required
    def manage_agent_web_search():
        if request.method == 'GET':
            if not has_menu_permission('agent_websearch'):
                return jsonify({'error': '无权限查看网页搜索配置'}), 403
            return jsonify(svc().web_search_settings(current_app.config))

        if not has_menu_permission('agent_websearch_edit'):
            return jsonify({'error': '无权限编辑网页搜索配置'}), 403
        try:
            return jsonify(svc().update_web_search_settings(
                request.get_json() or {}, current_app.config,
            ))
        except SettingsServiceError as e:
            return jsonify({'error': e.message}), e.status_code

    @bp.route('/api/admin/agent/web-search/test', methods=['POST'])
    @login_required
    def test_agent_web_search():
        if not has_menu_permission('agent_websearch_edit'):
            return jsonify({'error': '无权限编辑网页搜索配置'}), 403
        try:
            return jsonify(svc().test_web_search_settings(current_app.config))
        except SettingsServiceError as e:
            return jsonify({'error': e.message}), e.status_code

    return bp
