#!/bin/sh
set -e

echo "============================================"
echo "  coati 启动中"
echo "============================================"

# 等待数据库就绪（compose healthcheck 已保证，此处作为额外保险）
# 迁移/RBAC/只读账号由 run_setup_once.py 统一执行（advisory lock 保证多副本并发安全）
echo "[1/2] 运行初始化（迁移 + RBAC + AI SQL 只读账号）..."
python3 backend/scripts/run_setup_once.py

# 支持自定义启动命令（例如 scheduler 服务复用本镜像跑定时任务 worker）
if [ "$#" -gt 0 ]; then
    echo "[2/2] 启动自定义命令: $*"
    exec "$@"
fi

echo "[2/2] 启动 Gunicorn..."
exec gunicorn -c gunicorn_config.py app:app
