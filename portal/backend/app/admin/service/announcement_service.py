# -*- coding: utf-8 -*-
"""公告管理 Service 层"""

from datetime import datetime

from backend.app.admin.crud.announcement import AnnouncementCRUD
from backend.app.admin.schema.announcement import AnnouncementSchemaError, normalize_announcement
from backend.common.tabular import build_table_response, normalize_table_file_type, read_table_file

EXPORT_FIELD_MAP = {
    'id': ('ID', lambda item: item.id),
    'title': ('标题', lambda item: item.title or ''),
    'announce_type': ('公告类型', lambda item: item.announce_type or ''),
    'status': ('状态', lambda item: item.status or ''),
    'is_top': ('是否置顶', lambda item: '是' if item.is_top else '否'),
    'sort_order': ('排序权重', lambda item: item.sort_order if item.sort_order is not None else 0),
    'content': ('内容', lambda item: item.content or ''),
    'publish_at': ('发布时间', lambda item: item.publish_at.strftime('%Y-%m-%d %H:%M:%S') if item.publish_at else ''),
    'created_at': ('创建时间', lambda item: item.created_at.strftime('%Y-%m-%d %H:%M:%S') if item.created_at else ''),
}

IMPORT_HEADER_MAP = {
    '标题': 'title',
    '公告类型': 'announce_type',
    '状态': 'status',
    '是否置顶': 'is_top',
    '排序权重': 'sort_order',
    '内容': 'content',
    'title': 'title',
    'announce_type': 'announce_type',
    'status': 'status',
    'is_top': 'is_top',
    'sort_order': 'sort_order',
    'content': 'content',
}


class AnnouncementServiceError(Exception):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class AnnouncementService:
    def __init__(self, db, model):
        self.Announcement = model
        self.crud = AnnouncementCRUD(db, model)

    def require_item(self, item_id):
        item = self.crud.get(item_id)
        if not item:
            raise AnnouncementServiceError('公告不存在', 404)
        return item

    def list_items(self, page=1, per_page=20, search='', status=None, announce_type=None):
        pagination = self.crud.page(page, per_page, search, status, announce_type)
        return {
            'items': [item.to_dict() for item in pagination.items],
            'total': pagination.total,
        }

    def create_item(self, data):
        try:
            payload = normalize_announcement(data)
        except AnnouncementSchemaError as exc:
            raise AnnouncementServiceError(str(exc)) from exc
        if payload['status'] == 'published' and not payload.get('publish_at'):
            payload['publish_at'] = datetime.utcnow()
        item = self.Announcement(**payload)
        try:
            self.crud.add(item)
            self.crud.commit()
            return item.to_dict(), 201
        except Exception as e:
            self.crud.rollback()
            raise AnnouncementServiceError('创建公告失败，请稍后重试', 500) from e

    def update_item(self, item, data):
        try:
            payload = normalize_announcement(data, partial=True)
        except AnnouncementSchemaError as exc:
            raise AnnouncementServiceError(str(exc)) from exc
        for field, value in payload.items():
            setattr(item, field, value)
        if payload.get('status') == 'published' and item.publish_at is None:
                item.publish_at = datetime.utcnow()
        try:
            self.crud.commit()
            return item.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise AnnouncementServiceError('更新公告失败，请稍后重试', 500) from e

    def delete_item(self, item):
        try:
            self.crud.delete(item)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise AnnouncementServiceError('删除公告失败，请稍后重试', 500) from e

    def publish_item(self, item):
        item.status = 'published'
        if item.publish_at is None:
            item.publish_at = datetime.utcnow()
        try:
            self.crud.commit()
            return item.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise AnnouncementServiceError('发布公告失败，请稍后重试', 500) from e

    def unpublish_item(self, item):
        item.status = 'draft'
        try:
            self.crud.commit()
            return item.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise AnnouncementServiceError('撤回公告失败，请稍后重试', 500) from e

    def export_items(self, data):
        fields = data.get('fields') or []
        file_type = normalize_table_file_type(data.get('file_type'), default='xlsx')
        ids = data.get('ids') or []
        export_mode = str(data.get('export_mode') or 'all').strip()

        valid_fields = [f for f in fields if f in EXPORT_FIELD_MAP]
        if not valid_fields:
            valid_fields = list(EXPORT_FIELD_MAP.keys())

        if export_mode == 'selected' and ids:
            items = self.crud.export_items(ids)
        else:
            items = self.crud.export_items()

        headers = [EXPORT_FIELD_MAP[f][0] for f in valid_fields]
        rows = [[EXPORT_FIELD_MAP[f][1](item) for f in valid_fields] for item in items]
        try:
            return build_table_response(headers, rows, 'announcements_export', file_type=file_type)
        except RuntimeError as e:
            raise AnnouncementServiceError(str(e), 500) from e

    def download_template(self, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='xlsx')
        headers = ['标题', '公告类型', '状态', '是否置顶', '排序权重', '内容']
        rows = [['系统维护公告', 'system', 'draft', '否', '0', '系统将于今晚进行维护，请提前保存工作。']]
        try:
            return build_table_response(headers, rows, 'announcements_import_template', file_type=file_type)
        except RuntimeError as e:
            raise AnnouncementServiceError(str(e), 500) from e

    def import_items(self, file_storage):
        if not file_storage:
            raise AnnouncementServiceError('请上传导入文件', 400)
        try:
            fieldnames, rows_with_line, _ = read_table_file(file_storage)
        except ValueError as e:
            raise AnnouncementServiceError(str(e), 400) from e
        except RuntimeError as e:
            raise AnnouncementServiceError(str(e), 500) from e

        if not fieldnames:
            raise AnnouncementServiceError('文件为空或格式错误', 400)

        col_map = {}
        for col in fieldnames:
            mapped = IMPORT_HEADER_MAP.get(col.strip())
            if mapped:
                col_map[col.strip()] = mapped

        created = 0
        error_rows = []
        for line_no, row in rows_with_line:
            mapped = {col_map[k]: v for k, v in row.items() if k in col_map}
            title = (mapped.get('title') or '').strip()
            if not title:
                error_rows.append({'line': line_no, 'reason': '标题不能为空', 'row': row})
                continue
            is_top_raw = str(mapped.get('is_top') or '').strip()
            is_top = is_top_raw in ('是', 'true', 'True', '1')
            try:
                sort_order = int(mapped.get('sort_order') or 0)
            except (ValueError, TypeError):
                sort_order = 0
            announce_type = (mapped.get('announce_type') or 'system').strip()
            if announce_type not in ('system', 'activity', 'update'):
                announce_type = 'system'
            status = (mapped.get('status') or 'draft').strip()
            if status not in ('draft', 'published'):
                status = 'draft'
            try:
                item = self.Announcement(
                    title=title,
                    content=mapped.get('content') or '',
                    announce_type=announce_type,
                    status=status,
                    is_top=is_top,
                    sort_order=sort_order,
                )
                self.crud.add(item)
                self.crud.commit()
                created += 1
            except Exception as e:
                self.crud.rollback()
                error_rows.append({'line': line_no, 'reason': '保存失败', 'row': row})

        if error_rows:
            return {'created': created, 'updated': 0, 'error_rows': error_rows}
        return {'created': created, 'updated': 0}
