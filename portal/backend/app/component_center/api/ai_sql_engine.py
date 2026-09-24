# -*- coding: utf-8 -*-
"""AI SQL 专用只读数据库访问层

为 AI Text-to-SQL 提供独立、强制只读的数据库引擎，避免用户提交的任意
SELECT 在应用的主库连接（生产为超级用户）上执行。

核心保障（纵深防御）：
1. 独立 engine，生产通过 AI_SQL_DATABASE_URL 指向非超级用户只读账号
   coati_ro（仅授予业务表 SELECT，不含 admin_users/日志等敏感表）。
2. 连接启动参数 -c default_transaction_read_only=on + -c statement_timeout=...
   在物理连接建立阶段就强制只读，早于任何用户 SQL。
3. 每次请求重新 SET read_only / statement_timeout，抵消池化连接上被
   set_config 毒化（翻回可写）的可能。
4. SQL 一律包裹成 SELECT * FROM (<sql>) AS _q LIMIT N，强制服务端行数上限。
"""

import os

from sqlalchemy import create_engine

# 单次查询最多返回行数
MAX_SQL_ROWS = 200

# 敏感表：AI SQL 既不让 LLM/前端看到 schema，也不给只读账号授权
SENSITIVE_EXACT = {'roles', 'menus', 'user_roles', 'role_menus'}
SENSITIVE_PREFIX = ('admin_', 'audit_', 'scheduled_task')
SENSITIVE_SUFFIX = ('_logs',)


def is_visible_table(table_name):
    """业务表才可见/可授权；含凭据或内部信息的表一律排除。"""
    name = (table_name or '').lower()
    if name in SENSITIVE_EXACT:
        return False
    if name.startswith(SENSITIVE_PREFIX) or name.endswith(SENSITIVE_SUFFIX):
        return False
    return True


def _statement_timeout_ms():
    return int(os.environ.get('AI_SQL_STATEMENT_TIMEOUT_MS', '5000'))


def _is_production():
    return os.environ.get('FLASK_ENV', 'development').lower() == 'production'


_ai_sql_engine = None


def get_ai_sql_engine(db):
    """懒加载、进程内缓存的独立只读 engine。

    - 生产环境（FLASK_ENV=production）必须显式配置 AI_SQL_DATABASE_URL，
      指向非超级用户只读账号（coati_ro）；缺失时拒绝启动（fail-closed），
      禁止把用户提交的 SQL 放到主库（可能为超级用户）连接上执行。
    - 开发环境未配置时回退到主库 URL，但连接启动参数仍强制只读 + 超时。
    该 engine 不注册进 db，业务写操作不感知、不受影响。
    """
    global _ai_sql_engine
    if _ai_sql_engine is None:
        url = os.environ.get('AI_SQL_DATABASE_URL')
        if not url:
            if _is_production():
                raise RuntimeError(
                    '生产环境必须设置 AI_SQL_DATABASE_URL（指向非超级用户只读账号 coati_ro），'
                    '禁止回退到主库连接执行用户提交的 SQL'
                )
            url = str(db.engine.url)
        timeout_ms = _statement_timeout_ms()
        _ai_sql_engine = create_engine(
            url,
            pool_pre_ping=True,
            pool_recycle=1800,
            connect_args={
                'options': f'-c default_transaction_read_only=on -c statement_timeout={timeout_ms}',
            },
        )
    return _ai_sql_engine


def execute_readonly(engine, sql):
    """在只读连接上执行单条 SELECT，返回 (columns, rows, truncated)。

    - 逐请求重武装 read_only / statement_timeout，防池化连接被 set_config 毒化；
    - 包裹 LIMIT 强制服务端行数上限，超过 MAX_SQL_ROWS 的行丢弃并置 truncated。
    """
    # 去尾部单个分号与空白（is_safe_sql 已保证不含其他分号）。
    # 注意：不用 f-string 拼接包裹，避免用户 SQL 中的 { } 被误解析。
    sql = sql.rstrip().rstrip(';').rstrip()
    wrapped = 'SELECT * FROM (' + sql + ') AS _q LIMIT ' + str(MAX_SQL_ROWS + 1)

    with engine.connect() as conn:
        conn.exec_driver_sql('SET default_transaction_read_only = on')
        conn.exec_driver_sql('SET statement_timeout = %d' % _statement_timeout_ms())
        result = conn.exec_driver_sql(wrapped)

        columns = list(result.keys())
        rows_raw = result.fetchall()
        truncated = len(rows_raw) > MAX_SQL_ROWS
        rows_raw = rows_raw[:MAX_SQL_ROWS]

    rows = []
    for row in rows_raw:
        row_dict = {}
        for i, col in enumerate(columns):
            val = row[i]
            if val is None:
                row_dict[col] = None
            elif hasattr(val, 'isoformat'):
                row_dict[col] = val.isoformat()
            elif isinstance(val, (int, float, bool)):
                row_dict[col] = val
            else:
                row_dict[col] = str(val)
        rows.append(row_dict)

    return columns, rows, truncated
