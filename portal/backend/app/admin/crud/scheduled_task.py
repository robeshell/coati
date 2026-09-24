# -*- coding: utf-8 -*-
"""定时任务 CRUD 层"""

from sqlalchemy import or_
from sqlalchemy.orm import joinedload


class ScheduledTaskCRUD:
    def __init__(self, db, task_model, run_model):
        self.db = db
        self.ScheduledTask = task_model
        self.ScheduledTaskRun = run_model

    def task_query(self):
        return self.ScheduledTask.query

    def run_query(self):
        return self.ScheduledTaskRun.query

    def get_task_or_404(self, task_id):
        return self.ScheduledTask.query.get_or_404(task_id)

    def get_task(self, task_id):
        return self.ScheduledTask.query.get(task_id)

    def get_task_by_code(self, task_code):
        return self.ScheduledTask.query.filter_by(task_code=task_code).first()

    def get_other_task_by_code(self, task_code, task_id):
        return self.ScheduledTask.query.filter(
            self.ScheduledTask.task_code == task_code,
            self.ScheduledTask.id != task_id,
        ).first()

    def page_tasks(self, page, per_page, search='', is_active=None, status=''):
        query = self.task_query()
        if search:
            like = f'%{search}%'
            query = query.filter(or_(
                self.ScheduledTask.name.ilike(like),
                self.ScheduledTask.task_code.ilike(like),
                self.ScheduledTask.request_url.ilike(like),
            ))
        if is_active is not None:
            query = query.filter(self.ScheduledTask.is_active == is_active)
        if status:
            query = query.filter(self.ScheduledTask.last_status == status)
        return query.order_by(self.ScheduledTask.id.desc()).paginate(page=page, per_page=per_page, error_out=False)

    def page_runs(self, page, per_page, task_id=None, status=''):
        query = self.run_query().join(self.ScheduledTask, self.ScheduledTask.id == self.ScheduledTaskRun.task_id)
        if task_id:
            query = query.filter(self.ScheduledTaskRun.task_id == task_id)
        if status:
            query = query.filter(self.ScheduledTaskRun.status == status)
        return query.options(joinedload(self.ScheduledTaskRun.task)).order_by(
            self.ScheduledTaskRun.id.desc()
        ).paginate(page=page, per_page=per_page, error_out=False)

    def list_tasks_by_ids(self, ids):
        return self.ScheduledTask.query.filter(self.ScheduledTask.id.in_(ids))

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
