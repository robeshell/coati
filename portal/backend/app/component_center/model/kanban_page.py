# -*- coding: utf-8 -*-
"""看板页 model 层入口"""

from .entities_kanban_page import build_kanban_page_model


def get_admin_model(models):
    return models.get('Admin')


def get_kanban_board_model(models):
    return models.get('KanbanBoard')


def get_kanban_card_model(models):
    return models.get('KanbanCard')
