# -*- coding: utf-8 -*-
"""公共组件"""

from .auth import login_required, menu_permission_required
from .compression import gzip_response
from .json_encoder import CustomJSONEncoder
from .request_meta import get_client_ip, get_user_agent, safe_payload

__all__ = [
    'CustomJSONEncoder',
    'get_client_ip',
    'get_user_agent',
    'gzip_response',
    'login_required',
    'menu_permission_required',
    'safe_payload',
]
