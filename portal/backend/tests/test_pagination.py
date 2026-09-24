# -*- coding: utf-8 -*-
"""分页参数钳制验证"""

import pytest
from flask import Flask

from backend.common.pagination import parse_pagination, MAX_PER_PAGE, DEFAULT_PER_PAGE


@pytest.fixture
def app():
    return Flask(__name__)


def test_default_values(app):
    with app.test_request_context('/api/list'):
        page, per_page = parse_pagination()
        assert page == 1
        assert per_page == DEFAULT_PER_PAGE


def test_clamps_per_page_to_max(app):
    with app.test_request_context('/api/list?per_page=1000000'):
        _, per_page = parse_pagination()
        assert per_page == MAX_PER_PAGE


def test_clamps_negative(app):
    with app.test_request_context('/api/list?page=-5&per_page=-1'):
        page, per_page = parse_pagination()
        assert page == 1
        assert per_page == 1


def test_zero_per_page(app):
    with app.test_request_context('/api/list?per_page=0'):
        _, per_page = parse_pagination()
        assert per_page == 1
