# -*- coding: utf-8 -*-
"""组件示例中心路由装配"""

from backend.app.component_center.api.list_page import init_list_page_api
from backend.app.component_center.api.stats_list_page import init_stats_list_page_api
from backend.app.component_center.api.card_list_page import init_card_list_page_api
from backend.app.component_center.api.tree_list_page import init_tree_list_page_api
from backend.app.component_center.api.dynamic_form_page import init_dynamic_form_page_api
from backend.app.component_center.api.kanban_page import init_kanban_page_api
from backend.app.component_center.api.detail_tabs_page import init_detail_tabs_page_api
from backend.app.component_center.api.gantt_page import init_gantt_page_api
from backend.app.component_center.api.map_heatmap import init_map_heatmap_api
from backend.app.component_center.api.ai_chat import init_ai_chat_api
from backend.app.component_center.api.ai_prompt import init_ai_prompt_api
from backend.app.component_center.api.ai_sql import init_ai_sql_api
from backend.app.component_center.api.devtools import init_devtools_api
from backend.app.component_center.api.advanced_table_page import init_advanced_table_page_api


def register_component_center_routes(bp, db, models, app=None):
    init_list_page_api(bp, db, models)
    init_stats_list_page_api(bp, db, models)
    init_card_list_page_api(bp, db, models)
    init_tree_list_page_api(bp, db, models)
    init_dynamic_form_page_api(bp, db, models)
    init_kanban_page_api(bp, db, models)
    init_detail_tabs_page_api(bp, db, models)
    init_gantt_page_api(bp, db, models)
    init_advanced_table_page_api(bp, db, models)
    init_map_heatmap_api(bp, db, models)
    init_ai_chat_api(bp, db, models)
    init_ai_prompt_api(bp, db, models)
    init_ai_sql_api(bp, db, models)
    if app is not None:
        init_devtools_api(bp, db, models, app)
