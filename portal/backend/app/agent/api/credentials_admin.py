# -*- coding: utf-8 -*-
"""上游 LLM Key 池管理 API"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.common.pagination import parse_pagination
from backend.app.agent.service.credential_service import AgentCredentialError, AgentCredentialService


def init_agent_credentials_admin_api(bp, db, models):
    def svc():
        return AgentCredentialService(db, models)

    def handle(err: AgentCredentialError):
        return jsonify({'error': err.message, **err.payload}), err.status_code

    @bp.route('/api/admin/agent/credentials', methods=['GET'])
    @login_required
    def list_credentials():
        if not has_menu_permission('agent_llm_keys'):
            return jsonify({'error': '无权限'}), 403
        page, per_page = parse_pagination()
        return jsonify(svc().list_items(
            page=page, per_page=per_page, search=request.args.get('search'),
            enabled=request.args.get('enabled'),
            upstream_protocol=request.args.get('upstream_protocol'),
            provider=request.args.get('provider'),
            health_status=request.args.get('health_status'),
        ))

    @bp.route('/api/admin/agent/providers', methods=['GET'])
    @login_required
    def list_providers():
        if not has_menu_permission('agent_llm_keys'):
            return jsonify({'error': '无权限'}), 403
        return jsonify(svc().providers())

    @bp.route('/api/admin/agent/upstream-protocols', methods=['GET'])
    @login_required
    def list_upstream_protocols():
        if not has_menu_permission('agent_llm_keys'):
            return jsonify({'error': '无权限'}), 403
        return jsonify(svc().upstream_protocols())

    @bp.route('/api/admin/agent/credentials/discover-models', methods=['POST'])
    @login_required
    def discover_models():
        if not has_menu_permission('agent_llm_keys_test'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().discover_models(request.get_json() or {}))
        except AgentCredentialError as e:
            return handle(e)

    @bp.route('/api/admin/agent/credentials/<int:cred_id>/copy', methods=['POST'])
    @login_required
    def copy_credential(cred_id):
        if not has_menu_permission('agent_llm_keys_add'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().copy(cred_id)), 201
        except AgentCredentialError as e:
            return handle(e)

    @bp.route('/api/admin/agent/credentials/<int:cred_id>/check', methods=['POST'])
    @login_required
    def check_credential(cred_id):
        if not has_menu_permission('agent_llm_keys_test'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().check(cred_id))
        except AgentCredentialError as e:
            return handle(e)

    @bp.route('/api/admin/agent/credentials/health-probe', methods=['POST'])
    @login_required
    def run_credential_health_probe():
        """手动批量探活异常/冷却/未检测账号；进程内定时器周期执行同一逻辑。"""
        if not has_menu_permission('agent_llm_keys_test'):
            return jsonify({'error': '无权限'}), 403
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            payload = {}
        try:
            limit = payload.get('limit')
            quiet_seconds = payload.get('quiet_seconds')
            return jsonify(svc().probe_stale_credentials(
                limit=max(1, min(int(limit), 50)) if limit else None,
                quiet_seconds=max(30, int(quiet_seconds)) if quiet_seconds else None,
            ))
        except (TypeError, ValueError):
            return jsonify({'error': 'limit / quiet_seconds 需为整数'}), 400
        except AgentCredentialError as e:
            return handle(e)

    @bp.route('/api/admin/agent/credentials', methods=['POST'])
    @login_required
    def create_credential():
        if not has_menu_permission('agent_llm_keys_add'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().create(request.get_json() or {})), 201
        except AgentCredentialError as e:
            return handle(e)

    @bp.route('/api/admin/agent/credentials/<int:cred_id>', methods=['PUT'])
    @login_required
    def update_credential(cred_id):
        if not has_menu_permission('agent_llm_keys_edit'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().update(cred_id, request.get_json() or {}))
        except AgentCredentialError as e:
            return handle(e)

    @bp.route('/api/admin/agent/credentials/<int:cred_id>', methods=['DELETE'])
    @login_required
    def delete_credential(cred_id):
        if not has_menu_permission('agent_llm_keys_delete'):
            return jsonify({'error': '无权限'}), 403
        try:
            return jsonify(svc().delete(cred_id))
        except AgentCredentialError as e:
            return handle(e)
