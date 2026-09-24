# -*- coding: utf-8 -*-
"""日志模块 service 层"""

from datetime import datetime

from backend.common.request_meta import get_client_ip, get_user_agent, safe_payload
from backend.common.tabular import build_table_response, normalize_table_file_type, read_table_file

from backend.app.admin.crud.logs import LogsCRUD
from backend.app.admin.schema.logs import (
    LOGIN_EXPORT_FIELD_MAP,
    LOGIN_IMPORT_HEADER_MAP,
    OPERATION_EXPORT_FIELD_MAP,
    OPERATION_IMPORT_HEADER_MAP,
    build_error_row,
    parse_datetime,
    parse_int,
    resolve_module_and_action,
)


class LogsServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class LogsService:
    def __init__(self, db, admin_model, login_log_model, operation_log_model):
        self.db = db
        self.Admin = admin_model
        self.LoginLog = login_log_model
        self.OperationLog = operation_log_model
        self.crud = LogsCRUD(db, admin_model, login_log_model, operation_log_model)

    def record_operation_from_request(self, request_obj, response, username):
        if request_obj.method not in ['POST', 'PUT', 'DELETE']:
            return
        if not request_obj.path.startswith('/api/admin/'):
            return
        if request_obj.path.startswith('/api/admin/logs'):
            return
        if request_obj.path == '/api/admin/login':
            return
        if not username:
            return

        user = self.crud.get_admin_by_username(username)
        if not user:
            return

        module, action = resolve_module_and_action(request_obj.path, request_obj.method)

        path_segments = [seg for seg in request_obj.path.strip('/').split('/') if seg]
        target_id = None
        if path_segments and path_segments[-1].isdigit():
            target_id = path_segments[-1]

        item = self.OperationLog(
            username=username,
            user_id=user.id,
            module=module,
            action=action,
            method=request_obj.method,
            path=request_obj.path,
            target_id=target_id,
            payload=safe_payload(request_obj.get_json(silent=True)),
            ip=get_client_ip(),
            user_agent=get_user_agent(),
            status_code=response.status_code,
        )
        try:
            self.crud.add(item)
            self.crud.commit()
        except Exception:
            self.crud.rollback()

    def list_login_logs(self, page=1, per_page=20, username='', status=''):
        query = self.crud.query_login_logs()
        if username:
            query = query.filter(self.LoginLog.username.ilike(f'%{username}%'))
        if status:
            query = query.filter(self.LoginLog.status == status)

        pagination = query.order_by(self.LoginLog.id.desc()).paginate(
            page=page,
            per_page=per_page,
            error_out=False,
        )
        return {
            'items': [item.to_dict() for item in pagination.items],
            'total': pagination.total,
            'page': page,
            'per_page': per_page,
        }

    def list_operation_logs(self, page=1, per_page=20, username='', module='', action=''):
        query = self.crud.query_operation_logs()
        if username:
            query = query.filter(self.OperationLog.username.ilike(f'%{username}%'))
        if module:
            query = query.filter(self.OperationLog.module == module)
        if action:
            query = query.filter(self.OperationLog.action == action)

        pagination = query.order_by(self.OperationLog.id.desc()).paginate(
            page=page,
            per_page=per_page,
            error_out=False,
        )
        return {
            'items': [item.to_dict() for item in pagination.items],
            'total': pagination.total,
            'page': page,
            'per_page': per_page,
        }

    def export_login_logs(self, data):
        ids = data.get('ids') or []
        fields = data.get('fields') or []
        export_mode = (data.get('export_mode') or 'selected').strip()
        filters = data.get('filters') or {}
        file_type = normalize_table_file_type(data.get('file_type'), default='csv')

        valid_fields = [field for field in fields if field in LOGIN_EXPORT_FIELD_MAP]
        if not valid_fields:
            valid_fields = list(LOGIN_EXPORT_FIELD_MAP.keys())

        if export_mode == 'filtered':
            query = self.crud.query_login_logs()
            username = str(filters.get('username') or '').strip()
            status = str(filters.get('status') or '').strip()
            if username:
                query = query.filter(self.LoginLog.username.ilike(f'%{username}%'))
            if status:
                query = query.filter(self.LoginLog.status == status)
            items = query.order_by(self.LoginLog.id.asc()).all()
        else:
            if not isinstance(ids, list) or not ids:
                raise LogsServiceError('请先勾选要导出的日志数据', 400)
            items = self.crud.list_login_logs_by_ids(ids).order_by(self.LoginLog.id.asc()).all()

        headers = [LOGIN_EXPORT_FIELD_MAP[field][0] for field in valid_fields]
        rows = [[LOGIN_EXPORT_FIELD_MAP[field][1](item) for field in valid_fields] for item in items]
        try:
            return build_table_response(headers, rows, 'login_logs_export', file_type=file_type)
        except RuntimeError as e:
            raise LogsServiceError(str(e), 500) from e

    def download_login_template(self, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='csv')
        headers = ['用户名', '状态', 'IP 地址', 'User-Agent', '说明', '时间']
        rows = [['demo_user', 'success', '127.0.0.1', 'Mozilla/5.0', '导入示例', '2026-01-01 10:00:00']]
        try:
            return build_table_response(headers, rows, 'login_logs_import_template', file_type=file_type)
        except RuntimeError as e:
            raise LogsServiceError(str(e), 500) from e

    def import_login_logs(self, file_storage):
        if not file_storage:
            raise LogsServiceError('请上传导入文件', 400)

        try:
            fieldnames, rows_with_line, _ = read_table_file(file_storage)
        except ValueError as e:
            raise LogsServiceError(str(e), 400) from e
        except RuntimeError as e:
            raise LogsServiceError(str(e), 500) from e

        if not fieldnames:
            raise LogsServiceError('导入内容为空', 400)

        row_header_map = {}
        for header in fieldnames:
            key = (header or '').strip()
            if key in LOGIN_IMPORT_HEADER_MAP:
                row_header_map[header] = LOGIN_IMPORT_HEADER_MAP[key]

        if 'username' not in row_header_map.values():
            raise LogsServiceError('导入文件缺少“用户名”列', 400)

        created = 0
        errors = []

        try:
            for line, row in rows_with_line:
                mapped = {}
                for key, value in row.items():
                    field = row_header_map.get(key)
                    if field:
                        mapped[field] = value

                username = str(mapped.get('username') or '').strip()
                if not username:
                    errors.append(build_error_row(line, '用户名不能为空', row))
                    continue

                raw_status = str(mapped.get('status') or '').strip().lower()
                status = 'success'
                if raw_status in {'failed', 'fail', '失败'}:
                    status = 'failed'

                user = self.crud.get_admin_by_username(username)
                item = self.LoginLog(
                    username=username,
                    user_id=user.id if user else None,
                    status=status,
                    ip=str(mapped.get('ip') or '').strip() or None,
                    user_agent=str(mapped.get('user_agent') or '').strip() or None,
                    message=str(mapped.get('message') or '').strip() or None,
                    created_at=parse_datetime(mapped.get('created_at'), default=datetime.utcnow()) or datetime.utcnow(),
                )
                self.crud.add(item)
                created += 1

            if errors:
                self.crud.rollback()
                raise LogsServiceError('导入失败，存在错误数据', 400, {
                    'error_rows': errors[:500],
                    'error_count': len(errors),
                })

            self.crud.commit()
            return {'message': '导入成功', 'created': created, 'updated': 0}
        except LogsServiceError:
            raise
        except Exception as e:
            self.crud.rollback()
            raise LogsServiceError(str(e), 500) from e

    def export_operation_logs(self, data):
        ids = data.get('ids') or []
        fields = data.get('fields') or []
        export_mode = (data.get('export_mode') or 'selected').strip()
        filters = data.get('filters') or {}
        file_type = normalize_table_file_type(data.get('file_type'), default='csv')

        valid_fields = [field for field in fields if field in OPERATION_EXPORT_FIELD_MAP]
        if not valid_fields:
            valid_fields = list(OPERATION_EXPORT_FIELD_MAP.keys())

        if export_mode == 'filtered':
            query = self.crud.query_operation_logs()
            username = str(filters.get('username') or '').strip()
            module = str(filters.get('module') or '').strip()
            action = str(filters.get('action') or '').strip()
            if username:
                query = query.filter(self.OperationLog.username.ilike(f'%{username}%'))
            if module:
                query = query.filter(self.OperationLog.module == module)
            if action:
                query = query.filter(self.OperationLog.action == action)
            items = query.order_by(self.OperationLog.id.asc()).all()
        else:
            if not isinstance(ids, list) or not ids:
                raise LogsServiceError('请先勾选要导出的日志数据', 400)
            items = self.crud.list_operation_logs_by_ids(ids).order_by(self.OperationLog.id.asc()).all()

        headers = [OPERATION_EXPORT_FIELD_MAP[field][0] for field in valid_fields]
        rows = [[OPERATION_EXPORT_FIELD_MAP[field][1](item) for field in valid_fields] for item in items]
        try:
            return build_table_response(headers, rows, 'operation_logs_export', file_type=file_type)
        except RuntimeError as e:
            raise LogsServiceError(str(e), 500) from e

    def download_operation_template(self, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='csv')
        headers = ['用户名', '模块', '操作', '方法', '路径', '目标ID', '状态码', 'IP 地址', 'User-Agent', '请求体', '时间']
        rows = [['demo_user', 'users', 'create', 'POST', '/api/admin/users', '', '200', '127.0.0.1', 'Mozilla/5.0', '{"username":"demo"}', '2026-01-01 10:00:00']]
        try:
            return build_table_response(headers, rows, 'operation_logs_import_template', file_type=file_type)
        except RuntimeError as e:
            raise LogsServiceError(str(e), 500) from e

    def import_operation_logs(self, file_storage):
        if not file_storage:
            raise LogsServiceError('请上传导入文件', 400)

        try:
            fieldnames, rows_with_line, _ = read_table_file(file_storage)
        except ValueError as e:
            raise LogsServiceError(str(e), 400) from e
        except RuntimeError as e:
            raise LogsServiceError(str(e), 500) from e

        if not fieldnames:
            raise LogsServiceError('导入内容为空', 400)

        row_header_map = {}
        for header in fieldnames:
            key = (header or '').strip()
            if key in OPERATION_IMPORT_HEADER_MAP:
                row_header_map[header] = OPERATION_IMPORT_HEADER_MAP[key]

        for required_field in ['username', 'module', 'action', 'method', 'path']:
            if required_field not in row_header_map.values():
                raise LogsServiceError(f'导入文件缺少必填列: {required_field}', 400)

        created = 0
        errors = []

        try:
            for line, row in rows_with_line:
                mapped = {}
                for key, value in row.items():
                    field = row_header_map.get(key)
                    if field:
                        mapped[field] = value

                username = str(mapped.get('username') or '').strip()
                module = str(mapped.get('module') or '').strip()
                action = str(mapped.get('action') or '').strip()
                method = str(mapped.get('method') or '').strip().upper()
                path = str(mapped.get('path') or '').strip()

                if not username or not module or not action or not method or not path:
                    errors.append(build_error_row(line, '必填字段不能为空', row))
                    continue

                user = self.crud.get_admin_by_username(username)
                item = self.OperationLog(
                    username=username,
                    user_id=user.id if user else None,
                    module=module,
                    action=action,
                    method=method,
                    path=path,
                    target_id=str(mapped.get('target_id') or '').strip() or None,
                    payload=str(mapped.get('payload') or '').strip() or None,
                    ip=str(mapped.get('ip') or '').strip() or None,
                    user_agent=str(mapped.get('user_agent') or '').strip() or None,
                    status_code=parse_int(mapped.get('status_code'), default=200),
                    created_at=parse_datetime(mapped.get('created_at'), default=datetime.utcnow()) or datetime.utcnow(),
                )
                self.crud.add(item)
                created += 1

            if errors:
                self.crud.rollback()
                raise LogsServiceError('导入失败，存在错误数据', 400, {
                    'error_rows': errors[:500],
                    'error_count': len(errors),
                })

            self.crud.commit()
            return {'message': '导入成功', 'created': created, 'updated': 0}
        except LogsServiceError:
            raise
        except Exception as e:
            self.crud.rollback()
            raise LogsServiceError(str(e), 500) from e
