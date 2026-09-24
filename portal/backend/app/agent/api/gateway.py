# -*- coding: utf-8 -*-
"""LLM 网关 API"""

from flask import g, jsonify, request

from backend.app.agent.service.bearer import agent_scope_required
from backend.app.agent.service.credential_service import AgentCredentialError
from backend.app.agent.service.gateway_service import AgentGatewayError, AgentGatewayService
from backend.app.agent.service.usage_service import AgentUsageError


def _gateway_http(call):
    try:
        result = call()
        if hasattr(result, 'status_code'):
            return result
        payload, status, request_id = result
        response = jsonify(payload)
        response.status_code = status
        response.headers['X-Agent-Request-Id'] = request_id
        return response
    except AgentUsageError as e:
        response = jsonify({'error': e.message, **e.payload})
        response.status_code = e.status_code
        if e.payload.get('request_id'):
            response.headers['X-Agent-Request-Id'] = e.payload['request_id']
        return response
    except AgentGatewayError as e:
        response = jsonify({'error': e.message, **e.payload})
        response.status_code = e.status_code
        if e.payload.get('request_id'):
            response.headers['X-Agent-Request-Id'] = e.payload['request_id']
        return response
    except AgentCredentialError as e:
        response = jsonify({'error': e.message, **(e.payload or {})})
        response.status_code = e.status_code or 503
        return response


def init_agent_gateway_api(bp, db, models):
    @bp.route('/api/agent/v1/models', methods=['GET'])
    @agent_scope_required('profile')
    def list_models():
        """OpenAI 兼容模型清单：供外部客户端 GET {base}/models 拉取账号可用模型。"""
        try:
            service = AgentGatewayService(db, models)
            # 该接口是 OpenAI 兼容的模型目录，必须只暴露 Chat 入口可调用的模型。
            names = service.allowed_models(g.agent_user, inbound_protocol='openai')
            profiles = service.model_profiles(g.agent_user, inbound_protocol='openai')
        except AgentGatewayError:
            names = []
            profiles = {}
        payload = {
            'object': 'list',
            'data': [
                {
                    'id': name,
                    'object': 'model',
                    'name': name,
                    'display_name': name,
                    'owned_by': 'coati',
                    'context_window': (profiles.get(name) or {}).get('context_window'),
                    'max_output_tokens': (profiles.get(name) or {}).get('max_output_tokens'),
                }
                for name in names
            ],
        }
        return jsonify(payload)

    @bp.route('/api/agent/v1/messages', methods=['POST'])
    @bp.route('/api/agent/anthropic/v1/messages', methods=['POST'])
    @agent_scope_required('chat')
    def anthropic_messages():
        body = request.get_json(silent=True) or {}
        return _gateway_http(lambda: AgentGatewayService(db, models).anthropic_messages(
            g.agent_user, body, request_headers=request.headers,
        ))

    @bp.route('/api/agent/v1/messages/count_tokens', methods=['POST'])
    @bp.route('/api/agent/anthropic/v1/messages/count_tokens', methods=['POST'])
    @agent_scope_required('chat')
    def count_tokens():
        body = request.get_json(silent=True) or {}
        return _gateway_http(lambda: AgentGatewayService(db, models).count_tokens(
            g.agent_user, body,
        ))

    @bp.route('/api/agent/v1/chat/completions', methods=['POST'])
    @agent_scope_required('chat')
    def chat_completions():
        body = request.get_json(silent=True) or {}
        return _gateway_http(lambda: AgentGatewayService(db, models).chat_completions(
            g.agent_user, body, request_headers=request.headers,
        ))

    @bp.route('/api/agent/v1/responses', methods=['POST'])
    @agent_scope_required('chat')
    def openai_responses():
        body = request.get_json(silent=True) or {}
        return _gateway_http(lambda: AgentGatewayService(db, models).openai_responses(
            g.agent_user, body, request_headers=request.headers,
        ))

    @bp.route('/api/agent/v1/responses/<response_id>', methods=['GET'])
    @agent_scope_required('chat')
    def get_openai_response(response_id):
        return jsonify({
            'error': '网关不持久化 Responses，请在后续请求的 input 中回传历史',
            'id': response_id,
        }), 404

    @bp.route('/api/agent/v1/web-search', methods=['POST'])
    @agent_scope_required('chat')
    def web_search():
        body = request.get_json(silent=True) or {}
        return _gateway_http(lambda: AgentGatewayService(db, models).web_search(
            g.agent_user, body.get('query'), body.get('max_results', 5),
            request_headers=request.headers,
        ))
