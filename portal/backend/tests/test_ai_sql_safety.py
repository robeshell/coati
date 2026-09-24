# -*- coding: utf-8 -*-
"""AI SQL 只读沙箱：is_safe_sql 黑名单加固验证"""

from types import SimpleNamespace

import pytest

from backend.app.component_center.api import ai_sql_engine
from backend.app.component_center.api.ai_sql import is_safe_sql
from backend.app.component_center.api.ai_sql_engine import get_ai_sql_engine, is_visible_table


def test_allows_basic_select():
    ok, _ = is_safe_sql('SELECT * FROM kanban_boards')
    assert ok is True


def test_allows_with_cte():
    ok, _ = is_safe_sql('WITH x AS (SELECT 1) SELECT * FROM x')
    assert ok is True


def test_allows_trailing_semicolon():
    ok, _ = is_safe_sql('SELECT * FROM kanban_boards;')
    assert ok is True


def test_blocks_multi_statement():
    ok, reason = is_safe_sql('SELECT 1; DROP TABLE x')
    assert ok is False
    assert '分号' in reason


def test_blocks_pg_read_file():
    ok, _ = is_safe_sql("SELECT pg_read_file('/etc/passwd')")
    assert ok is False


def test_blocks_select_into():
    ok, _ = is_safe_sql('SELECT 1 INTO new_table')
    assert ok is False


def test_blocks_set_role():
    ok, _ = is_safe_sql('SET ROLE postgres')
    assert ok is False


def test_blocks_for_update():
    ok, _ = is_safe_sql('SELECT * FROM t FOR UPDATE')
    assert ok is False


def test_blocks_copy():
    ok, _ = is_safe_sql('COPY t TO stdout')
    assert ok is False


def test_column_name_delete_not_false_positive():
    ok, _ = is_safe_sql('SELECT delete_status FROM t')
    assert ok is True


def test_column_name_into_not_false_positive():
    ok, _ = is_safe_sql('SELECT into_x FROM t')
    assert ok is True


def test_string_literal_keyword_not_false_positive():
    # 字符串字面量内的关键字不应触发误杀（真实防护由只读引擎兜底）
    ok, _ = is_safe_sql("SELECT 'delete' AS label, 'drop table' AS txt FROM t")
    assert ok is True
    ok, _ = is_safe_sql('SELECT "DROP" FROM t')
    assert ok is True


def test_string_literal_dangerous_func_not_false_positive():
    ok, _ = is_safe_sql("SELECT 'pg_sleep(999)' AS note FROM t")
    assert ok is True


def test_real_dangerous_func_still_blocked():
    ok, _ = is_safe_sql('SELECT pg_sleep(5)')
    assert ok is False
    ok, _ = is_safe_sql('SELECT pg_read_file(\'/etc/passwd\')')
    assert ok is False


def test_sensitive_tables_hidden():
    for table in ['admin_users', 'login_logs', 'operation_logs', 'roles', 'menus',
                  'user_roles', 'role_menus', 'scheduled_tasks', 'scheduled_task_runs']:
        assert is_visible_table(table) is False
    assert is_visible_table('kanban_boards') is True


def _dummy_db(url='postgresql://superuser:pw@db/coati'):
    return SimpleNamespace(engine=SimpleNamespace(url=url))


def test_ai_sql_engine_fail_closed_in_production(monkeypatch):
    monkeypatch.setattr(ai_sql_engine, '_ai_sql_engine', None)
    monkeypatch.setenv('FLASK_ENV', 'production')
    monkeypatch.delenv('AI_SQL_DATABASE_URL', raising=False)
    with pytest.raises(RuntimeError, match='AI_SQL_DATABASE_URL'):
        get_ai_sql_engine(_dummy_db())


def test_ai_sql_engine_uses_explicit_url_in_production(monkeypatch):
    monkeypatch.setattr(ai_sql_engine, '_ai_sql_engine', None)
    monkeypatch.setenv('FLASK_ENV', 'production')
    monkeypatch.setenv('AI_SQL_DATABASE_URL', 'postgresql://coati_ro:pw@db/coati')
    try:
        engine = get_ai_sql_engine(_dummy_db())
        assert str(engine.url).startswith('postgresql://coati_ro')
    finally:
        ai_sql_engine._ai_sql_engine = None


def test_ai_sql_engine_dev_fallback_to_main_db(monkeypatch):
    monkeypatch.setattr(ai_sql_engine, '_ai_sql_engine', None)
    monkeypatch.setenv('FLASK_ENV', 'development')
    monkeypatch.delenv('AI_SQL_DATABASE_URL', raising=False)
    try:
        engine = get_ai_sql_engine(_dummy_db())
        rendered = str(engine.url)
        # sqlalchemy 渲染时会隐藏密码，此处只校验主机/库/用户名来自主库 URL
        assert 'superuser@db/coati' in rendered or '@db/coati' in rendered
    finally:
        ai_sql_engine._ai_sql_engine = None
