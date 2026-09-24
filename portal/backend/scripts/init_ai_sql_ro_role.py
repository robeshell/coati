#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI SQL 只读角色初始化脚本

在迁移建表之后执行：创建非超级用户只读角色 coati_ro，
仅授予业务表 SELECT（排除 admin_users / 日志 / 定时任务等敏感表），
并强制角色级只读 + 超时。

用法：docker-entrypoint.sh 在 `flask db upgrade` 之后调用。
非 PostgreSQL 或未配置 POSTGRES_RO_PASSWORD 时跳过（不阻塞启动）。
全程幂等，可每次容器启动重跑；新迁移新增的业务表会被自动授权。
"""

import re
import sys
import os

# 添加项目根目录到 Python 路径
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(os.path.dirname(current_dir))
sys.path.insert(0, project_root)

try:
    from app import app, db
    from backend.app.component_center.api.ai_sql_engine import is_visible_table
except Exception as e:
    print(f"模块导入失败: {e}")
    sys.exit(1)

RO_ROLE = 'coati_ro'
_SAFE_TABLE_NAME = re.compile(r'^[a-z0-9_]+$')


def main():
    if db.engine.dialect.name != 'postgresql':
        print('非 PostgreSQL 数据库，跳过 AI SQL 只读角色初始化')
        return

    ro_password = os.environ.get('POSTGRES_RO_PASSWORD', '').strip()
    if not ro_password:
        print('未配置 POSTGRES_RO_PASSWORD，跳过 AI SQL 只读角色初始化')
        return

    print(f"初始化 AI SQL 只读角色: {RO_ROLE} ...")

    try:
        # 1. 幂等创建角色（LOGIN，非超级用户、无建库建角色权限）
        db.session.execute(db.text(f"""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{RO_ROLE}') THEN
                    CREATE ROLE {RO_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
                END IF;
            END $$;
        """))
        # 2. 设置密码（绑定参数，避免注入）
        db.session.execute(db.text(f'ALTER ROLE {RO_ROLE} PASSWORD :pw'), {'pw': ro_password})
        # 3. 角色级强制只读 + 超时（即使绕过应用层连接参数也生效）
        db.session.execute(db.text(f'ALTER ROLE {RO_ROLE} SET default_transaction_read_only = on'))
        db.session.execute(db.text(f'ALTER ROLE {RO_ROLE} SET statement_timeout = 5000'))
        # 4. 允许访问 public 模式
        db.session.execute(db.text(f'GRANT USAGE ON SCHEMA public TO {RO_ROLE}'))

        # 5. 只授予业务表 SELECT（敏感表不授权，连 SELECT 都拿不到）
        tables = db.session.execute(db.text(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        )).scalars().all()
        granted = 0
        for tname in tables:
            if not is_visible_table(tname):
                continue
            # 表名来自 information_schema 且经白名单校验，安全拼接
            if not _SAFE_TABLE_NAME.match(tname):
                print(f"  跳过非预期表名: {tname}")
                continue
            db.session.execute(db.text(f'GRANT SELECT ON TABLE "{tname}" TO {RO_ROLE}'))
            granted += 1

        # 6. 禁止 PUBLIC 使用临时表（加固）
        database_name = db.engine.url.database
        if database_name:
            db.session.execute(db.text(f'REVOKE TEMPORARY ON DATABASE "{database_name}" FROM PUBLIC'))

        db.session.commit()
        print(f"完成：为 {granted} 张业务表授予只读权限")
    except Exception as e:
        db.session.rollback()
        print(f"初始化 AI SQL 只读角色失败: {e}")
        raise SystemExit(1)


if __name__ == '__main__':
    with app.app_context():
        main()
