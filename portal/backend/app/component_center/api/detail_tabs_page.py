# -*- coding: utf-8 -*-
"""详情标签页 API 层"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.component_center.model.detail_tabs_page import (
    get_detail_member_model,
)
from backend.app.component_center.service.detail_tabs_page import (
    DetailTabsPageService,
    DetailTabsPageServiceError,
)


def init_detail_tabs_page_api(bp, db, models):
    service = DetailTabsPageService(
        db,
        get_detail_member_model(models),
    )

    def handle_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    # ── 成员列表 / 新建 ──────────────────────────────────────────────────

    @bp.route('/api/admin/component-center/detail-tabs/members', methods=['GET', 'POST'])
    @login_required
    def detail_tabs_members():
        if request.method == 'GET':
            if not has_menu_permission('cc_admin_detail_tabs_page'):
                return jsonify({'error': '无权限'}), 403
            search = request.args.get('search', '').strip() or None
            return jsonify(service.get_all_members(search=search))

        if not has_menu_permission('cc_admin_detail_tabs_add'):
            return jsonify({'error': '无权限新建成员'}), 403
        try:
            payload, status_code = service.create_member(request.get_json() or {})
            return jsonify(payload), status_code
        except DetailTabsPageServiceError as e:
            return handle_error(e)

    # ── 成员详情 / 更新 / 删除 ───────────────────────────────────────────

    @bp.route('/api/admin/component-center/detail-tabs/members/<int:member_id>', methods=['GET', 'PUT', 'DELETE'])
    @login_required
    def detail_tabs_member_detail(member_id):
        member = service.crud.get_member_or_404(member_id)

        if request.method == 'GET':
            if not has_menu_permission('cc_admin_detail_tabs_page'):
                return jsonify({'error': '无权限'}), 403
            return jsonify(service.get_member(member_id))

        if request.method == 'PUT':
            if not has_menu_permission('cc_admin_detail_tabs_edit'):
                return jsonify({'error': '无权限编辑成员'}), 403
            try:
                return jsonify(service.update_member(member, request.get_json() or {}))
            except DetailTabsPageServiceError as e:
                return handle_error(e)

        if not has_menu_permission('cc_admin_detail_tabs_delete'):
            return jsonify({'error': '无权限删除成员'}), 403
        try:
            return jsonify(service.delete_member(member))
        except DetailTabsPageServiceError as e:
            return handle_error(e)
