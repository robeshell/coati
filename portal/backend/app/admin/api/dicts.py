# -*- coding: utf-8 -*-
"""数据字典 API 层"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.admin.model.dicts import get_dict_item_model, get_dict_type_model
from backend.app.admin.schema.dicts import parse_bool
from backend.app.admin.service.dicts import DictsService, DictsServiceError
from backend.common.pagination import parse_pagination


def init_dicts_api(bp, db, models):
    service = DictsService(db, get_dict_type_model(models), get_dict_item_model(models))

    def handle_service_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    @bp.route('/api/admin/dicts/options', methods=['GET'])
    @login_required
    def get_dict_options():
        # 故意不加菜单权限：供所有登录用户跨模块下拉使用（如表单选择项）
        try:
            raw_codes = (request.args.get('codes') or '').strip()
            return jsonify(service.get_dict_options(raw_codes))
        except DictsServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/dicts', methods=['GET', 'POST'])
    @login_required
    def manage_dict_types():
        if request.method == 'GET':
            if not has_menu_permission('system_dicts'):
                return jsonify({'error': '无权限查看数据字典'}), 403

            page, per_page = parse_pagination()
            search = request.args.get('search', '').strip()
            is_active = parse_bool(request.args.get('is_active'))
            return jsonify(service.list_dict_types(
                page=page,
                per_page=per_page,
                search=search,
                is_active=is_active,
            ))

        if not has_menu_permission('system_dicts_add'):
            return jsonify({'error': '无权限新增数据字典'}), 403

        try:
            payload, status = service.create_dict_type(request.get_json() or {})
            return jsonify(payload), status
        except DictsServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/dicts/<int:dict_id>', methods=['GET', 'PUT', 'DELETE'])
    @login_required
    def manage_dict_type(dict_id):
        item = service.crud.get_dict_type_or_404(dict_id)

        if request.method == 'GET':
            if not has_menu_permission('system_dicts'):
                return jsonify({'error': '无权限查看数据字典'}), 403
            include_items = parse_bool(request.args.get('include_items')) is True
            return jsonify(service.get_dict_type(item, include_items=include_items))

        if request.method == 'PUT':
            if not has_menu_permission('system_dicts_edit'):
                return jsonify({'error': '无权限编辑数据字典'}), 403

            try:
                return jsonify(service.update_dict_type(item, request.get_json() or {}))
            except DictsServiceError as e:
                return handle_service_error(e)

        if not has_menu_permission('system_dicts_delete'):
            return jsonify({'error': '无权限删除数据字典'}), 403

        try:
            return jsonify(service.delete_dict_type(item))
        except DictsServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/dicts/<int:dict_id>/items', methods=['GET', 'POST'])
    @login_required
    def manage_dict_items(dict_id):
        dict_type = service.crud.get_dict_type_or_404(dict_id)

        if request.method == 'GET':
            if not has_menu_permission('system_dicts'):
                return jsonify({'error': '无权限查看字典项'}), 403

            search = request.args.get('search', '').strip()
            is_active = parse_bool(request.args.get('is_active'))
            return jsonify(service.list_dict_items(dict_type, search=search, is_active=is_active))

        if not has_menu_permission('system_dicts_add'):
            return jsonify({'error': '无权限新增字典项'}), 403

        try:
            payload, status = service.create_dict_item(dict_type, request.get_json() or {})
            return jsonify(payload), status
        except DictsServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/dicts/<int:dict_id>/items/export', methods=['GET'])
    @login_required
    def export_dict_items(dict_id):
        dict_type = service.crud.get_dict_type_or_404(dict_id)
        if not has_menu_permission('system_dicts'):
            return jsonify({'error': '无权限导出字典项'}), 403
        try:
            return service.export_dict_items(dict_type, request.args.get('file_type'))
        except DictsServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/dicts/<int:dict_id>/items/template', methods=['GET'])
    @login_required
    def download_dict_items_template(dict_id):
        dict_type = service.crud.get_dict_type_or_404(dict_id)
        if not has_menu_permission('system_dicts'):
            return jsonify({'error': '无权限下载模板'}), 403
        try:
            return service.download_dict_items_template(dict_type, request.args.get('file_type'))
        except DictsServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/dicts/<int:dict_id>/items/import', methods=['POST'])
    @login_required
    def import_dict_items(dict_id):
        dict_type = service.crud.get_dict_type_or_404(dict_id)
        if not has_menu_permission('system_dicts_edit'):
            return jsonify({'error': '无权限导入字典项'}), 403

        try:
            return jsonify(service.import_dict_items(dict_type, request.files.get('file')))
        except DictsServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/dicts/items/<int:item_id>', methods=['GET', 'PUT', 'DELETE'])
    @login_required
    def manage_dict_item(item_id):
        item = service.crud.get_dict_item_or_404(item_id)

        if request.method == 'GET':
            if not has_menu_permission('system_dicts'):
                return jsonify({'error': '无权限查看字典项'}), 403
            return jsonify(service.get_dict_item(item))

        if request.method == 'PUT':
            if not has_menu_permission('system_dicts_edit'):
                return jsonify({'error': '无权限编辑字典项'}), 403

            try:
                return jsonify(service.update_dict_item(item, request.get_json() or {}))
            except DictsServiceError as e:
                return handle_service_error(e)

        if not has_menu_permission('system_dicts_delete'):
            return jsonify({'error': '无权限删除字典项'}), 403

        try:
            return jsonify(service.delete_dict_item(item))
        except DictsServiceError as e:
            return handle_service_error(e)
