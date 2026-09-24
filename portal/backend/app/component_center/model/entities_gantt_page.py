# -*- coding: utf-8 -*-
"""甘特图页模型定义"""

from datetime import datetime


def build_gantt_page_model(db):
    class GanttTask(db.Model):
        __tablename__ = 'cc_gantt_tasks'

        id = db.Column(db.Integer, primary_key=True)
        title = db.Column(db.String(200), nullable=False)
        task_type = db.Column(db.String(20), default='task')
        start_date = db.Column(db.Date, nullable=False)
        end_date = db.Column(db.Date, nullable=False)
        progress = db.Column(db.Integer, default=0)
        assignee = db.Column(db.String(100))
        priority = db.Column(db.String(20), default='medium')
        status = db.Column(db.String(20), default='not_started')
        color = db.Column(db.String(20), default='#4080FF')
        sort_order = db.Column(db.Integer, default=0)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'title': self.title,
                'task_type': self.task_type or 'task',
                'start_date': self.start_date.isoformat() if self.start_date else None,
                'end_date': self.end_date.isoformat() if self.end_date else None,
                'progress': self.progress if self.progress is not None else 0,
                'assignee': self.assignee,
                'priority': self.priority or 'medium',
                'status': self.status or 'not_started',
                'color': self.color or '#4080FF',
                'sort_order': self.sort_order if self.sort_order is not None else 0,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

    return {'GanttTask': GanttTask}
