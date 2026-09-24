# -*- coding: utf-8 -*-
"""AI Text-to-SQL API — 自然语言转 SQL 查询（只读，隔离于业务写连接）"""

import re
import os
import requests
from flask import jsonify, request, current_app
from sqlalchemy import inspect
from backend.common.auth import has_menu_permission, login_required
from backend.app.component_center.api.ai_sql_engine import (
    get_ai_sql_engine,
    execute_readonly,
    is_visible_table,
)


# ─── 工具函数 ────────────────────────────────────────────────────────────────

# 单引号字符串字面量（含 '' 转义与双引号标识符）；剥离后做关键字判定，避免
# SELECT 'delete' / "DROP" 这类字面量/标识符触发误杀。真实拦截仍由只读引擎兜底。
_STRING_LITERAL_RE = re.compile(
    r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"",
    re.DOTALL,
)


def _strip_literals(sql):
    """移除字符串/标识符字面量，返回用于关键字判定的残影文本"""
    return _STRING_LITERAL_RE.sub(' ', sql)


def get_db_schema(db):
    """读取业务表结构，返回 LLM 可读的文本（敏感表一律不暴露）"""
    inspector = inspect(get_ai_sql_engine(db))
    table_names = sorted(t for t in inspector.get_table_names() if is_visible_table(t))
    blocks = []
    for tname in table_names:
        columns = inspector.get_columns(tname)
        col_lines = []
        for col in columns:
            nullable = '' if col.get('nullable', True) else ' NOT NULL'
            default = f" DEFAULT {col['default']}" if col.get('default') is not None else ''
            col_lines.append(f"  {col['name']}  {col['type']}{nullable}{default}")
        blocks.append(f"TABLE {tname} (\n" + ",\n".join(col_lines) + "\n)")
    return "\n\n".join(blocks)


def is_safe_sql(sql: str):
    """只允许单条 SELECT / WITH（CTE）查询；拦截写操作、DDL、控制语句与高危函数"""
    # 去除注释，避免注释内容干扰判定
    stripped = re.sub(r'--[^\n]*', ' ', sql)
    stripped = re.sub(r'/\*.*?\*/', ' ', stripped, flags=re.DOTALL)
    # 去尾部单个分号（LLM 可能输出结尾 ;）
    stripped = stripped.rstrip().rstrip(';').rstrip()
    clean = stripped.strip().upper()

    if not (clean.startswith('SELECT') or clean.startswith('WITH')):
        return False, '只允许 SELECT 查询语句'

    if ';' in clean:
        return False, '仅允许单条语句，不能包含分号'

    # 关键字/函数判定在剥离字面量后进行，避免字符串内容误杀（真实防护由只读引擎兜底）
    code = _strip_literals(clean).upper()

    # DML / DDL / 控制语句关键字（禁 SET 封死 SET ROLE / SET ... read_only=off）
    control = [
        'ALTER', 'CREATE', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE',
        'DELETE', 'UPDATE', 'INSERT', 'INTO', 'MERGE', 'CALL', 'DO',
        'VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER', 'REFRESH', 'LOCK',
        'COPY', 'SET', 'RESET', 'DISCARD', 'COMMENT', 'EXEC', 'EXECUTE',
    ]
    for kw in control:
        if re.search(rf'\b{kw}\b', code):
            return False, f'SQL 包含不允许的操作关键字：{kw}'

    # 行锁子句（写语义，且包裹子查询也不支持）
    if re.search(r'\bFOR\s+(UPDATE|SHARE)\b', code):
        return False, '不允许使用 FOR UPDATE / FOR SHARE'

    # 高危函数调用（仅拦截真实函数调用，列名等不受影响）
    dangerous_funcs = [
        'pg_read_file', 'pg_read_binary_file', 'pg_write_file', 'pg_ls_dir',
        'pg_ls_logdir', 'pg_ls_waldir', 'pg_stat_file', 'pg_relation_filepath',
        'pg_terminate_backend', 'pg_cancel_backend', 'pg_sleep', 'pg_sleep_for',
        'pg_sleep_until', 'pg_execute_server_program', 'pg_log_backend_memory_contexts',
        'set_config', 'lo_import', 'lo_export', 'lo_unlink', 'pg_reload_conf',
        'pg_rotate_logfile', 'pg_start_backup', 'pg_stop_backup', 'pg_switch_wal',
        'pg_create_restore_point', 'dblink',
    ]
    for fn in dangerous_funcs:
        if re.search(rf'\b{re.escape(fn.upper())}\s*\(', code):
            return False, f'SQL 使用了不允许的函数：{fn}'

    return True, None


def clean_sql(raw: str) -> str:
    """去除 LLM 可能输出的 markdown 代码块包装"""
    sql = raw.strip()
    sql = re.sub(r'^```sql\s*', '', sql, flags=re.IGNORECASE)
    sql = re.sub(r'^```\s*', '', sql)
    sql = re.sub(r'\s*```$', '', sql)
    return sql.strip()


def call_llm(question: str, schema: str) -> str:
    """调用 LLM 生成 SQL"""
    base = os.environ.get('AI_API_BASE', '')
    key  = os.environ.get('AI_API_KEY', '')
    model = os.environ.get('AI_MODEL', '')

    if not key:
        raise ValueError('未配置 AI_API_KEY 环境变量')

    system_msg = {
        'role': 'system',
        'content': (
            '你是一个 PostgreSQL 专家。用户会给你一个问题，你只需返回一条合法的 PostgreSQL SELECT 语句，'
            '不要有任何解释、注释或 Markdown 格式。\n\n'
            '规则：\n'
            '1. 只写 SELECT 语句（允许 WITH CTE）\n'
            '2. 若结果可能很多，自动加 LIMIT 200\n'
            '3. 时间字段用 DATE_TRUNC 或 TO_CHAR 格式化\n'
            '4. 返回内容只有 SQL，不带任何其他文字'
        ),
    }
    user_msg = {
        'role': 'user',
        'content': f'数据库结构如下：\n\n{schema}\n\n问题：{question}',
    }

    resp = requests.post(
        f'{base}/chat/completions',
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
        json={'model': model, 'messages': [system_msg, user_msg]},
        timeout=30,
    )
    if resp.status_code != 200:
        raise ValueError(f'LLM 接口错误 ({resp.status_code}): {resp.text[:300]}')

    raw_sql = resp.json()['choices'][0]['message']['content']
    return clean_sql(raw_sql)


def execute_sql(db, sql: str):
    """在只读引擎上执行 SQL，返回 columns + rows + truncated（JSON 可序列化）"""
    columns, rows, truncated = execute_readonly(get_ai_sql_engine(db), sql)
    return {'columns': columns, 'rows': rows, 'row_count': len(rows), 'truncated': truncated}


# ─── 路由注册 ────────────────────────────────────────────────────────────────

def init_ai_sql_api(bp, db, models):

    @bp.route('/api/admin/component-center/ai/sql/schema', methods=['GET'])
    @login_required
    def ai_sql_schema():
        """获取数据库表结构（供前端展示，敏感表不暴露）"""
        if not has_menu_permission('cc_ai_sql'):
            return jsonify({'error': '无权限'}), 403
        try:
            inspector = inspect(get_ai_sql_engine(db))
            tables = sorted(t for t in inspector.get_table_names() if is_visible_table(t))
            schema_text = get_db_schema(db)
            return jsonify({'tables': tables, 'schema': schema_text})
        except Exception as e:
            current_app.logger.warning('ai_sql schema failed: %s', e)
            return jsonify({'error': '获取数据库结构失败'}), 500

    @bp.route('/api/admin/component-center/ai/sql/generate', methods=['POST'])
    @login_required
    def ai_sql_generate():
        """自然语言 → SQL → 执行 → 返回结果"""
        if not has_menu_permission('cc_ai_sql'):
            return jsonify({'error': '无权限'}), 403

        data = request.get_json() or {}
        question = (data.get('question') or '').strip()
        if not question:
            return jsonify({'error': '问题不能为空'}), 400

        try:
            schema = get_db_schema(db)
            sql = call_llm(question, schema)
        except ValueError as e:
            current_app.logger.warning('ai_sql generate failed: %s', e)
            return jsonify({'error': 'AI 生成失败，请检查模型配置后重试'}), 500
        except Exception as e:
            current_app.logger.warning('ai_sql generate failed: %s', e)
            return jsonify({'error': 'AI 生成失败'}), 500

        safe, reason = is_safe_sql(sql)
        if not safe:
            return jsonify({'error': reason, 'sql': sql}), 400

        try:
            result = execute_sql(db, sql)
            return jsonify({'sql': sql, **result})
        except Exception as e:
            current_app.logger.warning('ai_sql execute failed: %s', e)
            return jsonify({'error': 'SQL 执行错误，请检查语法或表权限', 'sql': sql}), 400

    @bp.route('/api/admin/component-center/ai/sql/execute', methods=['POST'])
    @login_required
    def ai_sql_execute():
        """执行用户手动修改后的 SQL"""
        if not has_menu_permission('cc_ai_sql'):
            return jsonify({'error': '无权限'}), 403

        data = request.get_json() or {}
        sql = (data.get('sql') or '').strip()
        if not sql:
            return jsonify({'error': 'SQL 不能为空'}), 400

        safe, reason = is_safe_sql(sql)
        if not safe:
            return jsonify({'error': reason}), 400

        try:
            result = execute_sql(db, sql)
            return jsonify({'sql': sql, **result})
        except Exception as e:
            current_app.logger.warning('ai_sql execute failed: %s', e)
            return jsonify({'error': 'SQL 执行错误，请检查语法或表权限', 'sql': sql}), 400
