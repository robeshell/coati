# -*- coding: utf-8 -*-
"""动态表单页 API 层"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.component_center.model.dynamic_form_page import (
    get_dynamic_form_field_model,
    get_dynamic_form_record_model,
)
from backend.common.pagination import parse_pagination
from backend.app.component_center.schema.dynamic_form_page import parse_bool
from backend.app.component_center.service.dynamic_form_page import (
    DynamicFormPageService,
    DynamicFormPageServiceError,
)


def init_dynamic_form_page_api(bp, db, models):
    service = DynamicFormPageService(
        db,
        get_dynamic_form_record_model(models),
        get_dynamic_form_field_model(models),
    )

    def handle_service_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    @bp.route('/api/admin/component-center/dynamic-form-page', methods=['GET', 'POST'])
    @login_required
    def manage_dynamic_form_page_list():
        if request.method == 'GET':
            if not has_menu_permission('system_dynamic_form_page'):
                return jsonify({'error': '无权限查看动态表单页数据'}), 403
            page, per_page = parse_pagination()
            search = (request.args.get('search') or '').strip()
            category = (request.args.get('category') or '').strip()
            status = (request.args.get('status') or '').strip()
            owner = (request.args.get('owner') or '').strip()
            is_active = parse_bool(request.args.get('is_active'))
            return jsonify(service.list_items(
                page=page, per_page=per_page,
                search=search, category=category,
                status=status, owner=owner, is_active=is_active,
            ))

        if not has_menu_permission('system_dynamic_form_page_add'):
            return jsonify({'error': '无权限新增记录'}), 403
        try:
            payload, status_code = service.create_item(request.get_json() or {})
            return jsonify(payload), status_code
        except DynamicFormPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/dynamic-form-page/<int:item_id>', methods=['GET', 'PUT', 'DELETE'])
    @login_required
    def manage_dynamic_form_page_detail(item_id):
        record = service.crud.get_or_404(item_id)

        if request.method == 'GET':
            if not has_menu_permission('system_dynamic_form_page'):
                return jsonify({'error': '无权限查看记录详情'}), 403
            return jsonify(record.to_dict(include_fields=True))

        if request.method == 'PUT':
            if not has_menu_permission('system_dynamic_form_page_edit'):
                return jsonify({'error': '无权限编辑记录'}), 403
            try:
                return jsonify(service.update_item(record, request.get_json() or {}))
            except DynamicFormPageServiceError as e:
                return handle_service_error(e)

        if not has_menu_permission('system_dynamic_form_page_delete'):
            return jsonify({'error': '无权限删除记录'}), 403
        try:
            return jsonify(service.delete_item(record))
        except DynamicFormPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/dynamic-form-page/export', methods=['GET', 'POST'])
    @login_required
    def export_dynamic_form_page():
        if not has_menu_permission('system_dynamic_form_page'):
            return jsonify({'error': '无权限导出数据'}), 403
        try:
            payload = request.args if request.method == 'GET' else (request.get_json() or {})
            return service.export_items(payload, request_method=request.method)
        except DynamicFormPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/dynamic-form-page/template', methods=['GET'])
    @login_required
    def download_dynamic_form_page_template():
        if not has_menu_permission('system_dynamic_form_page'):
            return jsonify({'error': '无权限下载导入模板'}), 403
        try:
            return service.download_template(request.args.get('file_type'))
        except DynamicFormPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/dynamic-form-page/import', methods=['POST'])
    @login_required
    def import_dynamic_form_page():
        if not has_menu_permission('system_dynamic_form_page_edit'):
            return jsonify({'error': '无权限导入数据'}), 403
        try:
            return jsonify(service.import_items(request.files.get('file')))
        except DynamicFormPageServiceError as e:
            return handle_service_error(e)
