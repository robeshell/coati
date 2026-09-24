# -*- coding: utf-8 -*-
"""admin 域标准模型 getter 统一入口

统一 Admin/Role/Menu/LoginLog/OperationLog 的取用函数，避免多个域文件重复定义。
领域特有模型（dicts / scheduled_task）仍保留各自的 <domain>.py getter。
"""


def get_admin_model(models):
    return models['Admin']


def get_role_model(models):
    return models['Role']


def get_menu_model(models):
    return models['Menu']


def get_login_log_model(models):
    return models['LoginLog']


def get_operation_log_model(models):
    return models['OperationLog']
