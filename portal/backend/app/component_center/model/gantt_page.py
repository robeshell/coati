# -*- coding: utf-8 -*-
"""甘特图页 model 层入口"""

from .entities_gantt_page import build_gantt_page_model


def get_admin_model(models):
    return models.get('Admin')


def get_gantt_task_model(models):
    return models.get('GanttTask')
