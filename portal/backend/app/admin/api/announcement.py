# -*- coding: utf-8 -*-
"""公告管理 API 层"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.admin.service.announcement_service import AnnouncementService, AnnouncementServiceError, EXPORT_FIELD_MAP
from backend.common.pagination import parse_pagination


def init_announcement_api(bp, db, models):
    def _svc():
        return AnnouncementService(db, models.get('Announcement'))

    def handle_service_error(error):
        # 5xx 不向客户端暴露内部细节（避免 DB 约束/连接错误泄漏）
        if error.status_code >= 500:
            return jsonify({'error': '服务器内部错误，请稍后重试'}), error.status_code
        return jsonify({'error': error.message, **error.payload}), error.status_code

    @bp.route('/api/admin/announcements', methods=['GET'])
    @login_required
    def list_announcements():
        if not has_menu_permission('system_announcements'):
            return jsonify({'error': '无权限'}), 403
        page, per_page = parse_pagination()
        search = request.args.get('search', '').strip()
        status = request.args.get('status', '').strip() or None
        announce_type = request.args.get('announce_type', '').strip() or None
        result = _svc().list_items(page=page, per_page=per_page, search=search,
                                   status=status, announce_type=announce_type)
        return jsonify(result)

    @bp.route('/api/admin/announcements', methods=['POST'])
    @login_required
    def create_announcement():
        if not has_menu_permission('system_announcements_add'):
            return jsonify({'error': '无权限'}), 403
        data = request.get_json() or {}
        try:
            item, status_code = _svc().create_item(data)
            return jsonify(item), status_code
        except AnnouncementServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/announcements/<int:item_id>', methods=['PUT'])
    @login_required
    def update_announcement(item_id):
        if not has_menu_permission('system_announcements_edit'):
            return jsonify({'error': '无权限'}), 403
        data = request.get_json() or {}
        try:
            item = _svc().require_item(item_id)
            result = _svc().update_item(item, data)
            return jsonify(result)
        except AnnouncementServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/announcements/<int:item_id>', methods=['DELETE'])
    @login_required
    def delete_announcement(item_id):
        if not has_menu_permission('system_announcements_delete'):
            return jsonify({'error': '无权限'}), 403
        try:
            item = _svc().require_item(item_id)
            result = _svc().delete_item(item)
            return jsonify(result)
        except AnnouncementServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/announcements/<int:item_id>/publish', methods=['POST'])
    @login_required
    def publish_announcement(item_id):
        if not has_menu_permission('system_announcements_edit'):
            return jsonify({'error': '无权限'}), 403
        try:
            item = _svc().require_item(item_id)
            result = _svc().publish_item(item)
            return jsonify(result)
        except AnnouncementServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/announcements/<int:item_id>/unpublish', methods=['POST'])
    @login_required
    def unpublish_announcement(item_id):
        if not has_menu_permission('system_announcements_edit'):
            return jsonify({'error': '无权限'}), 403
        try:
            item = _svc().require_item(item_id)
            result = _svc().unpublish_item(item)
            return jsonify(result)
        except AnnouncementServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/announcements/export', methods=['POST'])
    @login_required
    def export_announcements():
        if not has_menu_permission('system_announcements_export'):
            return jsonify({'error': '无权限'}), 403
        data = request.get_json() or {}
        try:
            return _svc().export_items(data)
        except AnnouncementServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/announcements/template', methods=['GET'])
    @login_required
    def download_announcement_template():
        if not has_menu_permission('system_announcements_import'):
            return jsonify({'error': '无权限'}), 403
        try:
            return _svc().download_template(request.args.get('file_type'))
        except AnnouncementServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/announcements/import', methods=['POST'])
    @login_required
    def import_announcements():
        if not has_menu_permission('system_announcements_import'):
            return jsonify({'error': '无权限'}), 403
        file = request.files.get('file')
        try:
            result = _svc().import_items(file)
            return jsonify(result)
        except AnnouncementServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/announcements/export-fields', methods=['GET'])
    @login_required
    def get_announcement_export_fields():
        fields = [{'label': v[0], 'value': k} for k, v in EXPORT_FIELD_MAP.items()]
        return jsonify(fields)
