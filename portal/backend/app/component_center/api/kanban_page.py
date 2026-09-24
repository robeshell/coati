# -*- coding: utf-8 -*-
"""看板页 API 层"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.component_center.model.kanban_page import (
    get_kanban_board_model,
    get_kanban_card_model,
)
from backend.app.component_center.service.kanban_page import (
    KanbanPageService,
    KanbanPageServiceError,
)


def init_kanban_page_api(bp, db, models):
    service = KanbanPageService(
        db,
        get_kanban_board_model(models),
        get_kanban_card_model(models),
    )

    def handle_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    # ── 看板列 ──────────────────────────────────────────────────────────

    @bp.route('/api/admin/component-center/kanban/boards', methods=['GET', 'POST'])
    @login_required
    def kanban_boards():
        if request.method == 'GET':
            if not has_menu_permission('cc_admin_kanban_page'):
                return jsonify({'error': '无权限'}), 403
            return jsonify(service.get_all_boards())

        if not has_menu_permission('cc_admin_kanban_add'):
            return jsonify({'error': '无权限新建列'}), 403
        try:
            payload, status_code = service.create_board(request.get_json() or {})
            return jsonify(payload), status_code
        except KanbanPageServiceError as e:
            return handle_error(e)

    @bp.route('/api/admin/component-center/kanban/boards/<int:board_id>', methods=['PUT', 'DELETE'])
    @login_required
    def kanban_board_detail(board_id):
        board = service.crud.get_board_or_404(board_id)

        if request.method == 'PUT':
            if not has_menu_permission('cc_admin_kanban_edit'):
                return jsonify({'error': '无权限编辑列'}), 403
            try:
                return jsonify(service.update_board(board, request.get_json() or {}))
            except KanbanPageServiceError as e:
                return handle_error(e)

        if not has_menu_permission('cc_admin_kanban_delete'):
            return jsonify({'error': '无权限删除列'}), 403
        try:
            return jsonify(service.delete_board(board))
        except KanbanPageServiceError as e:
            return handle_error(e)

    # ── 卡片 ────────────────────────────────────────────────────────────

    @bp.route('/api/admin/component-center/kanban/cards/reorder', methods=['PUT'])
    @login_required
    def kanban_cards_reorder():
        if not has_menu_permission('cc_admin_kanban_edit'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(service.reorder_cards(request.get_json() or []))
        except KanbanPageServiceError as e:
            return handle_error(e)

    @bp.route('/api/admin/component-center/kanban/cards', methods=['POST'])
    @login_required
    def kanban_cards():
        if not has_menu_permission('cc_admin_kanban_add'):
            return jsonify({'error': '无权限新建卡片'}), 403
        try:
            payload, status_code = service.create_card(request.get_json() or {})
            return jsonify(payload), status_code
        except KanbanPageServiceError as e:
            return handle_error(e)

    @bp.route('/api/admin/component-center/kanban/cards/<int:card_id>', methods=['PUT', 'DELETE'])
    @login_required
    def kanban_card_detail(card_id):
        card = service.crud.get_card_or_404(card_id)

        if request.method == 'PUT':
            if not has_menu_permission('cc_admin_kanban_edit'):
                return jsonify({'error': '无权限编辑卡片'}), 403
            try:
                return jsonify(service.update_card(card, request.get_json() or {}))
            except KanbanPageServiceError as e:
                return handle_error(e)

        if not has_menu_permission('cc_admin_kanban_delete'):
            return jsonify({'error': '无权限删除卡片'}), 403
        try:
            return jsonify(service.delete_card(card))
        except KanbanPageServiceError as e:
            return handle_error(e)
