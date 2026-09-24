# -*- coding: utf-8 -*-
"""一级模块路由装配入口"""

from flask import Blueprint

from backend.app.admin import register_admin_routes
from backend.app.agent import register_agent_routes
from backend.app.component_center import register_component_center_routes


bp = Blueprint('admin', __name__)


def init_app_routes(db, models, app=None):
    register_admin_routes(bp, db, models)
    register_component_center_routes(bp, db, models, app=app)
    register_agent_routes(bp, db, models, app=app)
    return bp
