# -*- coding: utf-8 -*-
"""表格公式注入防护验证"""

from backend.common.tabular import _sanitize_formula


def test_prefixes_formula_start():
    assert _sanitize_formula('=SUM(A1)').startswith("'")
    assert _sanitize_formula('@cmd').startswith("'")
    assert _sanitize_formula('+cmd').startswith("'")
    assert _sanitize_formula('-cmd|').startswith("'")


def test_keeps_negative_numbers():
    assert _sanitize_formula('-5') == '-5'
    assert _sanitize_formula('-1.5') == '-1.5'


def test_keeps_normal_text():
    assert _sanitize_formula('hello') == 'hello'
    assert _sanitize_formula('2026-01-01') == '2026-01-01'
