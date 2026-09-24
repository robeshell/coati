# -*- coding: utf-8 -*-
"""Agent API 装配"""

from backend.app.agent.api.auth import init_agent_auth_api
from backend.app.agent.api.bootstrap import init_agent_bootstrap_api
from backend.app.agent.api.cache_test import init_agent_cache_test_api
from backend.app.agent.api.credentials_admin import init_agent_credentials_admin_api
from backend.app.agent.api.desktop_updates import init_agent_desktop_updates_api
from backend.app.agent.api.gateway import init_agent_gateway_api
from backend.app.agent.api.my_channels import init_agent_my_channels_api
from backend.app.agent.api.usage import init_agent_usage_api
from backend.app.agent.api.routes_admin import init_agent_routes_admin_api
from backend.app.agent.api.model_profiles_admin import init_agent_model_profiles_admin_api
from backend.app.agent.api.websearch_admin import init_agent_websearch_admin_api
from backend.app.agent.api.middleware import init_agent_bearer_loader


def register_agent_routes(bp, db, models, app=None):
    init_agent_bearer_loader(app or bp, db, models)
    init_agent_auth_api(bp, db, models)
    init_agent_bootstrap_api(bp, db, models)
    init_agent_desktop_updates_api(bp, db, models)
    init_agent_gateway_api(bp, db, models)
    init_agent_cache_test_api(bp, db, models)
    init_agent_usage_api(bp, db, models)
    init_agent_routes_admin_api(bp, db, models)
    init_agent_model_profiles_admin_api(bp, db, models)
    init_agent_credentials_admin_api(bp, db, models)
    init_agent_websearch_admin_api(bp, db, models)
    init_agent_my_channels_api(bp, db, models)
