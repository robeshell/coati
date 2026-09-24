# -*- coding: utf-8 -*-
"""Component Center model 层入口"""

from .entities_list_page import build_list_page_model
from .entities_stats_list_page import build_stats_list_page_model
from .entities_card_list_page import build_card_list_page_model
from .entities_tree_list_page import build_tree_list_page_model
from .entities_dynamic_form_page import build_dynamic_form_page_model
from .entities_kanban_page import build_kanban_page_model
from .entities_detail_tabs_page import build_detail_tabs_page_model
from .entities_gantt_page import build_gantt_page_model
from .entities_advanced_table_page import build_advanced_table_page_model
from .entities_ai_prompt import build_ai_prompt_models


def build_component_center_models(db):
    models = {}
    models.update(build_list_page_model(db))
    models.update(build_stats_list_page_model(db))
    models.update(build_card_list_page_model(db))
    models.update(build_tree_list_page_model(db))
    models.update(build_dynamic_form_page_model(db))
    models.update(build_kanban_page_model(db))
    models.update(build_detail_tabs_page_model(db))
    models.update(build_gantt_page_model(db))
    models.update(build_advanced_table_page_model(db))
    models.update(build_ai_prompt_models(db))
    return models
