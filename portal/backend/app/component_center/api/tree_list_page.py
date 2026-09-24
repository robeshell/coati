# -*- coding: utf-8 -*-
"""树形列表页 API 层"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.component_center.model.tree_list_page import (
    get_tree_list_page_model,
)
from backend.common.pagination import parse_pagination
from backend.app.component_center.schema.tree_list_page import parse_bool
from backend.app.component_center.service.tree_list_page import (
    TreeListPageService,
    TreeListPageServiceError,
)


def init_tree_list_page_api(bp, db, models):
    service = TreeListPageService(db, get_tree_list_page_model(models))

    def handle_service_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    # ── 树形结构（左侧 Tree 组件用）──────────────────────────────────
    @bp.route('/api/admin/component-center/tree-list-page/tree', methods=['GET'])
    @login_required
    def get_tree_list_page_tree():
        if not has_menu_permission('system_tree_list_page'):
            return jsonify({'error': '无权限查看树形数据'}), 403
        search = (request.args.get('search') or '').strip()
        node_type = (request.args.get('node_type') or '').strip()
        status = (request.args.get('status') or '').strip()
        owner = (request.args.get('owner') or '').strip()
        is_active = parse_bool(request.args.get('is_active'))
        return jsonify(service.get_tree(search=search, node_type=node_type, status=status, owner=owner, is_active=is_active))

    # ── 平铺列表（右侧表格用）─────────────────────────────────────────
    @bp.route('/api/admin/component-center/tree-list-page', methods=['GET', 'POST'])
    @login_required
    def manage_tree_list_page_list():
        if request.method == 'GET':
            if not has_menu_permission('system_tree_list_page'):
                return jsonify({'error': '无权限查看树形列表页数据'}), 403

            page, per_page = parse_pagination()
            search = (request.args.get('search') or '').strip()
            node_type = (request.args.get('node_type') or '').strip()
            status = (request.args.get('status') or '').strip()
            owner = (request.args.get('owner') or '').strip()
            is_active = parse_bool(request.args.get('is_active'))
            parent_id_raw = request.args.get('parent_id')
            parent_id = None
            if parent_id_raw == 'root':
                parent_id = 'root'
            elif parent_id_raw is not None:
                try:
                    parent_id = int(parent_id_raw)
                except (ValueError, TypeError):
                    pass
            return jsonify(service.list_items(
                page=page,
                per_page=per_page,
                search=search,
                node_type=node_type,
                status=status,
                owner=owner,
                is_active=is_active,
                parent_id=parent_id,
            ))

        if not has_menu_permission('system_tree_list_page_add'):
            return jsonify({'error': '无权限新增节点'}), 403

        try:
            payload, status_code = service.create_item(request.get_json() or {})
            return jsonify(payload), status_code
        except TreeListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/tree-list-page/<int:item_id>', methods=['GET', 'PUT', 'DELETE'])
    @login_required
    def manage_tree_list_page_detail(item_id):
        item = service.crud.get_or_404(item_id)

        if request.method == 'GET':
            if not has_menu_permission('system_tree_list_page'):
                return jsonify({'error': '无权限查看节点详情'}), 403
            return jsonify(item.to_dict())

        if request.method == 'PUT':
            if not has_menu_permission('system_tree_list_page_edit'):
                return jsonify({'error': '无权限编辑节点'}), 403
            try:
                return jsonify(service.update_item(item, request.get_json() or {}))
            except TreeListPageServiceError as e:
                return handle_service_error(e)

        if not has_menu_permission('system_tree_list_page_delete'):
            return jsonify({'error': '无权限删除节点'}), 403

        try:
            return jsonify(service.delete_item(item))
        except TreeListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/tree-list-page/export', methods=['GET', 'POST'])
    @login_required
    def export_tree_list_page():
        if not has_menu_permission('system_tree_list_page'):
            return jsonify({'error': '无权限导出数据'}), 403
        try:
            payload = request.args if request.method == 'GET' else (request.get_json() or {})
            return service.export_items(payload, request_method=request.method)
        except TreeListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/tree-list-page/template', methods=['GET'])
    @login_required
    def download_tree_list_page_template():
        if not has_menu_permission('system_tree_list_page'):
            return jsonify({'error': '无权限下载导入模板'}), 403
        try:
            return service.download_template(request.args.get('file_type'))
        except TreeListPageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/tree-list-page/import', methods=['POST'])
    @login_required
    def import_tree_list_page():
        if not has_menu_permission('system_tree_list_page_edit'):
            return jsonify({'error': '无权限导入数据'}), 403
        try:
            return jsonify(service.import_items(request.files.get('file')))
        except TreeListPageServiceError as e:
            return handle_service_error(e)
