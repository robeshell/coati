# -*- coding: utf-8 -*-
"""请求级解析 Bearer → g.agent_user"""

from flask import g, request

from backend.app.agent.service.auth_service import AgentAuthService
from backend.app.agent.service.bearer import extract_api_key


def init_agent_bearer_loader(app, db, models):
    if app is None:
        return

    @app.before_request
    def load_agent_bearer():
        g.agent_user = None
        g.agent_pat = None
        if not request.path.startswith('/api/agent'):
            return None
        token = extract_api_key()
        if not token:
            return None
        svc = AgentAuthService(db, models)
        user, pat = svc.resolve_bearer(token)
        g.agent_user = user
        g.agent_pat = pat
        return None
