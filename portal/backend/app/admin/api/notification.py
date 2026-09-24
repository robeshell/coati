# -*- coding: utf-8 -*-
"""通知消息 API 层"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required, get_current_admin_user
from backend.common.pagination import parse_pagination
from backend.app.admin.service.notification import NotificationService, NotificationServiceError


def init_notification_api(bp, db, models):
    service = NotificationService(db, models)

    def _current_user():
        return get_current_admin_user()

    def handle_service_error(error):
        # 5xx 不向客户端暴露内部细节
        if error.status_code >= 500:
            return jsonify({'error': '服务器内部错误，请稍后重试'}), error.status_code
        return jsonify({'error': error.message, **error.payload}), error.status_code

    @bp.route('/api/admin/notifications', methods=['GET', 'POST'])
    @login_required
    def manage_notifications():
        user = _current_user()
        if user is None:
            return jsonify({'error': '用户不存在'}), 404

        if request.method == 'GET':
            page, per_page = parse_pagination()
            is_read_filter = request.args.get('is_read', 'all').strip()  # 'true'/'false'/'all'
            try:
                return jsonify(service.list_items(user.id, page=page, per_page=per_page, is_read_filter=is_read_filter))
            except NotificationServiceError as e:
                return handle_service_error(e)

        # POST: create notification (admin only)
        if not has_menu_permission('system_notifications_add'):
            return jsonify({'error': '无权限创建通知'}), 403

        data = request.get_json() or {}
        try:
            payload, status = service.create_item(data)
            return jsonify(payload), status
        except NotificationServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/notifications/unread-count', methods=['GET'])
    @login_required
    def get_unread_count():
        user = _current_user()
        if user is None:
            return jsonify({'count': 0})
        try:
            return jsonify({'count': service.unread_count(user.id)})
        except NotificationServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/notifications/<int:noti_id>/read', methods=['POST'])
    @login_required
    def mark_notification_read(noti_id):
        user = _current_user()
        if user is None:
            return jsonify({'error': '用户不存在'}), 404
        try:
            return jsonify(service.mark_read(user.id, noti_id))
        except NotificationServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/notifications/read-all', methods=['POST'])
    @login_required
    def mark_all_notifications_read():
        user = _current_user()
        if user is None:
            return jsonify({'error': '用户不存在'}), 404
        try:
            return jsonify(service.mark_all_read(user.id))
        except NotificationServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/notifications/<int:noti_id>', methods=['DELETE'])
    @login_required
    def delete_notification(noti_id):
        user = _current_user()
        if user is None:
            return jsonify({'error': '用户不存在'}), 404

        can_delete_global = has_menu_permission('system_notifications_delete')
        try:
            return jsonify(service.delete_item(user.id, noti_id, can_delete_global))
        except NotificationServiceError as e:
            return handle_service_error(e)
