# -*- coding: utf-8 -*-
"""详情标签页 model 层入口"""

from .entities_detail_tabs_page import build_detail_tabs_page_model


def get_admin_model(models):
    return models.get('Admin')


def get_detail_member_model(models):
    return models.get('DetailMember')
