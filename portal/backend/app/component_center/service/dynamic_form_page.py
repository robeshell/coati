# -*- coding: utf-8 -*-
"""动态表单页 service 层"""

from backend.app.component_center.crud.dynamic_form_page import DynamicFormPageCRUD
from backend.app.component_center.schema.dynamic_form_page import (
    EXPORT_FIELD_MAP,
    IMPORT_HEADER_MAP,
    STATUS_VALUES,
    build_error_row,
    parse_bool,
    parse_int,
)
from backend.common.tabular import build_table_response, normalize_table_file_type, read_table_file
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete


class DynamicFormPageServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class DynamicFormPageService:
    def __init__(self, db, record_model, field_model):
        self.db = db
        self.DynamicFormRecord = record_model
        self.DynamicFormField = field_model
        self.crud = DynamicFormPageCRUD(db, record_model, field_model)

    @staticmethod
    def normalize_status(value, default='draft'):
        if value is None:
            return default
        raw = str(value).strip().lower()
        if not raw:
            return default
        if raw not in STATUS_VALUES:
            raise DynamicFormPageServiceError('状态仅支持 draft/published/archived', 400)
        return raw

    def _build_list_query(self, search='', category='', status='', owner='', is_active=None):
        query = self.crud.query()
        if search:
            query = query.filter(self.db.or_(
                self.DynamicFormRecord.title.ilike(f'%{search}%'),
                self.DynamicFormRecord.record_code.ilike(f'%{search}%'),
                self.DynamicFormRecord.owner.ilike(f'%{search}%'),
            ))
        if category:
            query = query.filter(self.DynamicFormRecord.category == category)
        if status:
            query = query.filter(self.DynamicFormRecord.status == status)
        if owner:
            query = query.filter(self.DynamicFormRecord.owner.ilike(f'%{owner}%'))
        if is_active is not None:
            query = query.filter(self.DynamicFormRecord.is_active == is_active)
        return query

    def list_items(self, page=1, per_page=20, search='', category='', status='', owner='', is_active=None):
        query = self._build_list_query(search=search, category=category, status=status, owner=owner, is_active=is_active)
        pagination = query.order_by(
            self.DynamicFormRecord.priority.desc(),
            self.DynamicFormRecord.id.desc(),
        ).paginate(page=page, per_page=per_page, error_out=False)
        return {
            'items': [item.to_dict(include_fields=False) for item in pagination.items],
            'total': pagination.total,
            'page': page,
            'per_page': per_page,
        }

    def _upsert_fields(self, record, fields_data):
        """全量替换 record 的动态字段"""
        self.crud.delete_fields_by_record(record.id)
        for idx, f in enumerate(fields_data or []):
            field_key = str(f.get('field_key') or '').strip()
            if not field_key:
                continue
            field_obj = self.DynamicFormField(
                record_id=record.id,
                field_key=field_key,
                field_value=str(f.get('field_value') or '').strip() or None,
                field_type=str(f.get('field_type') or 'text').strip() or 'text',
                sort_order=parse_int(f.get('sort_order'), default=idx),
                remark=str(f.get('remark') or '').strip() or None,
            )
            self.db.session.add(field_obj)

    def create_item(self, data):
        title = str(data.get('title') or '').strip()
        record_code = str(data.get('record_code') or '').strip()
        if not title:
            raise DynamicFormPageServiceError('标题不能为空', 400)
        if not record_code:
            raise DynamicFormPageServiceError('记录编码不能为空', 400)
        if self.crud.get_by_code(record_code):
            raise DynamicFormPageServiceError('记录编码已存在', 400)

        fields_data = data.get('fields') or []
        if len(fields_data) > 20:
            raise DynamicFormPageServiceError('动态字段最多支持 20 条', 400)

        status = self.normalize_status(data.get('status'), default='draft')
        record = self.DynamicFormRecord(
            title=title,
            record_code=record_code,
            category=str(data.get('category') or 'general').strip() or 'general',
            status=status,
            owner=str(data.get('owner') or '').strip() or None,
            priority=parse_int(data.get('priority'), default=0),
            is_active=parse_bool(data.get('is_active'), default=True),
            description=str(data.get('description') or '').strip() or None,
        )
        try:
            self.crud.add(record)
            self.db.session.flush()  # get record.id
            self._upsert_fields(record, fields_data)
            self.crud.commit()
            return record.to_dict(include_fields=True), 201
        except DynamicFormPageServiceError:
            self.crud.rollback()
            raise
        except Exception as e:
            self.crud.rollback()
            raise DynamicFormPageServiceError(str(e), 500) from e

    def update_item(self, record, data):
        if 'title' in data and not str(data.get('title') or '').strip():
            raise DynamicFormPageServiceError('标题不能为空', 400)

        fields_data = data.get('fields')
        if fields_data is not None and len(fields_data) > 20:
            raise DynamicFormPageServiceError('动态字段最多支持 20 条', 400)

        update_map = {
            'title': lambda val: str(val or '').strip(),
            'category': lambda val: str(val or '').strip() or 'general',
            'owner': lambda val: str(val or '').strip() or None,
            'priority': lambda val: parse_int(val, default=record.priority or 0),
            'is_active': lambda val: parse_bool(val, default=record.is_active),
            'description': lambda val: str(val or '').strip() or None,
        }
        for field, converter in update_map.items():
            if field in data:
                setattr(record, field, converter(data.get(field)))

        if 'status' in data:
            record.status = self.normalize_status(data.get('status'), default=record.status or 'draft')

        try:
            if fields_data is not None:
                self._upsert_fields(record, fields_data)
            self.crud.commit()
            return record.to_dict(include_fields=True)
        except DynamicFormPageServiceError:
            self.crud.rollback()
            raise
        except Exception as e:
            self.crud.rollback()
            raise DynamicFormPageServiceError(str(e), 500) from e

    def delete_item(self, record):
        if is_enabled_for_delete(record):
            raise DynamicFormPageServiceError(enabled_delete_message('记录'), 409)
        try:
            self.crud.delete(record)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise DynamicFormPageServiceError(str(e), 500) from e

    def export_items(self, data, request_method='POST'):
        if request_method == 'GET':
            ids = []
            fields_raw = str(data.get('fields') or '').strip()
            fields = [f.strip() for f in fields_raw.split(',') if f.strip()] if fields_raw else []
            export_mode = 'filtered'
            filters = {
                'search': data.get('search'),
                'category': data.get('category'),
                'status': data.get('status'),
                'owner': data.get('owner'),
                'is_active': data.get('is_active'),
            }
            file_type = normalize_table_file_type(data.get('file_type'), default='csv')
        else:
            ids = data.get('ids') or []
            fields = data.get('fields') or []
            export_mode = str(data.get('export_mode') or 'selected').strip()
            filters = data.get('filters') or {}
            file_type = normalize_table_file_type(data.get('file_type'), default='csv')

        valid_fields = [f for f in fields if f in EXPORT_FIELD_MAP]
        if not valid_fields:
            valid_fields = list(EXPORT_FIELD_MAP.keys())

        if export_mode == 'filtered':
            query = self._build_list_query(
                search=str(filters.get('search') or '').strip(),
                category=str(filters.get('category') or '').strip(),
                status=str(filters.get('status') or '').strip(),
                owner=str(filters.get('owner') or '').strip(),
                is_active=parse_bool(filters.get('is_active')),
            )
            items = query.order_by(self.DynamicFormRecord.id.asc()).all()
        else:
            if not isinstance(ids, list) or not ids:
                raise DynamicFormPageServiceError('请先勾选要导出的数据', 400)
            items = self.crud.list_by_ids(ids).order_by(self.DynamicFormRecord.id.asc()).all()

        headers = [EXPORT_FIELD_MAP[f][0] for f in valid_fields]
        rows = [[EXPORT_FIELD_MAP[f][1](item) for f in valid_fields] for item in items]
        try:
            return build_table_response(headers, rows, 'dynamic_form_page_export', file_type=file_type)
        except RuntimeError as e:
            raise DynamicFormPageServiceError(str(e), 500) from e

    def download_template(self, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='csv')
        headers = ['标题', '记录编码', '分类', '发布状态', '负责人', '优先级', '启用', '描述']
        rows = [['示例表单A', 'form_001', 'general', 'draft', 'admin', 0, '启用', '示例描述']]
        try:
            return build_table_response(headers, rows, 'dynamic_form_page_import_template', file_type=file_type)
        except RuntimeError as e:
            raise DynamicFormPageServiceError(str(e), 500) from e

    def import_items(self, file_storage):
        if not file_storage:
            raise DynamicFormPageServiceError('请上传导入文件', 400)
        try:
            fieldnames, rows_with_line, _ = read_table_file(file_storage)
        except ValueError as e:
            raise DynamicFormPageServiceError(str(e), 400) from e
        except RuntimeError as e:
            raise DynamicFormPageServiceError(str(e), 500) from e

        if not fieldnames:
            raise DynamicFormPageServiceError('导入内容为空', 400)

        row_header_map = {}
        for header in fieldnames:
            key = (header or '').strip()
            if key in IMPORT_HEADER_MAP:
                row_header_map[header] = IMPORT_HEADER_MAP[key]

        if 'title' not in row_header_map.values() or 'record_code' not in row_header_map.values():
            raise DynamicFormPageServiceError('导入文件缺少"标题/记录编码"列', 400)

        created = 0
        updated = 0
        errors = []

        try:
            for line, row in rows_with_line:
                mapped = {}
                for key, value in row.items():
                    field = row_header_map.get(key)
                    if field:
                        mapped[field] = value

                title = str(mapped.get('title') or '').strip()
                record_code = str(mapped.get('record_code') or '').strip()
                if not title or not record_code:
                    errors.append(build_error_row(line, '标题和记录编码不能为空', row))
                    continue

                category = str(mapped.get('category') or 'general').strip() or 'general'
                status = self.normalize_status(mapped.get('status'), default='draft')
                owner = str(mapped.get('owner') or '').strip() or None
                priority = parse_int(mapped.get('priority'), default=0)
                is_active = parse_bool(mapped.get('is_active'), default=True)
                description = str(mapped.get('description') or '').strip() or None

                record = self.crud.get_by_code(record_code)
                if record:
                    record.title = title
                    record.category = category
                    record.status = status
                    record.owner = owner
                    record.priority = priority
                    record.is_active = is_active
                    record.description = description
                    updated += 1
                else:
                    record = self.DynamicFormRecord(
                        title=title,
                        record_code=record_code,
                        category=category,
                        status=status,
                        owner=owner,
                        priority=priority,
                        is_active=is_active,
                        description=description,
                    )
                    self.crud.add(record)
                    created += 1

            if errors:
                self.crud.rollback()
                raise DynamicFormPageServiceError('导入失败，存在错误数据', 400, {
                    'error_rows': errors[:500],
                    'error_count': len(errors),
                })

            self.crud.commit()
            return {'message': '导入成功', 'created': created, 'updated': updated}
        except DynamicFormPageServiceError:
            raise
        except Exception as e:
            self.crud.rollback()
            raise DynamicFormPageServiceError(str(e), 500) from e
