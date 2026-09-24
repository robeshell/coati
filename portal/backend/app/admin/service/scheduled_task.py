# -*- coding: utf-8 -*-
"""定时任务 service 层"""

from __future__ import annotations

import json
from datetime import datetime

import requests

from backend.app.admin.crud.scheduled_task import ScheduledTaskCRUD
from backend.app.admin.schema.scheduled_task import (
    ScheduledTaskSchemaError,
    compute_next_run_at,
    parse_bool,
    parse_cron_expression,
    parse_int,
    parse_json_object,
    validate_request_url,
)
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete


class ScheduledTaskServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class ScheduledTaskService:
    def __init__(self, db, task_model, run_model):
        self.ScheduledTask = task_model
        self.ScheduledTaskRun = run_model
        self.crud = ScheduledTaskCRUD(db, task_model, run_model)

    def require_task(self, task_id):
        task = self.crud.get_task(task_id)
        if not task:
            raise ScheduledTaskServiceError('定时任务不存在', 404)
        return task

    def get_task(self, task_id):
        return self.require_task(task_id).to_dict()

    def list_tasks(self, page=1, per_page=20, search='', is_active=None, status=''):
        pagination = self.crud.page_tasks(page, per_page, search, is_active, status)
        return {
            'items': [item.to_dict() for item in pagination.items],
            'total': pagination.total,
            'page': page,
            'per_page': per_page,
        }

    def list_runs(self, page=1, per_page=20, task_id=None, status=''):
        pagination = self.crud.page_runs(page, per_page, task_id, status)
        return {
            'items': [item.to_dict() for item in pagination.items],
            'total': pagination.total,
            'page': page,
            'per_page': per_page,
        }

    def create_task(self, data):
        name = str(data.get('name') or '').strip()
        task_code = str(data.get('task_code') or '').strip()
        cron_expression = str(data.get('cron_expression') or '').strip()
        request_url = validate_request_url(data.get('request_url'))
        request_method = str(data.get('request_method') or 'GET').strip().upper()

        if not name:
            raise ScheduledTaskServiceError('任务名称不能为空', 400)
        if not task_code:
            raise ScheduledTaskServiceError('任务编码不能为空', 400)
        if not cron_expression:
            raise ScheduledTaskServiceError('Cron 表达式不能为空', 400)
        if not request_url:
            raise ScheduledTaskServiceError('请求地址不能为空', 400)

        if request_method not in {'GET', 'POST', 'PUT', 'DELETE', 'PATCH'}:
            raise ScheduledTaskServiceError('请求方法仅支持 GET/POST/PUT/DELETE/PATCH', 400)

        if self.crud.get_task_by_code(task_code):
            raise ScheduledTaskServiceError('任务编码已存在', 400)

        try:
            parse_cron_expression(cron_expression)
            parse_json_object(data.get('request_headers'), default={})
            is_active = parse_bool(data.get('is_active'), default=True)
            timeout_seconds = max(1, min(parse_int(data.get('timeout_seconds'), default=10), 120))
            next_run_at = compute_next_run_at(cron_expression) if is_active else None
        except ScheduledTaskSchemaError as exc:
            raise ScheduledTaskServiceError(exc.message, 400) from exc

        task = self.ScheduledTask(
            name=name,
            task_code=task_code,
            cron_expression=cron_expression,
            request_method=request_method,
            request_url=request_url,
            request_headers=self._normalize_json_string(data.get('request_headers')),
            request_body=self._normalize_text(data.get('request_body')),
            timeout_seconds=timeout_seconds,
            is_active=is_active,
            remark=self._normalize_text(data.get('remark')),
            last_status='idle',
            next_run_at=next_run_at,
        )

        try:
            self.crud.add(task)
            self.crud.commit()
            return task.to_dict(), 201
        except Exception as exc:
            self.crud.rollback()
            raise ScheduledTaskServiceError(str(exc), 500) from exc

    def update_task(self, task, data):
        if 'name' in data and not str(data.get('name') or '').strip():
            raise ScheduledTaskServiceError('任务名称不能为空', 400)

        if 'task_code' in data:
            next_code = str(data.get('task_code') or '').strip()
            if not next_code:
                raise ScheduledTaskServiceError('任务编码不能为空', 400)
            duplicate = self.crud.get_other_task_by_code(next_code, task.id)
            if duplicate:
                raise ScheduledTaskServiceError('任务编码已存在', 400)

        if 'request_method' in data:
            method = str(data.get('request_method') or '').strip().upper()
            if method not in {'GET', 'POST', 'PUT', 'DELETE', 'PATCH'}:
                raise ScheduledTaskServiceError('请求方法仅支持 GET/POST/PUT/DELETE/PATCH', 400)

        if 'cron_expression' in data:
            try:
                parse_cron_expression(data.get('cron_expression'))
            except ScheduledTaskSchemaError as exc:
                raise ScheduledTaskServiceError(exc.message, 400) from exc

        if 'request_headers' in data:
            try:
                parse_json_object(data.get('request_headers'), default={})
            except ScheduledTaskSchemaError as exc:
                raise ScheduledTaskServiceError(exc.message, 400) from exc

        if 'request_url' in data:
            try:
                validate_request_url(data.get('request_url'))
            except ScheduledTaskSchemaError as exc:
                raise ScheduledTaskServiceError(exc.message, 400) from exc

        update_map = {
            'name': lambda val: str(val or '').strip(),
            'task_code': lambda val: str(val or '').strip(),
            'cron_expression': lambda val: str(val or '').strip(),
            'request_method': lambda val: str(val or '').strip().upper(),
            'request_url': lambda val: str(val or '').strip(),
            'request_headers': lambda val: self._normalize_json_string(val),
            'request_body': lambda val: self._normalize_text(val),
            'timeout_seconds': lambda val: max(1, min(parse_int(val, default=task.timeout_seconds or 10), 120)),
            'is_active': lambda val: parse_bool(val, default=task.is_active),
            'remark': lambda val: self._normalize_text(val),
        }

        for field, converter in update_map.items():
            if field in data:
                setattr(task, field, converter(data.get(field)))

        try:
            task.next_run_at = compute_next_run_at(task.cron_expression) if task.is_active else None
        except ScheduledTaskSchemaError as exc:
            raise ScheduledTaskServiceError(exc.message, 400) from exc

        try:
            self.crud.commit()
            return task.to_dict()
        except Exception as exc:
            self.crud.rollback()
            raise ScheduledTaskServiceError(str(exc), 500) from exc

    def delete_task(self, task):
        if is_enabled_for_delete(task):
            raise ScheduledTaskServiceError(enabled_delete_message('定时任务'), 409)
        try:
            self.crud.delete(task)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as exc:
            self.crud.rollback()
            raise ScheduledTaskServiceError(str(exc), 500) from exc

    def run_task_now(self, task):
        try:
            payload = self.execute_task(task, trigger_type='manual')
            return payload
        except ScheduledTaskServiceError:
            raise
        except Exception as exc:
            raise ScheduledTaskServiceError(str(exc), 500) from exc

    def execute_task(self, task, trigger_type='scheduled'):
        started_at = datetime.utcnow()
        response_status = None
        response_body = None
        error_message = None
        status = 'success'

        method = str(task.request_method or 'GET').upper()
        headers = self._parse_headers(task.request_headers)
        request_kwargs = {
            'headers': headers,
            'timeout': max(1, min(int(task.timeout_seconds or 10), 120)),
        }

        request_body = str(task.request_body or '').strip()
        if request_body:
            try:
                parsed = json.loads(request_body)
            except json.JSONDecodeError:
                parsed = request_body

            if isinstance(parsed, (dict, list)):
                request_kwargs['json'] = parsed
            else:
                request_kwargs['data'] = str(parsed)

        try:
            # 保存时与执行前均校验，且禁止自动跟随重定向，避免任务经 30x 绕到内网。
            request_url = validate_request_url(task.request_url)
            response = requests.request(method, request_url, allow_redirects=False, **request_kwargs)
            response_status = response.status_code
            response_body = (response.text or '')[:2000]
            if response.status_code >= 400:
                raise RuntimeError(f'HTTP {response.status_code}')
        except Exception as exc:
            status = 'failed'
            error_message = str(exc)

        finished_at = datetime.utcnow()
        duration_ms = int((finished_at - started_at).total_seconds() * 1000)

        next_run_at = None
        if task.is_active:
            try:
                next_run_at = compute_next_run_at(task.cron_expression, base_time=finished_at)
            except ScheduledTaskSchemaError as exc:
                status = 'failed'
                error_message = exc.message

        run = self.ScheduledTaskRun(
            task_id=task.id,
            trigger_type=trigger_type,
            status=status,
            response_status=response_status,
            response_body=response_body,
            error_message=error_message,
            started_at=started_at,
            finished_at=finished_at,
            duration_ms=duration_ms,
        )

        task.last_status = status
        task.last_error = error_message
        task.last_duration_ms = duration_ms
        task.last_run_at = finished_at
        task.next_run_at = next_run_at
        task.run_count = (task.run_count or 0) + 1

        try:
            self.crud.add(run)
            self.crud.commit()
        except Exception as exc:
            self.crud.rollback()
            raise ScheduledTaskServiceError(str(exc), 500) from exc

        result = {
            'message': '执行成功' if status == 'success' else '执行失败',
            'task': task.to_dict(),
            'run': run.to_dict(),
        }
        if status != 'success':
            result['error'] = error_message or '执行失败'
        return result

    def _parse_headers(self, raw_headers):
        if not raw_headers:
            return {}
        try:
            parsed = json.loads(raw_headers)
        except json.JSONDecodeError:
            raise ScheduledTaskServiceError('请求头 JSON 解析失败', 400)
        if not isinstance(parsed, dict):
            raise ScheduledTaskServiceError('请求头必须是 JSON 对象', 400)
        return {str(k): str(v) for k, v in parsed.items()}

    @staticmethod
    def _normalize_json_string(value):
        if value is None:
            return None
        if isinstance(value, dict):
            return json.dumps(value, ensure_ascii=False)
        text = str(value).strip()
        if not text:
            return None
        parsed = parse_json_object(text, default={})
        return json.dumps(parsed, ensure_ascii=False)

    @staticmethod
    def _normalize_text(value):
        text = str(value or '').strip()
        return text or None
