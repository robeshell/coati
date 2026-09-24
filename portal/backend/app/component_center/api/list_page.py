# -*- coding: utf-8 -*-
"""列表页 API 层"""

from flask import jsonify, request, send_from_directory, session

from backend.common.auth import has_any_menu_permission, has_menu_permission, login_required
from backend.app.component_center.model.list_page import (
    get_list_page_model,
    get_list_page_version_model,
)
from backend.common.pagination import parse_pagination
from backend.app.component_center.schema.list_page import parse_bool
from backend.app.component_center.service.list_page import (
    ListPageService,
    ListPageServiceError,
)


def init_list_page_api(bp, db, models):
    service = ListPageService(
        db,
        get_list_page_model(models),
        get_list_page_version_model(models),
    )

    def handle_service_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    @bp.route('/api/admin/component-center/list-page', methods=['GET', 'POST'])
    @login_required
    def manage_list_page_list():
        if request.method == 'GET':
            if not has_menu_permission('system_list_page'):
                return jsonify({'error': '无权限查看列表页数据'}), 403

            page, per_page = parse_pagination()
            search = (request.args.get('search') or '').strip()
            category = (request.args.get('category') or '').strip()
            owner = (request.args.get('owner') or '').strip()
            is_active = parse_bool(request.args.get('is_active'))
            status = (request.args.get('status') or '').strip()
            return jsonify(service.list_items(
                page=page,
                per_page=per_page,
                search=search,
                category=category,
                owner=owner,
                is_active=is_active,
                status=status,
            ))

        if not has_menu_permission('system_list_page_add'):
            return jsonify({'error': '无权限新增记录'}), 403

        try:
            payload, status = service.create_item(request.get_json() or {})
            return jsonify(payload), status
        except ListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/list-page/<int:item_id>', methods=['GET', 'PUT', 'DELETE'])
    @login_required
    def manage_list_page_detail(item_id):
        item = service.crud.get_or_404(item_id)

        if request.method == 'GET':
            if not has_menu_permission('system_list_page'):
                return jsonify({'error': '无权限查看记录详情'}), 403
            return jsonify(item.to_dict())

        if request.method == 'PUT':
            if not has_menu_permission('system_list_page_edit'):
                return jsonify({'error': '无权限编辑记录'}), 403
            try:
                return jsonify(service.update_item(item, request.get_json() or {}))
            except ListPageServiceError as e:
                return handle_service_error(e)

        if not has_menu_permission('system_list_page_delete'):
            return jsonify({'error': '无权限删除记录'}), 403

        try:
            return jsonify(service.delete_item(item))
        except ListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/list-page/export', methods=['GET', 'POST'])
    @login_required
    def export_list_page():
        if not has_menu_permission('system_list_page'):
            return jsonify({'error': '无权限导出数据'}), 403

        try:
            payload = request.args if request.method == 'GET' else (request.get_json() or {})
            return service.export_items(payload, request_method=request.method)
        except ListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/list-page/template', methods=['GET'])
    @login_required
    def download_list_page_template():
        if not has_menu_permission('system_list_page'):
            return jsonify({'error': '无权限下载导入模板'}), 403

        try:
            return service.download_template(request.args.get('file_type'))
        except ListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/list-page/import', methods=['POST'])
    @login_required
    def import_list_page():
        if not has_menu_permission('system_list_page_edit'):
            return jsonify({'error': '无权限导入数据'}), 403

        try:
            return jsonify(service.import_items(request.files.get('file')))
        except ListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/list-page/upload-image', methods=['POST'])
    @login_required
    def upload_list_page_image():
        if not has_any_menu_permission('system_list_page_add', 'system_list_page_edit'):
            return jsonify({'error': '无权限上传图片'}), 403

        try:
            return jsonify(service.save_image(request.files.get('file')))
        except ListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/list-page/image/<path:filename>', methods=['GET'])
    @login_required
    def list_page_image(filename):
        if not has_menu_permission('system_list_page'):
            return jsonify({'error': '无权限查看图片'}), 403

        try:
            safe_name = service.sanitize_image_filename(filename)
            return send_from_directory(service.get_image_upload_dir(), safe_name)
        except ListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/list-page/upload-file', methods=['POST'])
    @login_required
    def upload_list_page_file():
        if not has_any_menu_permission('system_list_page_add', 'system_list_page_edit'):
            return jsonify({'error': '无权限上传附件'}), 403

        try:
            return jsonify(service.save_file(request.files.get('file')))
        except ListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/list-page/file/<path:filename>', methods=['GET'])
    @login_required
    def list_page_file(filename):
        if not has_menu_permission('system_list_page'):
            return jsonify({'error': '无权限查看附件'}), 403

        try:
            safe_name = service.sanitize_image_filename(filename)
            return send_from_directory(service.get_file_upload_dir(), safe_name, as_attachment=True)
        except ListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/list-page/run-preview', methods=['POST'])
    @login_required
    def run_list_page_preview():
        if not has_menu_permission('system_list_page'):
            return jsonify({'error': '无权限执行数据预览'}), 403
        try:
            return jsonify(service.run_preview(request.get_json() or {}))
        except ListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/list-page/<int:item_id>/versions', methods=['GET'])
    @login_required
    def list_list_page_versions(item_id):
        if not has_menu_permission('system_list_page'):
            return jsonify({'error': '无权限查看版本历史'}), 403
        item = service.crud.get_or_404(item_id)
        page, per_page = parse_pagination()
        return jsonify(service.list_versions(item, page=page, per_page=per_page))

    @bp.route('/api/admin/component-center/list-page/<int:item_id>/versions/<int:version_id>/rollback', methods=['POST'])
    @login_required
    def rollback_list_page_version(item_id, version_id):
        if not has_menu_permission('system_list_page_edit'):
            return jsonify({'error': '无权限回滚版本'}), 403
        item = service.crud.get_or_404(item_id)
        version_item = service.crud.get_version_or_404(version_id)
        try:
            payload = service.rollback_version(
                item,
                version_item,
                operator=session.get('username') or 'system',
            )
            return jsonify(payload)
        except ListPageServiceError as e:
            return handle_service_error(e)
