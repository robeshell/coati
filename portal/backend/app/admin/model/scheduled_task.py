# -*- coding: utf-8 -*-
"""定时任务 model 入口"""


def get_scheduled_task_model(models):
    return models['ScheduledTask']


def get_scheduled_task_run_model(models):
    return models['ScheduledTaskRun']


def get_admin_model(models):
    return models['Admin']
