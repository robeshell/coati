# -*- coding: utf-8 -*-
"""模型账号健康度低频探测定时器。

后台定时任务引擎只支持 HTTP 回调且禁止内网地址，无法自调用网关内部接口，
所以这里按 ScheduledTaskRunner 的模式起一个进程内轻量线程：周期性挑出
"异常/冷却/未检测、且距上次探测超过静默窗口"的启用账号做一次廉价探测。

- 模型列表可探测的账号成功 → mark_success 满血复位（连冷却一起解除）；
- 原生协议不提供模型列表 → 只记录探测时间，不宣称账号健康；
- 其它失败 → 软记账（只刷新观测时间），不会延长任何硬惩罚。

开关与节奏见 config：
AGENT_CREDENTIAL_PROBE_ENABLED / _INTERVAL_SECONDS / _QUIET_SECONDS / _BATCH_LIMIT

本文件只做线程编排；数据库访问全部经由 AgentCredentialService 及其 crud 层。
"""

from __future__ import annotations

import logging
import os
import threading

from backend.app.agent.service.credential_service import AgentCredentialService

logger = logging.getLogger(__name__)


class CredentialProbeRunner:
    def __init__(self, app, service, interval_seconds=300):
        self.app = app
        self.service = service
        self.interval_seconds = max(30, int(interval_seconds or 300))
        self._stop_event = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name='credential-probe-runner', daemon=True)
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)

    def _loop(self):
        with self.app.app_context():
            while not self._stop_event.is_set():
                # 启动即先跑一轮是有意行为：worker 重启后尽快给 unknown 新账号一个首次结论。
                try:
                    result = self.service.probe_stale_credentials()
                    if result['probed']:
                        logger.info(
                            'Credential probe: probed=%(probed)s recovered=%(recovered)s still_failing=%(still_failing)s',
                            result,
                        )
                except Exception:
                    # 整轮失败时复位会话，避免脏状态影响下一轮。
                    try:
                        self.service.crud.reset_session()
                    except Exception:
                        pass
                    logger.exception('Credential probe loop failed')
                self._stop_event.wait(self.interval_seconds)


def init_credential_probe_runner(app, db, models, force=False):
    if app.extensions.get('credential_probe_runner'):
        return

    enabled = str(app.config.get('AGENT_CREDENTIAL_PROBE_ENABLED', 'true')).strip().lower() in {
        '1', 'true', 'yes', 'on',
    }
    if not enabled:
        return

    # 与 ScheduledTaskRunner 一致：debug 重载的父进程不起线程，避免双跑。
    if app.debug and not force and os.environ.get('WERKZEUG_RUN_MAIN') != 'true':
        return

    # 构造服务实例本身不触发查询，真正的 DB 访问都发生在探测方法的 app context 内。
    service = AgentCredentialService(db, models)
    runner = CredentialProbeRunner(
        app=app,
        service=service,
        interval_seconds=app.config.get('AGENT_CREDENTIAL_PROBE_INTERVAL_SECONDS', 300),
    )
    runner.start()
    app.extensions['credential_probe_runner'] = runner
