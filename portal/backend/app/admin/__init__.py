# -*- coding: utf-8 -*-
"""Admin 大模块"""

from backend.app.admin.api import register_admin_routes
from backend.app.admin.model import build_admin_models

__all__ = ['register_admin_routes', 'build_admin_models']
