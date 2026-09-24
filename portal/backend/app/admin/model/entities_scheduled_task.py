# -*- coding: utf-8 -*-
"""定时任务模型定义"""

from datetime import datetime


def build_scheduled_task_models(db):
    class ScheduledTask(db.Model):
        __tablename__ = 'scheduled_tasks'

        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(120), nullable=False)
        task_code = db.Column(db.String(120), nullable=False, unique=True)
        cron_expression = db.Column(db.String(120), nullable=False)
        request_method = db.Column(db.String(10), default='GET')
        request_url = db.Column(db.String(500), nullable=False)
        request_headers = db.Column(db.Text)
        request_body = db.Column(db.Text)
        timeout_seconds = db.Column(db.Integer, default=10)
        is_active = db.Column(db.Boolean, default=True)
        remark = db.Column(db.Text)

        last_status = db.Column(db.String(20), default='idle')
        last_error = db.Column(db.Text)
        last_duration_ms = db.Column(db.Integer)
        run_count = db.Column(db.Integer, default=0)
        last_run_at = db.Column(db.DateTime)
        next_run_at = db.Column(db.DateTime)

        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'name': self.name,
                'task_code': self.task_code,
                'cron_expression': self.cron_expression,
                'request_method': self.request_method,
                'request_url': self.request_url,
                'request_headers': self.request_headers,
                'request_body': self.request_body,
                'timeout_seconds': self.timeout_seconds,
                'is_active': self.is_active,
                'remark': self.remark,
                'last_status': self.last_status,
                'last_error': self.last_error,
                'last_duration_ms': self.last_duration_ms,
                'run_count': self.run_count,
                'last_run_at': self.last_run_at.isoformat() if self.last_run_at else None,
                'next_run_at': self.next_run_at.isoformat() if self.next_run_at else None,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

    class ScheduledTaskRun(db.Model):
        __tablename__ = 'scheduled_task_runs'

        id = db.Column(db.Integer, primary_key=True)
        task_id = db.Column(db.Integer, db.ForeignKey('scheduled_tasks.id', ondelete='CASCADE'), nullable=False)
        trigger_type = db.Column(db.String(20), default='scheduled')
        status = db.Column(db.String(20), nullable=False)
        response_status = db.Column(db.Integer)
        response_body = db.Column(db.Text)
        error_message = db.Column(db.Text)
        started_at = db.Column(db.DateTime, default=datetime.utcnow)
        finished_at = db.Column(db.DateTime)
        duration_ms = db.Column(db.Integer)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

        task = db.relationship('ScheduledTask', backref=db.backref('runs', lazy='dynamic', cascade='all, delete-orphan'))

        def to_dict(self):
            return {
                'id': self.id,
                'task_id': self.task_id,
                'task_name': self.task.name if self.task else None,
                'task_code': self.task.task_code if self.task else None,
                'trigger_type': self.trigger_type,
                'status': self.status,
                'response_status': self.response_status,
                'response_body': self.response_body,
                'error_message': self.error_message,
                'started_at': self.started_at.isoformat() if self.started_at else None,
                'finished_at': self.finished_at.isoformat() if self.finished_at else None,
                'duration_ms': self.duration_ms,
                'created_at': self.created_at.isoformat() if self.created_at else None,
            }

    return {
        'ScheduledTask': ScheduledTask,
        'ScheduledTaskRun': ScheduledTaskRun,
    }
