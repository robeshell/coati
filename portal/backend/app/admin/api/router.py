# -*- coding: utf-8 -*-
"""后台管理路由装配入口"""


def register_admin_routes(bp, db, models):
    """初始化后台管理路由"""
    from backend.app.admin.api.auth import init_auth_api
    from backend.app.admin.api.logs import init_logs_api
    from backend.app.admin.api.menu import init_menus_api
    from backend.app.admin.api.users import init_users_api
    from backend.app.admin.api.roles import init_roles_api
    from backend.app.admin.api.dicts import init_dicts_api
    from backend.app.admin.api.scheduled_task import init_scheduled_task_api
    from backend.app.admin.api.dashboard import init_dashboard_api
    from backend.app.admin.api.notification import init_notification_api
    from backend.app.admin.api.announcement import init_announcement_api
    from backend.app.admin.api.settings import init_settings_api

    init_auth_api(bp, db, models)
    init_users_api(bp, db, models)
    init_roles_api(bp, db, models)
    init_menus_api(bp, db, models)
    init_logs_api(bp, db, models)
    init_dicts_api(bp, db, models)
    init_scheduled_task_api(bp, db, models)
    init_dashboard_api(bp, db, models)
    init_notification_api(bp, db, models)
    init_announcement_api(bp, db, models)
    init_settings_api(bp, db, models)
