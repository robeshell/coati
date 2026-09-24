"""
Gunicorn 配置文件
用于生产环境部署
"""
import multiprocessing
import os

bind = "0.0.0.0:5000"

workers = multiprocessing.cpu_count() * 2 + 1

worker_class = "sync"

threads = 2

max_requests = 1000
max_requests_jitter = 50

timeout = 120
keepalive = 5

proc_name = "coati_app"

accesslog = "-"
access_log_format = '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s"'

errorlog = "-"
loglevel = "info"

daemon = False

pidfile = "instance/gunicorn.pid"

graceful_timeout = 30

preload_app = True

raw_env = [
    f"FLASK_ENV={os.environ.get('FLASK_ENV', 'production')}",
]


def on_starting(server):
    print("=" * 60)
    print("Gunicorn 服务器启动中...")
    print(f"绑定地址: {bind}")
    print(f"工作进程: {workers}")
    print(f"工作线程: {threads}")
    print(f"环境: {os.environ.get('FLASK_ENV', 'production')}")
    print("=" * 60)


def on_reload(server):
    print("应用重新加载...")


def worker_int(worker):
    print(f"工作进程 {worker.pid} 被中断")


def post_fork(server, worker):
    print(f"工作进程 {worker.pid} 已启动")
