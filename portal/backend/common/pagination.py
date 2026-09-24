# -*- coding: utf-8 -*-
"""分页参数解析工具"""

from flask import request

# 单页最多返回行数，防止 ?per_page=1000000 整表拉取
MAX_PER_PAGE = 200
DEFAULT_PER_PAGE = 20


def parse_pagination():
    """从请求参数解析并钳制 page / per_page，返回 (page, per_page)。"""
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', DEFAULT_PER_PAGE, type=int)
    page = max(page, 1)
    per_page = min(max(per_page, 1), MAX_PER_PAGE)
    return page, per_page
