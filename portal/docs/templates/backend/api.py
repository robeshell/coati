# -*- coding: utf-8 -*-
"""
TODO: 替换 <resource> 为资源名（下划线，如 customers）
TODO: 替换 <Resource> 为模型类名（大驼峰，如 Customer）
TODO: 替换 <domain> 为权限域（如 system、cc）
TODO: 替换 <domain_resource> 为权限编码前缀（如 system_customers）
"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.<domain>.service.<resource> import <Resource>Service, <Resource>ServiceError


def init_<resource>_api(bp, db, models):
    <Resource> = models.get('<Resource>')
    service = <Resource>Service(db, <Resource>)

    def handle_error(e):
        return jsonify({'error': e.message, **e.payload}), e.status_code

    # ── 列表 / 新增 ───────────────────────────────────────────────────────────

    @bp.route('/api/admin/<resource>', methods=['GET', 'POST'])
    @login_required
    def manage_<resource>():
        if request.method == 'GET':
            if not has_menu_permission('<domain_resource>'):
                return jsonify({'error': '无权限'}), 403
            page = request.args.get('page', 1, type=int)
            per_page = request.args.get('per_page', 20, type=int)
            search = request.args.get('search', '').strip()
            return jsonify(service.list_items(page=page, per_page=per_page, search=search))

        if not has_menu_permission('<domain_resource>_add'):
            return jsonify({'error': '无权限新增'}), 403
        try:
            payload, status = service.create_item(request.get_json() or {})
            return jsonify(payload), status
        except <Resource>ServiceError as e:
            return handle_error(e)

    # ── 编辑 / 删除 ───────────────────────────────────────────────────────────

    @bp.route('/api/admin/<resource>/<int:item_id>', methods=['PUT', 'DELETE'])
    @login_required
    def update_<resource>(item_id):
        item = service.crud.get_or_404(item_id)

        if request.method == 'DELETE':
            if not has_menu_permission('<domain_resource>_delete'):
                return jsonify({'error': '无权限删除'}), 403
            try:
                return jsonify(service.delete_item(item))
            except <Resource>ServiceError as e:
                return handle_error(e)

        if not has_menu_permission('<domain_resource>_edit'):
            return jsonify({'error': '无权限编辑'}), 403
        try:
            return jsonify(service.update_item(item, request.get_json() or {}))
        except <Resource>ServiceError as e:
            return handle_error(e)

    # ── 导出 ──────────────────────────────────────────────────────────────────

    @bp.route('/api/admin/<resource>/export', methods=['POST'])
    @login_required
    def export_<resource>():
        if not has_menu_permission('<domain_resource>_export'):
            return jsonify({'error': '无权限导出'}), 403
        try:
            return service.export_items(request.get_json() or {})
        except <Resource>ServiceError as e:
            return handle_error(e)

    # ── 下载导入模板 ──────────────────────────────────────────────────────────

    @bp.route('/api/admin/<resource>/template', methods=['GET'])
    @login_required
    def download_<resource>_template():
        if not has_menu_permission('<domain_resource>'):
            return jsonify({'error': '无权限'}), 403
        return service.download_template(request.args.get('file_type', 'xlsx'))

    # ── 导入 ──────────────────────────────────────────────────────────────────

    @bp.route('/api/admin/<resource>/import', methods=['POST'])
    @login_required
    def import_<resource>():
        if not has_menu_permission('<domain_resource>_import'):
            return jsonify({'error': '无权限导入'}), 403
        try:
            return jsonify(service.import_items(request.files.get('file')))
        except <Resource>ServiceError as e:
            return handle_error(e)
