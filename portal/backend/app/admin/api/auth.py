# -*- coding: utf-8 -*-
"""认证模块 API 层"""

from flask import jsonify, redirect, request, session

from backend.common.auth import login_required
from backend.common.csrf import ensure_csrf_token
from backend.common.request_meta import get_client_ip, get_user_agent
from backend.app.admin.model.access import get_admin_model, get_login_log_model, get_operation_log_model
from backend.app.admin.service.auth import AuthService, AuthServiceError


def init_auth_api(bp, db, models):
    service = AuthService(
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

    @bp.route('/admin/login')
    def login_page():
        if session.get('logged_in'):
            return redirect('/admin')
        return redirect('/')

    @bp.route('/api/admin/login', methods=['POST'])
    def login():
        data = request.get_json() or {}
        username = data.get('username')
        password = data.get('password')
        try:
            payload, status = service.login(username, password, session, get_client_ip(), get_user_agent())
            if status == 200:
                payload['csrf_token'] = ensure_csrf_token()
            return jsonify(payload), status
        except AuthServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/logout', methods=['POST'])
    def logout():
        username = session.get('username') or ''
        return jsonify(service.logout(username, session, get_client_ip(), get_user_agent()))

    @bp.route('/api/admin/change-password', methods=['POST'])
    @login_required
    def change_password():
        try:
            return jsonify(service.change_password(session.get('username'), request.get_json() or {}))
        except AuthServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/me', methods=['GET'])
    @login_required
    def get_current_user():
        try:
            payload = service.get_current_user(session.get('username'))
            payload['csrf_token'] = ensure_csrf_token()
            return jsonify(payload)
        except AuthServiceError as e:
            return handle_service_error(e)

    @bp.route('/api/admin/csrf-token', methods=['GET'])
    @login_required
    def csrf_token_endpoint():
        return jsonify({'csrf_token': ensure_csrf_token()})
