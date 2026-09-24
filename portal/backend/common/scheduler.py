# -*- coding: utf-8 -*-
"""后台定时任务调度器"""

from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timedelta

from backend.app.admin.model.scheduled_task import get_scheduled_task_model, get_scheduled_task_run_model
from backend.app.admin.schema.scheduled_task import ScheduledTaskSchemaError, compute_next_run_at
from backend.app.admin.service.scheduled_task import ScheduledTaskService

logger = logging.getLogger(__name__)


class ScheduledTaskRunner:
    def __init__(self, app, db, models, interval_seconds=20, lease_seconds=1800):
        self.app = app
        self.db = db
        self.models = models
        self.interval_seconds = max(5, int(interval_seconds or 20))
        self.lease_seconds = max(self.interval_seconds * 3, int(lease_seconds or 1800))
        self._stop_event = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return

        self._thread = threading.Thread(target=self._loop, name='scheduled-task-runner', daemon=True)
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)

    def _loop(self):
        with self.app.app_context():
            task_model = get_scheduled_task_model(self.models)
            run_model = get_scheduled_task_run_model(self.models)
            service = ScheduledTaskService(self.db, task_model, run_model)

            while not self._stop_event.is_set():
                try:
                    self._execute_due_tasks(task_model, service)
                except Exception:
                    self.db.session.rollback()
                    logger.exception('Scheduled task runner loop failed')
                self._stop_event.wait(self.interval_seconds)

    def _execute_due_tasks(self, task_model, service):
        self._recover_stale_claims(task_model)
        now = datetime.utcnow()
        due_tasks = task_model.query.filter(
            task_model.is_active.is_(True),
            task_model.next_run_at.isnot(None),
            task_model.next_run_at <= now,
        ).order_by(task_model.next_run_at.asc()).limit(20).all()

        for item in due_tasks:
            claim_time = datetime.utcnow()
            claimed = task_model.query.filter(
                task_model.id == item.id,
                task_model.is_active.is_(True),
                task_model.next_run_at == item.next_run_at,
            ).update({
                task_model.next_run_at: None,
                task_model.last_status: 'running',
                task_model.updated_at: claim_time,
            }, synchronize_session=False)
            self.db.session.commit()

            if not claimed:
                continue

            task = task_model.query.get(item.id)
            if not task:
                continue

            try:
                service.execute_task(task, trigger_type='scheduled')
            except Exception:
                self.db.session.rollback()
                next_run_at = datetime.utcnow()
                if task.is_active:
                    try:
                        next_run_at = compute_next_run_at(task.cron_expression, base_time=next_run_at)
                    except ScheduledTaskSchemaError:
                        next_run_at = datetime.utcnow() + timedelta(minutes=5)
                task_model.query.filter(
                    task_model.id == item.id,
                    task_model.next_run_at.is_(None),
                ).update({
                    task_model.next_run_at: next_run_at,
                    task_model.last_status: 'failed',
                    task_model.last_error: '执行器异常中断，任务已自动回收等待重试',
                    task_model.updated_at: datetime.utcnow(),
                }, synchronize_session=False)
                self.db.session.commit()
                logger.exception('Scheduled task execution crashed, task_id=%s', item.id)

    def _recover_stale_claims(self, task_model):
        stale_before = datetime.utcnow() - timedelta(seconds=self.lease_seconds)
        recovered = task_model.query.filter(
            task_model.is_active.is_(True),
            task_model.next_run_at.is_(None),
            task_model.last_status == 'running',
            task_model.updated_at.isnot(None),
            task_model.updated_at <= stale_before,
        ).update({
            task_model.next_run_at: datetime.utcnow(),
            task_model.last_status: 'idle',
            task_model.last_error: '任务租约超时，已自动回收等待重试',
            task_model.updated_at: datetime.utcnow(),
        }, synchronize_session=False)
        if recovered:
            self.db.session.commit()
            logger.warning('Recovered stale scheduled task claims: %s', recovered)


def init_scheduled_task_runner(app, db, models, force=False):
    if app.extensions.get('scheduled_task_runner'):
        return

    enabled = str(app.config.get('ENABLE_TASK_SCHEDULER', 'true')).strip().lower() in {'1', 'true', 'yes', 'on'}
    if not enabled:
        return

    if app.debug and not force and os.environ.get('WERKZEUG_RUN_MAIN') != 'true':
        return

    runner = ScheduledTaskRunner(
        app=app,
        db=db,
        models=models,
        interval_seconds=app.config.get('TASK_SCHEDULER_INTERVAL_SECONDS', 20),
        lease_seconds=app.config.get('TASK_SCHEDULER_LEASE_SECONDS', 1800),
    )
    runner.start()
    app.extensions['scheduled_task_runner'] = runner
