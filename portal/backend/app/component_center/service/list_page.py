# -*- coding: utf-8 -*-
"""列表页 service 层"""

import json
import os
import uuid
from datetime import datetime

from flask import current_app
from werkzeug.utils import secure_filename

from backend.common.tabular import build_table_response, normalize_table_file_type, read_table_file
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete

from backend.app.component_center.crud.list_page import ListPageCRUD
from backend.app.component_center.schema.list_page import EXPORT_FIELD_MAP, IMPORT_HEADER_MAP, build_error_row, parse_bool, parse_int

ALLOWED_IMAGE_EXTENSIONS = {'jpg', 'jpeg', 'png', 'gif', 'webp'}
MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024
ALLOWED_FILE_EXTENSIONS = {
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'md',
    'zip', 'rar', '7z', 'json', 'ppt', 'pptx',
}
MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024
STATUS_VALUES = {'draft', 'published'}


class ListPageServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class ListPageService:
    def __init__(self, db, query_model, version_model):
        self.db = db
        self.QueryManagement = query_model
        self.QueryManagementVersion = version_model
        self.crud = ListPageCRUD(db, query_model, version_model)

    def get_image_upload_dir(self):
        upload_dir = os.path.join(current_app.root_path, 'instance', 'uploads', 'list_page')
        os.makedirs(upload_dir, exist_ok=True)
        return upload_dir

    def get_file_upload_dir(self):
        upload_dir = os.path.join(current_app.root_path, 'instance', 'uploads', 'list_page_files')
        os.makedirs(upload_dir, exist_ok=True)
        return upload_dir

    @staticmethod
    def sanitize_image_filename(filename):
        raw_name = str(filename or '').strip()
        safe_name = secure_filename(raw_name)
        if not safe_name:
            raise ListPageServiceError('无效的图片文件名', 400)
        return safe_name

    @staticmethod
    def _extract_image_ext(filename):
        safe_name = ListPageService.sanitize_image_filename(filename)
        if '.' not in safe_name:
            raise ListPageServiceError('仅支持 jpg/png/gif/webp 图片', 400)
        ext = safe_name.rsplit('.', 1)[1].lower()
        if ext not in ALLOWED_IMAGE_EXTENSIONS:
            raise ListPageServiceError('仅支持 jpg/png/gif/webp 图片', 400)
        return ext

    @staticmethod
    def parse_json_object(raw_value, default_value):
        if raw_value is None:
            return default_value
        if isinstance(raw_value, dict):
            return raw_value
        if isinstance(raw_value, str):
            text = raw_value.strip()
            if not text:
                return default_value
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                return default_value
        return default_value

    @staticmethod
    def serialize_json_object(value, default_value=None):
        if value is None:
            if default_value is None:
                return None
            return json.dumps(default_value, ensure_ascii=False)
        if isinstance(value, dict):
            return json.dumps(value, ensure_ascii=False)
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            try:
                parsed = json.loads(text)
            except Exception:
                raise ListPageServiceError('JSON 配置格式错误', 400)
            if not isinstance(parsed, dict):
                raise ListPageServiceError('JSON 配置必须是对象', 400)
            return json.dumps(parsed, ensure_ascii=False)
        raise ListPageServiceError('JSON 配置格式错误', 400)

    @staticmethod
    def parse_schema_config(raw_value):
        if raw_value is None:
            return ''
        if isinstance(raw_value, str):
            return raw_value.strip()
        if isinstance(raw_value, dict):
            return json.dumps(raw_value, ensure_ascii=False, indent=2)
        return str(raw_value).strip()

    @staticmethod
    def normalize_status(value, default='draft'):
        if value is None:
            return default
        raw = str(value).strip().lower()
        if not raw:
            return default
        if raw not in STATUS_VALUES:
            raise ListPageServiceError('状态仅支持 draft/published', 400)
        return raw

    @staticmethod
    def normalize_image_urls(raw_value):
        if raw_value is None:
            return []
        if isinstance(raw_value, list):
            return [str(item).strip() for item in raw_value if str(item).strip()]
        if isinstance(raw_value, str):
            text = raw_value.strip()
            if not text:
                return []
            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    return [str(item).strip() for item in parsed if str(item).strip()]
            except Exception:
                pass
            if any(sep in text for sep in ['\n', ',', '，', ';', '；']):
                normalized = text.replace('，', ',').replace('；', ';').replace('\n', ';')
                chunks = []
                for segment in normalized.split(';'):
                    chunks.extend(segment.split(','))
                return [item.strip() for item in chunks if item.strip()]
            return [text]
        return []

    @staticmethod
    def normalize_file_urls(raw_value):
        return ListPageService.normalize_image_urls(raw_value)

    @staticmethod
    def serialize_url_list(urls):
        return json.dumps(urls, ensure_ascii=False) if urls else None

    @staticmethod
    def normalize_conditions(raw_conditions):
        if raw_conditions is None:
            return {'groups': [], 'items': []}
        if isinstance(raw_conditions, str):
            text = raw_conditions.strip()
            if not text:
                return {'groups': [], 'items': []}
            try:
                raw_conditions = json.loads(text)
            except Exception:
                raise ListPageServiceError('条件配置 JSON 格式错误', 400)
        if not isinstance(raw_conditions, dict):
            raise ListPageServiceError('条件配置必须是对象', 400)

        groups = raw_conditions.get('groups')
        items = raw_conditions.get('items')
        if not isinstance(groups, list):
            groups = []
        if not isinstance(items, list):
            items = []

        normalized_items = []
        for item in items:
            if not isinstance(item, dict):
                continue
            field = str(item.get('field') or '').strip()
            operator = str(item.get('operator') or '').strip()
            value = item.get('value')
            logic = str(item.get('logic') or 'AND').strip().upper()
            if logic not in {'AND', 'OR'}:
                logic = 'AND'
            if not field or not operator:
                continue
            normalized_items.append({
                'field': field,
                'operator': operator,
                'value': '' if value is None else value,
                'logic': logic,
            })

        normalized_groups = []
        for group in groups:
            if not isinstance(group, dict):
                continue
            name = str(group.get('name') or '').strip() or f'分组{len(normalized_groups) + 1}'
            logic = str(group.get('logic') or 'AND').strip().upper()
            if logic not in {'AND', 'OR'}:
                logic = 'AND'
            normalized_groups.append({'name': name, 'logic': logic})

        return {
            'groups': normalized_groups,
            'items': normalized_items,
        }

    @staticmethod
    def _sanitize_preview_value(value):
        if value is None:
            return '-'
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    def _build_snapshot(self, item):
        payload = item.to_dict()
        for key in ['created_at', 'updated_at']:
            payload.pop(key, None)
        return payload

    def _save_version_snapshot(self, item, action='save', operator='system'):
        version_item = self.QueryManagementVersion(
            query_management_id=item.id,
            version_no=item.version or 1,
            action=action,
            operator=operator,
            snapshot_json=json.dumps(self._build_snapshot(item), ensure_ascii=False),
        )
        self.crud.add_version(version_item)

    def save_image(self, file_storage):
        if not file_storage:
            raise ListPageServiceError('请先选择图片文件', 400)

        ext = self._extract_image_ext(file_storage.filename)

        file_storage.stream.seek(0, os.SEEK_END)
        file_size = file_storage.stream.tell()
        file_storage.stream.seek(0)

        if file_size <= 0:
            raise ListPageServiceError('图片文件不能为空', 400)
        if file_size > MAX_IMAGE_SIZE_BYTES:
            raise ListPageServiceError('图片不能超过 5MB', 400)

        final_name = f'{uuid.uuid4().hex}.{ext}'
        save_path = os.path.join(self.get_image_upload_dir(), final_name)

        try:
            file_storage.save(save_path)
            return {
                'message': '上传成功',
                'filename': final_name,
                'url': f'/api/admin/component-center/list-page/image/{final_name}',
            }
        except Exception as e:
            raise ListPageServiceError(str(e), 500) from e

    def save_file(self, file_storage):
        if not file_storage:
            raise ListPageServiceError('请先选择文件', 400)

        safe_name = self.sanitize_image_filename(file_storage.filename)
        if '.' not in safe_name:
            raise ListPageServiceError('无效的文件类型', 400)
        ext = safe_name.rsplit('.', 1)[1].lower()
        if ext not in ALLOWED_FILE_EXTENSIONS:
            raise ListPageServiceError('仅支持常见文档/压缩包格式', 400)

        file_storage.stream.seek(0, os.SEEK_END)
        file_size = file_storage.stream.tell()
        file_storage.stream.seek(0)

        if file_size <= 0:
            raise ListPageServiceError('文件不能为空', 400)
        if file_size > MAX_FILE_SIZE_BYTES:
            raise ListPageServiceError('文件不能超过 20MB', 400)

        final_name = f'{uuid.uuid4().hex}_{safe_name}'
        save_path = os.path.join(self.get_file_upload_dir(), final_name)

        try:
            file_storage.save(save_path)
            return {
                'message': '上传成功',
                'filename': final_name,
                'url': f'/api/admin/component-center/list-page/file/{final_name}',
            }
        except Exception as e:
            raise ListPageServiceError(str(e), 500) from e

    def list_items(self, page=1, per_page=20, search='', category='', owner='', is_active=None, status=''):
        query = self.crud.query()
        if search:
            query = query.filter(self.db.or_(
                self.QueryManagement.name.ilike(f'%{search}%'),
                self.QueryManagement.query_code.ilike(f'%{search}%'),
                self.QueryManagement.keyword.ilike(f'%{search}%'),
                self.QueryManagement.data_source.ilike(f'%{search}%'),
                self.QueryManagement.owner.ilike(f'%{search}%'),
            ))
        if category:
            query = query.filter(self.QueryManagement.category == category)
        if owner:
            query = query.filter(self.QueryManagement.owner.ilike(f'%{owner}%'))
        if is_active is not None:
            query = query.filter(self.QueryManagement.is_active == is_active)
        if status:
            query = query.filter(self.QueryManagement.status == status)

        pagination = query.order_by(self.QueryManagement.priority.desc(), self.QueryManagement.id.desc()).paginate(
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

    def create_item(self, data):
        name = str(data.get('name') or '').strip()
        query_code = str(data.get('query_code') or '').strip()
        if not name:
            raise ListPageServiceError('查询名称不能为空', 400)
        if not query_code:
            raise ListPageServiceError('查询编码不能为空', 400)
        if self.crud.get_by_code(query_code):
            raise ListPageServiceError('查询编码已存在', 400)

        status = self.normalize_status(data.get('status'), default='draft')
        condition_logic = str(data.get('condition_logic') or 'AND').strip().upper()
        if condition_logic not in {'AND', 'OR'}:
            condition_logic = 'AND'
        conditions = self.normalize_conditions(data.get('conditions'))

        image_urls = self.normalize_image_urls(data.get('image_urls'))
        if not image_urls:
            image_urls = self.normalize_image_urls(data.get('image_url'))
        file_urls = self.normalize_file_urls(data.get('file_urls'))
        if not file_urls:
            file_urls = self.normalize_file_urls(data.get('file_url'))

        item = self.QueryManagement(
            name=name,
            query_code=query_code,
            category=str(data.get('category') or 'general').strip() or 'general',
            keyword=str(data.get('keyword') or '').strip() or None,
            data_source=str(data.get('data_source') or '').strip() or None,
            owner=str(data.get('owner') or '').strip() or None,
            image_url=image_urls[0] if image_urls else None,
            image_urls=self.serialize_url_list(image_urls),
            file_url=file_urls[0] if file_urls else None,
            file_urls=self.serialize_url_list(file_urls),
            priority=parse_int(data.get('priority'), default=0),
            is_active=parse_bool(data.get('is_active'), default=True),
            status=status,
            condition_logic=condition_logic,
            conditions_json=self.serialize_json_object(conditions, default_value={'groups': [], 'items': []}),
            display_config=self.serialize_json_object(self.parse_json_object(data.get('display_config'), {}), default_value={}),
            permission_config=self.serialize_json_object(self.parse_json_object(data.get('permission_config'), {}), default_value={}),
            schema_config=self.parse_schema_config(data.get('schema_config')),
            version=1,
            published_at=datetime.utcnow() if status == 'published' else None,
            description=str(data.get('description') or '').strip() or None,
        )
        operator = str(data.get('operator') or 'system').strip() or 'system'

        try:
            self.crud.add(item)
            self.db.session.flush()
            self._save_version_snapshot(item, action='create', operator=operator)
            self.crud.commit()
            return item.to_dict(), 201
        except ListPageServiceError:
            self.crud.rollback()
            raise
        except Exception as e:
            self.crud.rollback()
            raise ListPageServiceError(str(e), 500) from e

    def update_item(self, item, data):
        if 'name' in data and not str(data.get('name') or '').strip():
            raise ListPageServiceError('查询名称不能为空', 400)

        if 'query_code' in data:
            next_code = str(data.get('query_code') or '').strip()
            if not next_code:
                raise ListPageServiceError('查询编码不能为空', 400)
            duplicate = self.crud.query().filter(
                self.QueryManagement.query_code == next_code,
                self.QueryManagement.id != item.id,
            ).first()
            if duplicate:
                raise ListPageServiceError('查询编码已存在', 400)

        update_map = {
            'name': lambda val: str(val or '').strip(),
            'query_code': lambda val: str(val or '').strip(),
            'category': lambda val: str(val or '').strip() or 'general',
            'keyword': lambda val: str(val or '').strip() or None,
            'data_source': lambda val: str(val or '').strip() or None,
            'owner': lambda val: str(val or '').strip() or None,
            'priority': lambda val: parse_int(val, default=item.priority or 0),
            'is_active': lambda val: parse_bool(val, default=item.is_active),
            'description': lambda val: str(val or '').strip() or None,
        }
        for field, converter in update_map.items():
            if field in data:
                setattr(item, field, converter(data.get(field)))

        if 'status' in data:
            item.status = self.normalize_status(data.get('status'), default=item.status or 'draft')
            if item.status == 'published' and not item.published_at:
                item.published_at = datetime.utcnow()

        if 'condition_logic' in data:
            condition_logic = str(data.get('condition_logic') or 'AND').strip().upper()
            item.condition_logic = condition_logic if condition_logic in {'AND', 'OR'} else 'AND'

        if 'conditions' in data:
            item.conditions_json = self.serialize_json_object(
                self.normalize_conditions(data.get('conditions')),
                default_value={'groups': [], 'items': []},
            )

        if 'display_config' in data:
            item.display_config = self.serialize_json_object(
                self.parse_json_object(data.get('display_config'), {}),
                default_value={},
            )

        if 'permission_config' in data:
            item.permission_config = self.serialize_json_object(
                self.parse_json_object(data.get('permission_config'), {}),
                default_value={},
            )

        if 'schema_config' in data:
            item.schema_config = self.parse_schema_config(data.get('schema_config'))

        if 'image_urls' in data or 'image_url' in data:
            image_urls = self.normalize_image_urls(data.get('image_urls'))
            if not image_urls:
                image_urls = self.normalize_image_urls(data.get('image_url'))
            item.image_urls = self.serialize_url_list(image_urls)
            item.image_url = image_urls[0] if image_urls else None

        if 'file_urls' in data or 'file_url' in data:
            file_urls = self.normalize_file_urls(data.get('file_urls'))
            if not file_urls:
                file_urls = self.normalize_file_urls(data.get('file_url'))
            item.file_urls = self.serialize_url_list(file_urls)
            item.file_url = file_urls[0] if file_urls else None

        item.version = (item.version or 1) + 1
        operator = str(data.get('operator') or 'system').strip() or 'system'

        try:
            self._save_version_snapshot(item, action='update', operator=operator)
            self.crud.commit()
            return item.to_dict()
        except ListPageServiceError:
            self.crud.rollback()
            raise
        except Exception as e:
            self.crud.rollback()
            raise ListPageServiceError(str(e), 500) from e

    def delete_item(self, item):
        if is_enabled_for_delete(item):
            raise ListPageServiceError(enabled_delete_message('记录'), 409)
        try:
            self.crud.delete(item)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise ListPageServiceError(str(e), 500) from e

    def run_preview(self, data):
        display_config = self.parse_json_object(data.get('display_config'), {})
        conditions = self.normalize_conditions(data.get('conditions'))

        selected_fields = display_config.get('selected_fields')
        if not isinstance(selected_fields, list) or not selected_fields:
            selected_fields = ['id', 'name', 'status', 'owner', 'updated_at']

        row_count = parse_int(display_config.get('preview_rows'), default=8)
        row_count = max(1, min(row_count, 50))

        columns = []
        for field in selected_fields:
            key = str(field or '').strip()
            if not key:
                continue
            columns.append({
                'title': key.replace('_', ' ').title(),
                'dataIndex': key,
            })
        if not columns:
            columns = [
                {'title': 'Id', 'dataIndex': 'id'},
                {'title': 'Name', 'dataIndex': 'name'},
            ]

        rows = []
        for index in range(row_count):
            row = {}
            for col in columns:
                key = col['dataIndex']
                if key in {'id', 'priority'}:
                    row[key] = index + 1
                elif key in {'is_active'}:
                    row[key] = (index % 2 == 0)
                elif key in {'updated_at', 'created_at'}:
                    row[key] = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
                elif key in {'status'}:
                    row[key] = 'published' if index % 2 == 0 else 'draft'
                else:
                    row[key] = f'{key}_sample_{index + 1}'
            rows.append(row)

        elapsed_ms = 35 + len(columns) * 6 + len(conditions.get('items', [])) * 11
        return {
            'message': '执行成功',
            'elapsed_ms': elapsed_ms,
            'columns': columns,
            'rows': rows,
            'total': row_count,
            'condition_count': len(conditions.get('items', [])),
        }

    def list_versions(self, item, page=1, per_page=20):
        pagination = self.crud.version_query().filter(
            self.QueryManagementVersion.query_management_id == item.id,
        ).order_by(self.QueryManagementVersion.id.desc()).paginate(
            page=page,
            per_page=per_page,
            error_out=False,
        )
        return {
            'items': [version.to_dict() for version in pagination.items],
            'total': pagination.total,
            'page': page,
            'per_page': per_page,
        }

    def rollback_version(self, item, version_item, operator='system'):
        if version_item.query_management_id != item.id:
            raise ListPageServiceError('版本不属于当前记录', 400)

        snapshot = self.parse_json_object(version_item.snapshot_json, {})
        if not snapshot:
            raise ListPageServiceError('版本快照无效', 400)

        target_code = str(snapshot.get('query_code') or item.query_code).strip()
        duplicate = self.crud.query().filter(
            self.QueryManagement.query_code == target_code,
            self.QueryManagement.id != item.id,
        ).first()
        if duplicate:
            raise ListPageServiceError('回滚后查询编码冲突', 400)

        item.name = str(snapshot.get('name') or item.name).strip()
        item.query_code = target_code
        item.category = str(snapshot.get('category') or 'general').strip() or 'general'
        item.keyword = str(snapshot.get('keyword') or '').strip() or None
        item.data_source = str(snapshot.get('data_source') or '').strip() or None
        item.owner = str(snapshot.get('owner') or '').strip() or None
        item.image_url = str(snapshot.get('image_url') or '').strip() or None
        item.image_urls = self.serialize_url_list(self.normalize_image_urls(snapshot.get('image_urls')))
        item.file_url = str(snapshot.get('file_url') or '').strip() or None
        item.file_urls = self.serialize_url_list(self.normalize_file_urls(snapshot.get('file_urls')))
        item.priority = parse_int(snapshot.get('priority'), default=0)
        item.is_active = parse_bool(snapshot.get('is_active'), default=True)
        item.status = self.normalize_status(snapshot.get('status'), default='draft')
        item.condition_logic = str(snapshot.get('condition_logic') or 'AND').strip().upper()
        if item.condition_logic not in {'AND', 'OR'}:
            item.condition_logic = 'AND'
        item.conditions_json = self.serialize_json_object(
            self.normalize_conditions(snapshot.get('conditions')),
            default_value={'groups': [], 'items': []},
        )
        item.display_config = self.serialize_json_object(
            self.parse_json_object(snapshot.get('display_config'), {}),
            default_value={},
        )
        item.permission_config = self.serialize_json_object(
            self.parse_json_object(snapshot.get('permission_config'), {}),
            default_value={},
        )
        item.schema_config = self.parse_schema_config(snapshot.get('schema_config'))
        item.description = str(snapshot.get('description') or '').strip() or None
        item.published_at = datetime.utcnow() if item.status == 'published' else None

        item.version = (item.version or 1) + 1
        self._save_version_snapshot(item, action='rollback', operator=operator)

        try:
            self.crud.commit()
            return item.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise ListPageServiceError(str(e), 500) from e

    def export_items(self, data, request_method='POST'):
        if request_method == 'GET':
            ids = []
            fields = str(data.get('fields') or '').strip()
            fields = [item.strip() for item in fields.split(',') if item.strip()] if fields else []
            export_mode = 'filtered'
            filters = {
                'search': data.get('search'),
                'category': data.get('category'),
                'owner': data.get('owner'),
                'is_active': data.get('is_active'),
                'status': data.get('status'),
            }
            file_type = normalize_table_file_type(data.get('file_type'), default='csv')
        else:
            ids = data.get('ids') or []
            fields = data.get('fields') or []
            export_mode = str(data.get('export_mode') or 'selected').strip()
            filters = data.get('filters') or {}
            file_type = normalize_table_file_type(data.get('file_type'), default='csv')

        valid_fields = [field for field in fields if field in EXPORT_FIELD_MAP]
        if not valid_fields:
            valid_fields = list(EXPORT_FIELD_MAP.keys())

        if export_mode == 'filtered':
            query = self.crud.query()
            search = str(filters.get('search') or '').strip()
            category = str(filters.get('category') or '').strip()
            owner = str(filters.get('owner') or '').strip()
            is_active = parse_bool(filters.get('is_active'))
            status = str(filters.get('status') or '').strip()

            if search:
                query = query.filter(self.db.or_(
                    self.QueryManagement.name.ilike(f'%{search}%'),
                    self.QueryManagement.query_code.ilike(f'%{search}%'),
                    self.QueryManagement.keyword.ilike(f'%{search}%'),
                    self.QueryManagement.data_source.ilike(f'%{search}%'),
                    self.QueryManagement.owner.ilike(f'%{search}%'),
                ))
            if category:
                query = query.filter(self.QueryManagement.category == category)
            if owner:
                query = query.filter(self.QueryManagement.owner.ilike(f'%{owner}%'))
            if is_active is not None:
                query = query.filter(self.QueryManagement.is_active == is_active)
            if status:
                query = query.filter(self.QueryManagement.status == status)

            items = query.order_by(self.QueryManagement.id.asc()).all()
        else:
            if not isinstance(ids, list) or not ids:
                raise ListPageServiceError('请先勾选要导出的查询数据', 400)
            items = self.crud.list_by_ids(ids).order_by(self.QueryManagement.id.asc()).all()

        headers = [EXPORT_FIELD_MAP[field][0] for field in valid_fields]
        rows = [[EXPORT_FIELD_MAP[field][1](item) for field in valid_fields] for item in items]
        try:
            return build_table_response(headers, rows, 'list_page_export', file_type=file_type)
        except RuntimeError as e:
            raise ListPageServiceError(str(e), 500) from e

    def download_template(self, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='csv')
        headers = [
            '查询名称', '查询编码', '查询分类', '关键字', '数据源', '负责人',
            '图片URL列表', '文件URL列表', '优先级', '状态', '发布状态', '描述',
        ]
        rows = [[
            '订单主查询',
            'order_main_query',
            'order',
            '订单,时间范围',
            'orders',
            'admin',
            'https://example.com/1.png,https://example.com/2.png',
            'https://example.com/a.pdf,https://example.com/b.xlsx',
            10,
            '启用',
            'draft',
            '查询模板示例',
        ]]
        try:
            return build_table_response(headers, rows, 'list_page_import_template', file_type=file_type)
        except RuntimeError as e:
            raise ListPageServiceError(str(e), 500) from e

    def import_items(self, file_storage):
        if not file_storage:
            raise ListPageServiceError('请上传导入文件', 400)

        try:
            fieldnames, rows_with_line, _ = read_table_file(file_storage)
        except ValueError as e:
            raise ListPageServiceError(str(e), 400) from e
        except RuntimeError as e:
            raise ListPageServiceError(str(e), 500) from e

        if not fieldnames:
            raise ListPageServiceError('导入内容为空', 400)

        row_header_map = {}
        for header in fieldnames:
            key = (header or '').strip()
            if key in IMPORT_HEADER_MAP:
                row_header_map[header] = IMPORT_HEADER_MAP[key]

        if 'name' not in row_header_map.values() or 'query_code' not in row_header_map.values():
            raise ListPageServiceError('导入文件缺少“查询名称/查询编码”列', 400)

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

                name = str(mapped.get('name') or '').strip()
                query_code = str(mapped.get('query_code') or '').strip()
                category = str(mapped.get('category') or 'general').strip() or 'general'
                keyword = str(mapped.get('keyword') or '').strip() or None
                data_source = str(mapped.get('data_source') or '').strip() or None
                owner = str(mapped.get('owner') or '').strip() or None
                image_urls = self.normalize_image_urls(mapped.get('image_urls'))
                if not image_urls:
                    image_urls = self.normalize_image_urls(mapped.get('image_url'))
                file_urls = self.normalize_file_urls(mapped.get('file_urls'))
                if not file_urls:
                    file_urls = self.normalize_file_urls(mapped.get('file_url'))
                priority = parse_int(mapped.get('priority'), default=0)
                is_active = parse_bool(mapped.get('is_active'), default=True)
                status = self.normalize_status(mapped.get('status'), default='draft')
                description = str(mapped.get('description') or '').strip() or None

                if not name or not query_code:
                    errors.append(build_error_row(line, '查询名称和查询编码不能为空', row))
                    continue

                item = self.crud.get_by_code(query_code)
                if item:
                    item.name = name
                    item.category = category
                    item.keyword = keyword
                    item.data_source = data_source
                    item.owner = owner
                    item.image_urls = self.serialize_url_list(image_urls)
                    item.image_url = image_urls[0] if image_urls else None
                    item.file_urls = self.serialize_url_list(file_urls)
                    item.file_url = file_urls[0] if file_urls else None
                    item.priority = priority
                    item.is_active = is_active
                    item.status = status
                    item.description = description
                    item.version = (item.version or 1) + 1
                    if item.status == 'published' and not item.published_at:
                        item.published_at = datetime.utcnow()
                    self._save_version_snapshot(item, action='import_update', operator='import')
                    updated += 1
                else:
                    item = self.QueryManagement(
                        name=name,
                        query_code=query_code,
                        category=category,
                        keyword=keyword,
                        data_source=data_source,
                        owner=owner,
                        image_url=image_urls[0] if image_urls else None,
                        image_urls=self.serialize_url_list(image_urls),
                        file_url=file_urls[0] if file_urls else None,
                        file_urls=self.serialize_url_list(file_urls),
                        priority=priority,
                        is_active=is_active,
                        status=status,
                        condition_logic='AND',
                        conditions_json=self.serialize_json_object({'groups': [], 'items': []}, default_value={'groups': [], 'items': []}),
                        display_config=self.serialize_json_object({}, default_value={}),
                        permission_config=self.serialize_json_object({}, default_value={}),
                        schema_config='',
                        version=1,
                        published_at=datetime.utcnow() if status == 'published' else None,
                        description=description,
                    )
                    self.crud.add(item)
                    self.db.session.flush()
                    self._save_version_snapshot(item, action='import_create', operator='import')
                    created += 1

            if errors:
                self.crud.rollback()
                raise ListPageServiceError('导入失败，存在错误数据', 400, {
                    'error_rows': errors[:500],
                    'error_count': len(errors),
                })

            self.crud.commit()
            return {'message': '导入成功', 'created': created, 'updated': updated}
        except ListPageServiceError:
            raise
        except Exception as e:
            self.crud.rollback()
            raise ListPageServiceError(str(e), 500) from e
