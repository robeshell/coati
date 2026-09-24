# -*- coding: utf-8 -*-
"""高级表格页 API 层"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.component_center.model.advanced_table_page import get_advanced_table_row_model
from backend.app.component_center.schema.advanced_table_page import parse_bool
from backend.app.component_center.service.advanced_table_page import (
    AdvancedTablePageService,
    AdvancedTablePageServiceError,
)
from backend.common.pagination import parse_pagination


def init_advanced_table_page_api(bp, db, models):
    service = AdvancedTablePageService(db, get_advanced_table_row_model(models))

    def handle_service_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    @bp.route('/api/admin/component-center/advanced-table/stats', methods=['GET'])
    @login_required
    def get_advanced_table_stats():
        if not has_menu_permission('cc_admin_advanced_table_page'):
            return jsonify({'error': '无权限查看统计数据'}), 403
        return jsonify(service.get_stats())

    @bp.route('/api/admin/component-center/advanced-table/rows', methods=['GET', 'POST'])
    @login_required
    def manage_advanced_table_rows():
        if request.method == 'GET':
            if not has_menu_permission('cc_admin_advanced_table_page'):
                return jsonify({'error': '无权限查看数据'}), 403

            page, per_page = parse_pagination()
            search = (request.args.get('search') or '').strip()
            status = (request.args.get('status') or '').strip()
            category = (request.args.get('category') or '').strip()
            owner = (request.args.get('owner') or '').strip()
            is_active = parse_bool(request.args.get('is_active'))
            pinned_only = parse_bool(request.args.get('pinned_only'), default=False)
            sort_field = (request.args.get('sort_field') or 'sort_order').strip()
            sort_order = (request.args.get('sort_order') or 'asc').strip()

            return jsonify(service.list_items(
                page=page,
                per_page=per_page,
                search=search,
                status=status,
                category=category,
                owner=owner,
                is_active=is_active,
                pinned_only=pinned_only,
                sort_field=sort_field,
                sort_order=sort_order,
            ))

        if not has_menu_permission('cc_admin_advanced_table_add'):
            return jsonify({'error': '无权限新增记录'}), 403

        try:
            payload, status_code = service.create_item(request.get_json() or {})
            return jsonify(payload), status_code
        except AdvancedTablePageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/advanced-table/rows/<int:item_id>', methods=['PUT', 'DELETE'])
    @login_required
    def manage_advanced_table_row_detail(item_id):
        item = service.crud.get_or_404(item_id)

        if request.method == 'PUT':
            if not has_menu_permission('cc_admin_advanced_table_edit'):
                return jsonify({'error': '无权限编辑记录'}), 403
            try:
                return jsonify(service.update_item(item, request.get_json() or {}))
            except AdvancedTablePageServiceError as e:
                return handle_service_error(e)

        if not has_menu_permission('cc_admin_advanced_table_delete'):
            return jsonify({'error': '无权限删除记录'}), 403

        try:
            return jsonify(service.delete_item(item))
        except AdvancedTablePageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/advanced-table/rows/reorder', methods=['PUT'])
    @login_required
    def reorder_advanced_table_rows():
        if not has_menu_permission('cc_admin_advanced_table_edit'):
            return jsonify({'error': '无权限排序'}), 403
        try:
            return jsonify(service.reorder_rows(request.get_json() or []))
        except AdvancedTablePageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/advanced-table/rows/batch-update', methods=['POST'])
    @login_required
    def batch_update_advanced_table_rows():
        if not has_menu_permission('cc_admin_advanced_table_edit'):
            return jsonify({'error': '无权限批量更新'}), 403
        try:
            return jsonify(service.batch_update(request.get_json() or {}))
        except AdvancedTablePageServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/component-center/advanced-table/rows/batch-delete', methods=['POST'])
    @login_required
    def batch_delete_advanced_table_rows():
        if not has_menu_permission('cc_admin_advanced_table_delete'):
            return jsonify({'error': '无权限批量删除'}), 403
        try:
            return jsonify(service.batch_delete(request.get_json() or {}))
        except AdvancedTablePageServiceError as e:
            return handle_service_error(e)
