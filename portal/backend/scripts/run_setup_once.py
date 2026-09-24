#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
容器并发安全的初始化：数据库迁移 + RBAC 同步 + AI SQL 只读账号。

多副本同时启动时，用 PostgreSQL advisory lock 保证只有一个实例执行初始化，
其余实例在锁上等待；前一个完成后，等待的实例获取锁后执行（幂等）并释放。

用法：docker-entrypoint.sh 在启动 gunicorn 前调用。
"""

import os
import sys
import importlib
from pathlib import Path

current_dir = Path(__file__).resolve().parent
project_root = current_dir.parents[1]
sys.path.insert(0, str(project_root))

ADVISORY_LOCK_KEY = 0x41555341  # "AUSA"


def _acquire_lock(db):
    """获取 PostgreSQL 会话级 advisory lock；非 PostgreSQL 返回 None（不并发）。"""
    if db.engine.dialect.name != 'postgresql':
        return None
    conn = db.engine.connect()
    conn.exec_driver_sql(f'SELECT pg_advisory_lock({ADVISORY_LOCK_KEY})')
    return conn


def _sync_rbac_incrementally():
    """容器启动只同步 RBAC，禁止误触发全量用户数据重建。"""
    rbac = importlib.import_module('backend.scripts.init_rbac_data')
    rbac.main(['--incremental'])


def main():
    from app import app, db
    from flask_migrate import upgrade

    lock_conn = None
    with app.app_context():
        lock_conn = _acquire_lock(db)
        if lock_conn is not None:
            print('[setup] 已获取初始化锁（并发安全）')

        try:
            print('[setup] 运行数据库迁移...')
            upgrade(directory=str(project_root / 'backend' / 'migrations'))
            print('[setup] 数据库迁移完成')

            print('[setup] 同步 RBAC 菜单与权限...')
            _sync_rbac_incrementally()

            print('[setup] 初始化 AI SQL 只读账号...')
            importlib.import_module('backend.scripts.init_ai_sql_ro_role').main()
        finally:
            if lock_conn is not None:
                lock_conn.close()
                print('[setup] 初始化完成，已释放锁')


if __name__ == '__main__':
    main()
