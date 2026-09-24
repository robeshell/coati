# -*- coding: utf-8 -*-
"""甘特图页 CRUD 层"""


class GanttPageCRUD:
    def __init__(self, db, task_model):
        self.db = db
        self.GanttTask = task_model

    def all_tasks(self, status=None, priority=None):
        q = self.GanttTask.query
        if status:
            q = q.filter(self.GanttTask.status == status)
        if priority:
            q = q.filter(self.GanttTask.priority == priority)
        return q.order_by(self.GanttTask.sort_order).all()

    def get_task_or_404(self, task_id):
        return self.GanttTask.query.get_or_404(task_id)

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def flush(self):
        self.db.session.flush()

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
