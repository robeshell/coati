# -*- coding: utf-8 -*-
"""Admin model 层入口"""

from .entities_audit_logs import build_audit_log_models
from .entities_dicts import build_dict_models
from .entities_notification import build_notification_models
from .entities_rbac import build_rbac_models
from .entities_scheduled_task import build_scheduled_task_models
from .entities_announcement import build_announcement_models
from .entities_settings import build_settings_models

def build_admin_models(db):
    models = {}
    models.update(build_rbac_models(db))
    models.update(build_dict_models(db))
    models.update(build_audit_log_models(db))
    models.update(build_scheduled_task_models(db))
    models.update(build_notification_models(db))
    models.update(build_announcement_models(db))
    models.update(build_settings_models(db))
    models.pop('user_roles', None)
    models.pop('role_menus', None)
    return models
