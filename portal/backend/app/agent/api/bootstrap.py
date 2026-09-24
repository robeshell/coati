# -*- coding: utf-8 -*-
"""Bootstrap：CLI 启动配置"""

from flask import current_app, g, jsonify

from backend.app.admin.service.settings_service import resolve_desktop_update_settings
from backend.app.agent.service.bearer import agent_scope_required
from backend.app.agent.service.gateway_service import AgentGatewayError, AgentGatewayService
from backend.app.agent.service.usage_service import AgentUsageService


def build_agent_bootstrap(
    config, models_list, quota, default_model=None, gateway=None, model_profiles=None, user_id=None,
):
    allowlist = config.get('AGENT_PLUGIN_ALLOWLIST') or ''
    plugins = [p.strip() for p in allowlist.split(',') if p.strip()]
    company_release_enabled = bool(
        config.get('AGENT_DESKTOP_RELEASE_API_BASE')
        and config.get('AGENT_DESKTOP_RELEASE_IDENTIFIER')
    )
    payload = {
        'portal_api_base': config.get('AGENT_PUBLIC_API_BASE') or '',
        'desktop_update': ({
            'provider': 'company-release',
            'feed_url': '/api/agent/desktop-updates/{platform}',
        } if company_release_enabled else None),
        'desktop_update_url': config.get('AGENT_DESKTOP_UPDATE_URL') or '',
        'gateway_chat_path': '/api/agent/v1/chat/completions',
        'models': models_list,
        'model_profiles': model_profiles or {},
        'default_model': default_model,
        'min_cli_version': config.get('AGENT_MIN_CLI_VERSION', '0.0.0'),
        'plugin_allowlist': plugins,
        'quota': quota,
    }
    test_users = str(config.get('AGENT_DESKTOP_GITEA_TEST_USER_IDS') or '').split(',')
    preview = str(user_id) in {x.strip() for x in test_users if x.strip()} and bool(config.get('AGENT_DESKTOP_GITEA_TEST_TAG'))
    if preview or config.get('AGENT_DESKTOP_UPDATE_PROVIDER') == 'gitea':
        channel = 'preview' if preview else 'stable'
        payload['desktop_update'] = {
            'provider': 'gitea',
            'feed_url': '/api/agent/gitea-updates/' + channel + '/{platform}/{arch}',
        }
    minio_users = {x.strip() for x in str(config.get('AGENT_DESKTOP_MINIO_TEST_USER_IDS') or '').split(',') if x.strip()}
    if user_id is not None and (str(user_id) in minio_users or config.get('AGENT_DESKTOP_UPDATE_PROVIDER') == 'minio'):
        from backend.app.agent.service.minio_desktop_release_service import MinioDesktopReleaseService
        from backend.app.agent.service.desktop_release_service import DesktopReleaseError
        try:
            payload['desktop_update'] = {'provider': 'minio', 'feed_url': MinioDesktopReleaseService(config).feed(
                user_id, 'preview' if str(user_id) in minio_users else 'stable')}
        except DesktopReleaseError:
            payload['desktop_update'] = None
    if gateway is not None:
        payload['gateway'] = gateway
    return payload


def init_agent_bootstrap_api(bp, db, models):
    @bp.route('/api/agent/bootstrap', methods=['GET'])
    @agent_scope_required('profile')
    def bootstrap():
        gw = AgentGatewayService(db, models)
        try:
            # dsh 当前通过 Chat Completions 入口请求，Bootstrap 不能下发只能由
            # Anthropic/Responses 入口调用的账号模型。
            models_list = gw.allowed_models(g.agent_user, inbound_protocol='openai')
            model_profiles = gw.model_profiles(g.agent_user, inbound_protocol='openai')
            default_model = gw.default_model(inbound_protocol='openai')
            gateway_info = gw.gateway_status()
        except AgentGatewayError:
            models_list = []
            model_profiles = {}
            default_model = None
            gateway_info = {'status': 'error', 'message': '网关状态不可用'}
        return jsonify(build_agent_bootstrap(
            resolve_desktop_update_settings(current_app.config, db, models),
            models_list,
            AgentUsageService(db, models).quota_summary(g.agent_user.id),
            default_model=default_model,
            gateway=gateway_info,
            model_profiles=model_profiles,
            user_id=g.agent_user.id,
        ))
