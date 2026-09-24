# -*- coding: utf-8 -*-
"""甘特图页 service 层"""

from datetime import date

from backend.app.component_center.crud.gantt_page import GanttPageCRUD
from backend.app.component_center.schema.gantt_page import (
    TASK_TYPE_VALUES,
    PRIORITY_VALUES,
    STATUS_VALUES,
    parse_int,
)


class GanttPageServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class GanttPageService:
    def __init__(self, db, task_model):
        self.db = db
        self.GanttTask = task_model
        self.crud = GanttPageCRUD(db, task_model)

    def _parse_date(self, value):
        if not value:
            return None
        if isinstance(value, date):
            return value
        try:
            return date.fromisoformat(str(value)[:10])
        except ValueError:
            return None

    # ── 任务 ─────────────────────────────────────────────────────────────

    def get_all_tasks(self, status=None, priority=None):
        tasks = self.crud.all_tasks(status=status, priority=priority)
        return [t.to_dict() for t in tasks]

    def create_task(self, data):
        title = str(data.get('title') or '').strip()
        if not title:
            raise GanttPageServiceError('任务标题不能为空')

        start_date = self._parse_date(data.get('start_date'))
        end_date = self._parse_date(data.get('end_date'))
        if not start_date:
            raise GanttPageServiceError('开始日期不能为空')
        if not end_date:
            raise GanttPageServiceError('结束日期不能为空')

        task_type = str(data.get('task_type') or 'task').strip()
        if task_type not in TASK_TYPE_VALUES:
            task_type = 'task'

        priority = str(data.get('priority') or 'medium').strip()
        if priority not in PRIORITY_VALUES:
            priority = 'medium'

        status = str(data.get('status') or 'not_started').strip()
        if status not in STATUS_VALUES:
            status = 'not_started'

        progress = parse_int(data.get('progress'), default=0)
        progress = max(0, min(100, progress))

        task = self.GanttTask(
            title=title,
            task_type=task_type,
            start_date=start_date,
            end_date=end_date,
            progress=progress,
            assignee=str(data.get('assignee') or '').strip() or None,
            priority=priority,
            status=status,
            color=str(data.get('color') or '#4080FF').strip() or '#4080FF',
            sort_order=parse_int(data.get('sort_order'), default=0),
        )
        try:
            self.crud.add(task)
            self.crud.commit()
            return task.to_dict(), 201
        except Exception as e:
            self.crud.rollback()
            raise GanttPageServiceError(str(e), 500) from e

    def update_task(self, task, data):
        if 'title' in data and not str(data.get('title') or '').strip():
            raise GanttPageServiceError('任务标题不能为空')

        field_map = {
            'title':      lambda v: str(v or '').strip(),
            'assignee':   lambda v: str(v or '').strip() or None,
            'color':      lambda v: str(v or '#4080FF').strip() or '#4080FF',
            'sort_order': lambda v: parse_int(v, default=task.sort_order or 0),
        }
        for field, converter in field_map.items():
            if field in data:
                setattr(task, field, converter(data[field]))

        if 'task_type' in data:
            t = str(data['task_type'] or 'task').strip()
            task.task_type = t if t in TASK_TYPE_VALUES else 'task'

        if 'priority' in data:
            p = str(data['priority'] or 'medium').strip()
            task.priority = p if p in PRIORITY_VALUES else 'medium'

        if 'status' in data:
            s = str(data['status'] or 'not_started').strip()
            task.status = s if s in STATUS_VALUES else 'not_started'

        if 'progress' in data:
            progress = parse_int(data['progress'], default=task.progress or 0)
            task.progress = max(0, min(100, progress))

        if 'start_date' in data:
            task.start_date = self._parse_date(data['start_date'])

        if 'end_date' in data:
            task.end_date = self._parse_date(data['end_date'])

        try:
            self.crud.commit()
            return task.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise GanttPageServiceError(str(e), 500) from e

    def delete_task(self, task):
        try:
            self.crud.delete(task)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise GanttPageServiceError(str(e), 500) from e
