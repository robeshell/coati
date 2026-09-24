# -*- coding: utf-8 -*-
"""Component Center 大模块"""

from backend.app.component_center.api import register_component_center_routes
from backend.app.component_center.model import build_component_center_models

__all__ = ['register_component_center_routes', 'build_component_center_models']
