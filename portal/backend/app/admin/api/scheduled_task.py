# -*- coding: utf-8 -*-
"""定时任务 API 层"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.app.admin.model.scheduled_task import (
    get_scheduled_task_model,
    get_scheduled_task_run_model,
)
from backend.app.admin.schema.scheduled_task import parse_bool, parse_int
from backend.app.admin.service.scheduled_task import ScheduledTaskService, ScheduledTaskServiceError
from backend.common.pagination import parse_pagination


def init_scheduled_task_api(bp, db, models):
    service = ScheduledTaskService(db, get_scheduled_task_model(models), get_scheduled_task_run_model(models))

    def handle_service_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    @bp.route('/api/admin/scheduled-tasks', methods=['GET', 'POST'])
    @login_required
    def manage_scheduled_tasks():
        if request.method == 'GET':
            if not has_menu_permission('system_scheduled_tasks'):
                return jsonify({'error': '无权限查看定时任务列表'}), 403

            page, per_page = parse_pagination()
            search = (request.args.get('search') or '').strip()
            status = (request.args.get('status') or '').strip()
            is_active = parse_bool(request.args.get('is_active'))
            return jsonify(service.list_tasks(
                page=page,
                per_page=per_page,
                search=search,
                is_active=is_active,
                status=status,
            ))

        if not has_menu_permission('system_scheduled_tasks_add'):
            return jsonify({'error': '无权限新增定时任务'}), 403

        try:
            payload, status_code = service.create_task(request.get_json() or {})
            return jsonify(payload), status_code
        except ScheduledTaskServiceError as exc:
            return handle_service_error(exc)

    @bp.route('/api/admin/scheduled-tasks/<int:task_id>', methods=['GET', 'PUT', 'DELETE'])
    @login_required
    def manage_scheduled_task_detail(task_id):
        if request.method == 'GET':
            if not has_menu_permission('system_scheduled_tasks'):
                return jsonify({'error': '无权限查看定时任务'}), 403
            try:
                return jsonify(service.get_task(task_id))
            except ScheduledTaskServiceError as exc:
                return handle_service_error(exc)

        if request.method == 'PUT':
            if not has_menu_permission('system_scheduled_tasks_edit'):
                return jsonify({'error': '无权限编辑定时任务'}), 403
            try:
                task = service.require_task(task_id)
                return jsonify(service.update_task(task, request.get_json() or {}))
            except ScheduledTaskServiceError as exc:
                return handle_service_error(exc)

        if not has_menu_permission('system_scheduled_tasks_delete'):
            return jsonify({'error': '无权限删除定时任务'}), 403

        try:
            task = service.require_task(task_id)
            return jsonify(service.delete_task(task))
        except ScheduledTaskServiceError as exc:
            return handle_service_error(exc)

    @bp.route('/api/admin/scheduled-tasks/<int:task_id>/run', methods=['POST'])
    @login_required
    def run_scheduled_task(task_id):
        if not has_menu_permission('system_scheduled_tasks_run'):
            return jsonify({'error': '无权限执行定时任务'}), 403

        try:
            task = service.require_task(task_id)
            payload = service.run_task_now(task)
            return jsonify(payload), 200 if payload.get('run', {}).get('status') == 'success' else 500
        except ScheduledTaskServiceError as exc:
            return handle_service_error(exc)

    @bp.route('/api/admin/scheduled-tasks/runs', methods=['GET'])
    @login_required
    def list_scheduled_task_runs():
        if not has_menu_permission('system_scheduled_tasks'):
            return jsonify({'error': '无权限查看执行记录'}), 403

        page, per_page = parse_pagination()
        task_id = parse_int(request.args.get('task_id'), default=0) or None
        status = (request.args.get('status') or '').strip()
        return jsonify(service.list_runs(page=page, per_page=per_page, task_id=task_id, status=status))
