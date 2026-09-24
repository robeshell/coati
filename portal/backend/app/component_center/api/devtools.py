# -*- coding: utf-8 -*-
"""工程工具类 API：性能监控（psutil）+ WebSocket 实时推送"""

import json
import time
import threading

import psutil
from flask import current_app, jsonify, request, session
from flask_sock import Sock
from urllib.parse import urlparse

from backend.common.auth import has_menu_permission, login_required

_sock = None  # 延迟初始化，由 init_devtools_api 注入


def _system_snapshot():
    """采集当前系统指标，返回 dict"""
    cpu = psutil.cpu_percent(interval=None)
    vm = psutil.virtual_memory()
    disk = psutil.disk_usage('/')
    net = psutil.net_io_counters()
    return {
        'cpu': round(cpu, 1),
        'mem_used': round(vm.used / 1024 / 1024, 1),
        'mem_total': round(vm.total / 1024 / 1024, 1),
        'mem_pct': round(vm.percent, 1),
        'disk_used': round(disk.used / 1024 / 1024 / 1024, 2),
        'disk_total': round(disk.total / 1024 / 1024 / 1024, 2),
        'disk_pct': round(disk.percent, 1),
        'net_sent': round(net.bytes_sent / 1024 / 1024, 2),
        'net_recv': round(net.bytes_recv / 1024 / 1024, 2),
        'ts': int(time.time() * 1000),
    }


def init_devtools_api(bp, db, models, app):
    """注册 REST + WebSocket 路由"""

    # ── 性能指标快照（REST 轮询）────────────────────────────────────────
    @bp.route('/api/admin/component-center/devtools/perf-stats', methods=['GET'])
    @login_required
    def perf_stats():
        if not has_menu_permission('cc_devtools_perf_monitor'):
            return jsonify({'error': '无权限'}), 403
        return jsonify(_system_snapshot())

    # ── WebSocket：实时双向通信 demo ─────────────────────────────────────
    sock = Sock(app)

    def _origin_allowed():
        """校验 WS 握手 Origin，阻断跨站 WebSocket 劫持（CSWSH）。

        允许：同源（Host 与 Origin 一致）或 CORS_ORIGINS 白名单内的来源。
        无 Origin（非浏览器客户端）视为可信，直接放行。
        """
        origin = request.headers.get('Origin')
        if not origin:
            return True
        host = request.headers.get('Host', '')
        if host and urlparse(origin).netloc == host:
            return True
        whitelist = [
            o.strip() for o in
            (current_app.config.get('CORS_ORIGINS') or '').split(',') if o.strip()
        ]
        return origin.rstrip('/') in whitelist

    @sock.route('/ws/devtools')
    def devtools_ws(ws):
        """
        连接后每秒推送系统指标（type=metric），
        同时接收客户端消息并 echo 回去（type=echo）。
        """
        # WebSocket 无路由装饰器鉴权，须在处理器内校验会话 + Origin
        if not _origin_allowed():
            ws.close()
            return
        if not session.get('logged_in'):
            ws.close()
            return
        if not has_menu_permission('cc_devtools_perf_monitor'):
            ws.close()
            return

        stop = threading.Event()

        def push_metrics():
            while not stop.is_set():
                try:
                    snapshot = _system_snapshot()
                    snapshot['type'] = 'metric'
                    ws.send(json.dumps(snapshot, ensure_ascii=False))
                    time.sleep(1)
                except Exception:
                    break

        t = threading.Thread(target=push_metrics, daemon=True)
        t.start()

        try:
            while True:
                data = ws.receive(timeout=30)
                if data is None:
                    break
                # Echo 客户端消息
                try:
                    payload = json.loads(data)
                except Exception:
                    payload = {'text': data}
                payload['type'] = 'echo'
                payload['server_ts'] = int(time.time() * 1000)
                ws.send(json.dumps(payload, ensure_ascii=False))
        finally:
            stop.set()
