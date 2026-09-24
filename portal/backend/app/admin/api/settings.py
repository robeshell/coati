# -*- coding: utf-8 -*-
"""系统设置 API 层"""

from flask import current_app, jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.admin.service.settings_service import SettingsService, SettingsServiceError


def init_settings_api(bp, db, models):
    service = SettingsService(db, models['AppSetting'])

    @bp.route('/api/admin/settings/desktop-update', methods=['GET', 'PUT'])
    @login_required
    def manage_desktop_update_settings():
        if request.method == 'GET':
            if not has_menu_permission('system_settings'):
                return jsonify({'error': '无权限查看系统设置'}), 403
            return jsonify(service.desktop_update_settings(current_app.config))

        if not has_menu_permission('system_settings_edit'):
            return jsonify({'error': '无权限编辑系统设置'}), 403
        try:
            return jsonify(service.update_desktop_update_settings(request.get_json() or {}))
        except SettingsServiceError as e:
            return jsonify({'error': e.message}), e.status_code

    @bp.route('/api/admin/settings/site-download', methods=['GET', 'PUT'])
    @login_required
    def manage_site_download_settings():
        if request.method == 'GET':
            if not has_menu_permission('system_settings'):
                return jsonify({'error': '无权限查看系统设置'}), 403
            return jsonify(service.site_download_settings(current_app.config))

        if not has_menu_permission('system_settings_edit'):
            return jsonify({'error': '无权限编辑系统设置'}), 403
        try:
            return jsonify(service.update_site_download_settings(request.get_json() or {}))
        except SettingsServiceError as e:
            return jsonify({'error': e.message}), e.status_code

    return bp
