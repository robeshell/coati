# -*- coding: utf-8 -*-
"""菜单模块 API 层（controller）"""

from flask import jsonify, request

from backend.common.auth import get_current_admin_user, has_menu_permission, login_required
from backend.app.admin.model.access import get_menu_model
from backend.app.admin.service.menu import MenuService, MenuServiceError


def init_menus_api(bp, db, models):
    service = MenuService(db, get_menu_model(models))

    def handle_service_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    @bp.route('/api/admin/menus', methods=['GET', 'POST'])
    @login_required
    def manage_menus():
        if request.method == 'GET':
            if not has_menu_permission('system_menus'):
                return jsonify({'error': '无权限查看菜单列表'}), 403
            format_type = request.args.get('format', 'tree')
            search = request.args.get('search', '').strip()
            return jsonify(service.list_menus(format_type=format_type, search=search))

        if not has_menu_permission('system_menus_add'):
            return jsonify({'error': '无权限新增菜单'}), 403

        try:
            result, status = service.create_menu(request.get_json() or {})
            return jsonify(result), status
        except MenuServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/menus/<int:menu_id>', methods=['GET', 'PUT', 'DELETE'])
    @login_required
    def manage_menu(menu_id):
        menu = service.crud.get_or_404(menu_id)

        if request.method == 'GET':
            if not has_menu_permission('system_menus'):
                return jsonify({'error': '无权限查看菜单'}), 403
            return jsonify(menu.to_dict(include_children=True))

        if request.method == 'PUT':
            if not has_menu_permission('system_menus_edit'):
                return jsonify({'error': '无权限编辑菜单'}), 403
            try:
                return jsonify(service.update_menu(menu, request.get_json() or {}))
            except MenuServiceError as e:
                return handle_service_error(e)

        if not has_menu_permission('system_menus_delete'):
            return jsonify({'error': '无权限删除菜单'}), 403

        try:
            return jsonify(service.delete_menu(menu))
        except MenuServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/menus/<int:menu_id>/sort', methods=['POST'])
    @login_required
    def sort_menu(menu_id):
        if not has_menu_permission('system_menus_edit'):
            return jsonify({'error': '无权限排序菜单'}), 403

        menu = service.crud.get_or_404(menu_id)
        direction = (request.get_json() or {}).get('direction')
        try:
            return jsonify(service.sort_menu(menu, direction))
        except MenuServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/my-menus', methods=['GET'])
    @login_required
    def get_my_menus():
        return jsonify(service.get_my_menus(get_current_admin_user()))

    @bp.route('/api/admin/menus/export', methods=['POST'])
    @login_required
    def export_menus():
        if not has_menu_permission('system_menus'):
            return jsonify({'error': '无权限导出菜单'}), 403

        try:
            return service.export_menus(request.get_json() or {})
        except MenuServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/menus/template', methods=['GET'])
    @login_required
    def download_menus_template():
        if not has_menu_permission('system_menus'):
            return jsonify({'error': '无权限下载菜单导入模板'}), 403

        try:
            return service.download_template(request.args.get('file_type'))
        except MenuServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/menus/import', methods=['POST'])
    @login_required
    def import_menus():
        if not has_menu_permission('system_menus_edit'):
            return jsonify({'error': '无权限导入菜单'}), 403

        try:
            return jsonify(service.import_menus(request.files.get('file')))
        except MenuServiceError as e:
            return handle_service_error(e)
