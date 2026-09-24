# -*- coding: utf-8 -*-
"""角色模块 API 层"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.admin.model.access import get_menu_model, get_role_model
from backend.app.admin.service.roles import RoleService, RoleServiceError


def init_roles_api(bp, db, models):
    service = RoleService(db, get_role_model(models), get_menu_model(models))

    def handle_service_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    @bp.route('/api/admin/roles', methods=['GET', 'POST'])
    @login_required
    def manage_roles():
        if request.method == 'GET':
            if not has_menu_permission('system_roles'):
                return jsonify({'error': '无权限查看角色列表'}), 403
            return jsonify(service.list_roles())

        if not has_menu_permission('system_roles_add'):
            return jsonify({'error': '无权限新增角色'}), 403

        try:
            payload, status = service.create_role(request.get_json() or {})
            return jsonify(payload), status
        except RoleServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/roles/<int:role_id>', methods=['PUT', 'DELETE'])
    @login_required
    def update_role(role_id):
        role = service.crud.get_role_or_404(role_id)

        if request.method == 'DELETE':
            if not has_menu_permission('system_roles_delete'):
                return jsonify({'error': '无权限删除角色'}), 403
            try:
                return jsonify(service.delete_role(role))
            except RoleServiceError as e:
                return handle_service_error(e)

        if not has_menu_permission('system_roles_edit'):
            return jsonify({'error': '无权限编辑角色'}), 403
        try:
            return jsonify(service.update_role(role, request.get_json() or {}))
        except RoleServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/roles/export', methods=['POST'])
    @login_required
    def export_roles():
        if not has_menu_permission('system_roles'):
            return jsonify({'error': '无权限导出角色'}), 403

        try:
            return service.export_roles(request.get_json() or {})
        except RoleServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/roles/template', methods=['GET'])
    @login_required
    def download_roles_template():
        if not has_menu_permission('system_roles'):
            return jsonify({'error': '无权限下载角色导入模板'}), 403

        try:
            return service.download_template(request.args.get('file_type'))
        except RoleServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/roles/import', methods=['POST'])
    @login_required
    def import_roles():
        if not has_menu_permission('system_roles_edit'):
            return jsonify({'error': '无权限导入角色'}), 403

        try:
            return jsonify(service.import_roles(request.files.get('file')))
        except RoleServiceError as e:
            return handle_service_error(e)
