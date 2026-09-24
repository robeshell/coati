# -*- coding: utf-8 -*-
"""日志模块 API 层"""

from flask import current_app, jsonify, request, session

from backend.common.auth import has_menu_permission, login_required
from backend.app.admin.model.access import get_admin_model, get_login_log_model, get_operation_log_model
from backend.app.admin.service.logs import LogsService, LogsServiceError
from backend.common.pagination import parse_pagination


def init_logs_api(bp, db, models):
    service = LogsService(
        db,
        get_admin_model(models),
        get_login_log_model(models),
        get_operation_log_model(models),
    )

    def handle_service_error(error):
        if error.status_code >= 500:
            body = {'error': '服务器内部错误，请稍后重试'}
        else:
            body = {'error': error.message}
        body.update(error.payload)
        return jsonify(body), error.status_code

    @bp.after_request
    def auto_record_operation_log(response):
        try:
            service.record_operation_from_request(request, response, session.get('username'))
        except Exception:
            pass
        return response

    @bp.route('/api/admin/logs/login', methods=['GET'])
    @login_required
    def get_login_logs():
        if not has_menu_permission('system_logs'):
            return jsonify({'error': '无权限访问'}), 403

        try:
            page, per_page = parse_pagination()
            username = request.args.get('username', '', type=str).strip()
            status = request.args.get('status', '', type=str).strip()
            return jsonify(service.list_login_logs(page=page, per_page=per_page, username=username, status=status))
        except LogsServiceError as e:
            return handle_service_error(e)
        except Exception as e:
            current_app.logger.exception('查询登录日志失败: %s', e)
            return jsonify({'error': '服务器内部错误，请稍后重试'}), 500

    @bp.route('/api/admin/logs/operation', methods=['GET'])
    @login_required
    def get_operation_logs():
        if not has_menu_permission('system_logs'):
            return jsonify({'error': '无权限访问'}), 403

        try:
            page, per_page = parse_pagination()
            username = request.args.get('username', '', type=str).strip()
            module = request.args.get('module', '', type=str).strip()
            action = request.args.get('action', '', type=str).strip()
            return jsonify(service.list_operation_logs(
                page=page,
                per_page=per_page,
                username=username,
                module=module,
                action=action,
            ))
        except LogsServiceError as e:
            return handle_service_error(e)
        except Exception as e:
            current_app.logger.exception('查询操作日志失败: %s', e)
            return jsonify({'error': '服务器内部错误，请稍后重试'}), 500

    @bp.route('/api/admin/logs/login/export', methods=['POST'])
    @login_required
    def export_login_logs():
        if not has_menu_permission('system_logs'):
            return jsonify({'error': '无权限导出日志'}), 403

        try:
            return service.export_login_logs(request.get_json() or {})
        except LogsServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/logs/login/template', methods=['GET'])
    @login_required
    def download_login_logs_template():
        if not has_menu_permission('system_logs'):
            return jsonify({'error': '无权限下载日志模板'}), 403

        try:
            return service.download_login_template(request.args.get('file_type'))
        except LogsServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/logs/login/import', methods=['POST'])
    @login_required
    def import_login_logs():
        if not has_menu_permission('system_logs'):
            return jsonify({'error': '无权限导入日志'}), 403

        try:
            return jsonify(service.import_login_logs(request.files.get('file')))
        except LogsServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/logs/operation/export', methods=['POST'])
    @login_required
    def export_operation_logs():
        if not has_menu_permission('system_logs'):
            return jsonify({'error': '无权限导出日志'}), 403

        try:
            return service.export_operation_logs(request.get_json() or {})
        except LogsServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/logs/operation/template', methods=['GET'])
    @login_required
    def download_operation_logs_template():
        if not has_menu_permission('system_logs'):
            return jsonify({'error': '无权限下载日志模板'}), 403

        try:
            return service.download_operation_template(request.args.get('file_type'))
        except LogsServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/logs/operation/import', methods=['POST'])
    @login_required
    def import_operation_logs():
        if not has_menu_permission('system_logs'):
            return jsonify({'error': '无权限导入日志'}), 403

        try:
            return jsonify(service.import_operation_logs(request.files.get('file')))
        except LogsServiceError as e:
            return handle_service_error(e)
