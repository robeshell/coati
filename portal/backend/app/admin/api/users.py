# -*- coding: utf-8 -*-
"""用户模块 API 层"""

from flask import jsonify, request, session

from backend.common.auth import has_menu_permission, login_required
from backend.app.admin.model.access import get_admin_model, get_role_model
from backend.app.admin.service.users import UserService, UserServiceError
from backend.common.pagination import parse_pagination


def init_users_api(bp, db, models):
    Admin = get_admin_model(models)
    service = UserService(db, Admin, get_role_model(models))

    def current_username():
        return session.get('username')

    def handle_service_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    @bp.route('/api/admin/users', methods=['GET', 'POST'])
    @login_required
    def manage_users():
        if request.method == 'GET':
            if not has_menu_permission('system_users'):
                return jsonify({'error': '无权限查看用户列表'}), 403
            page, per_page = parse_pagination()
            search = request.args.get('search', '').strip()
            return jsonify(service.list_users(page=page, per_page=per_page, search=search))

        if not has_menu_permission('system_users_add'):
            return jsonify({'error': '无权限新增用户'}), 403

        try:
            payload, status = service.create_user(request.get_json() or {})
            return jsonify(payload), status
        except UserServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/users/<int:user_id>', methods=['PUT', 'DELETE'])
    @login_required
    def update_user(user_id):
        user = service.crud.get_user_or_404(user_id)

        if request.method == 'DELETE':
            if not has_menu_permission('system_users_delete'):
                return jsonify({'error': '无权限删除用户'}), 403
            try:
                return jsonify(service.delete_user(user, current_username()))
            except UserServiceError as e:
                return handle_service_error(e)

        if not has_menu_permission('system_users_edit'):
            return jsonify({'error': '无权限编辑用户'}), 403
        try:
            return jsonify(service.update_user(user, request.get_json() or {}))
        except UserServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/users/export', methods=['POST'])
    @login_required
    def export_users():
        if not has_menu_permission('system_users'):
            return jsonify({'error': '无权限导出用户'}), 403
        try:
            return service.export_users(request.get_json() or {})
        except UserServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/users/template', methods=['GET'])
    @login_required
    def download_users_template():
        if not has_menu_permission('system_users'):
            return jsonify({'error': '无权限下载用户导入模板'}), 403
        try:
            return service.download_template(request.args.get('file_type'))
        except UserServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/users/import', methods=['POST'])
    @login_required
    def import_users():
        if not has_menu_permission('system_users_edit'):
            return jsonify({'error': '无权限导入用户'}), 403
        try:
            return jsonify(service.import_users(request.files.get('file')))
        except UserServiceError as e:
            return handle_service_error(e)
