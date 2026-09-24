# -*- coding: utf-8 -*-
"""甘特图页 API 层"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.component_center.model.gantt_page import (
    get_gantt_task_model,
)
from backend.app.component_center.service.gantt_page import (
    GanttPageService,
    GanttPageServiceError,
)


def init_gantt_page_api(bp, db, models):
    service = GanttPageService(
        db,
        get_gantt_task_model(models),
    )

    def handle_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    # ── 任务列表 / 新建 ──────────────────────────────────────────────────

    @bp.route('/api/admin/component-center/gantt/tasks', methods=['GET', 'POST'])
    @login_required
    def gantt_tasks():
        if request.method == 'GET':
            if not has_menu_permission('cc_admin_gantt_page'):
                return jsonify({'error': '无权限'}), 403
            status = request.args.get('status', '').strip() or None
            priority = request.args.get('priority', '').strip() or None
            return jsonify(service.get_all_tasks(status=status, priority=priority))

        if not has_menu_permission('cc_admin_gantt_add'):
            return jsonify({'error': '无权限新建任务'}), 403
        try:
            payload, status_code = service.create_task(request.get_json() or {})
            return jsonify(payload), status_code
        except GanttPageServiceError as e:
            return handle_error(e)

    # ── 任务更新 / 删除 ──────────────────────────────────────────────────

    @bp.route('/api/admin/component-center/gantt/tasks/<int:task_id>', methods=['PUT', 'DELETE'])
    @login_required
    def gantt_task_detail(task_id):
        task = service.crud.get_task_or_404(task_id)

        if request.method == 'PUT':
            if not has_menu_permission('cc_admin_gantt_edit'):
                return jsonify({'error': '无权限编辑任务'}), 403
            try:
                return jsonify(service.update_task(task, request.get_json() or {}))
            except GanttPageServiceError as e:
                return handle_error(e)

        if not has_menu_permission('cc_admin_gantt_delete'):
            return jsonify({'error': '无权限删除任务'}), 403
        try:
            return jsonify(service.delete_task(task))
        except GanttPageServiceError as e:
            return handle_error(e)
