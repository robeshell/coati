# -*- coding: utf-8 -*-
"""卡片列表页 service 层"""

from backend.app.component_center.crud.card_list_page import CardListPageCRUD
from backend.app.component_center.schema.card_list_page import (
    EXPORT_FIELD_MAP,
    IMPORT_HEADER_MAP,
    build_error_row,
    parse_bool,
    parse_int,
)
from backend.common.tabular import build_table_response, normalize_table_file_type, read_table_file
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete

STATUS_VALUES = {'draft', 'published', 'archived'}
CATEGORY_VALUES = {'general', 'product', 'article', 'event', 'promotion'}


class CardListPageServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class CardListPageService:
    def __init__(self, db, card_item_model):
        self.db = db
        self.CardItem = card_item_model
        self.crud = CardListPageCRUD(db, card_item_model)

    @staticmethod
    def normalize_status(value, default='draft'):
        if value is None:
            return default
        raw = str(value).strip().lower()
        if not raw:
            return default
        if raw not in STATUS_VALUES:
            raise CardListPageServiceError('状态仅支持 draft/published/archived', 400)
        return raw

    def _build_list_query(self, search='', category='', owner='', is_active=None, status=''):
        query = self.crud.query()
        if search:
            query = query.filter(self.db.or_(
                self.CardItem.title.ilike(f'%{search}%'),
                self.CardItem.card_code.ilike(f'%{search}%'),
                self.CardItem.owner.ilike(f'%{search}%'),
            ))
        if category:
            query = query.filter(self.CardItem.category == category)
        if owner:
            query = query.filter(self.CardItem.owner.ilike(f'%{owner}%'))
        if is_active is not None:
            query = query.filter(self.CardItem.is_active == is_active)
        if status:
            query = query.filter(self.CardItem.status == status)
        return query

    def list_items(self, page=1, per_page=20, search='', category='', owner='', is_active=None, status=''):
        query = self._build_list_query(search=search, category=category, owner=owner, is_active=is_active, status=status)
        pagination = query.order_by(
            self.CardItem.priority.desc(),
            self.CardItem.id.desc(),
        ).paginate(page=page, per_page=per_page, error_out=False)
        return {
            'items': [item.to_dict() for item in pagination.items],
            'total': pagination.total,
            'page': page,
            'per_page': per_page,
        }

    def create_item(self, data):
        title = str(data.get('title') or '').strip()
        card_code = str(data.get('card_code') or '').strip()
        if not title:
            raise CardListPageServiceError('标题不能为空', 400)
        if not card_code:
            raise CardListPageServiceError('编码不能为空', 400)
        if self.crud.get_by_code(card_code):
            raise CardListPageServiceError('编码已存在', 400)

        status = self.normalize_status(data.get('status'), default='draft')
        item = self.CardItem(
            title=title,
            card_code=card_code,
            subtitle=str(data.get('subtitle') or '').strip() or None,
            category=str(data.get('category') or 'general').strip() or 'general',
            cover_url=str(data.get('cover_url') or '').strip() or None,
            tag=str(data.get('tag') or '').strip() or None,
            status=status,
            owner=str(data.get('owner') or '').strip() or None,
            priority=parse_int(data.get('priority'), default=0),
            is_active=parse_bool(data.get('is_active'), default=True),
            description=str(data.get('description') or '').strip() or None,
        )
        try:
            self.crud.add(item)
            self.crud.commit()
            return item.to_dict(), 201
        except CardListPageServiceError:
            self.crud.rollback()
            raise
        except Exception as e:
            self.crud.rollback()
            raise CardListPageServiceError(str(e), 500) from e

    def update_item(self, item, data):
        if 'title' in data and not str(data.get('title') or '').strip():
            raise CardListPageServiceError('标题不能为空', 400)

        if 'card_code' in data:
            next_code = str(data.get('card_code') or '').strip()
            if not next_code:
                raise CardListPageServiceError('编码不能为空', 400)
            duplicate = self.crud.query().filter(
                self.CardItem.card_code == next_code,
                self.CardItem.id != item.id,
            ).first()
            if duplicate:
                raise CardListPageServiceError('编码已存在', 400)

        update_map = {
            'title': lambda val: str(val or '').strip(),
            'card_code': lambda val: str(val or '').strip(),
            'subtitle': lambda val: str(val or '').strip() or None,
            'category': lambda val: str(val or '').strip() or 'general',
            'cover_url': lambda val: str(val or '').strip() or None,
            'tag': lambda val: str(val or '').strip() or None,
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

        try:
            self.crud.commit()
            return item.to_dict()
        except CardListPageServiceError:
            self.crud.rollback()
            raise
        except Exception as e:
            self.crud.rollback()
            raise CardListPageServiceError(str(e), 500) from e

    def delete_item(self, item):
        if is_enabled_for_delete(item):
            raise CardListPageServiceError(enabled_delete_message('卡片'), 409)
        try:
            self.crud.delete(item)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise CardListPageServiceError(str(e), 500) from e

    def export_items(self, data, request_method='POST'):
        if request_method == 'GET':
            ids = []
            fields_raw = str(data.get('fields') or '').strip()
            fields = [f.strip() for f in fields_raw.split(',') if f.strip()] if fields_raw else []
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

        valid_fields = [f for f in fields if f in EXPORT_FIELD_MAP]
        if not valid_fields:
            valid_fields = list(EXPORT_FIELD_MAP.keys())

        if export_mode == 'filtered':
            query = self._build_list_query(
                search=str(filters.get('search') or '').strip(),
                category=str(filters.get('category') or '').strip(),
                owner=str(filters.get('owner') or '').strip(),
                is_active=parse_bool(filters.get('is_active')),
                status=str(filters.get('status') or '').strip(),
            )
            items = query.order_by(self.CardItem.id.asc()).all()
        else:
            if not isinstance(ids, list) or not ids:
                raise CardListPageServiceError('请先勾选要导出的数据', 400)
            items = self.crud.list_by_ids(ids).order_by(self.CardItem.id.asc()).all()

        headers = [EXPORT_FIELD_MAP[f][0] for f in valid_fields]
        rows = [[EXPORT_FIELD_MAP[f][1](item) for f in valid_fields] for item in items]
        try:
            return build_table_response(headers, rows, 'card_list_page_export', file_type=file_type)
        except RuntimeError as e:
            raise CardListPageServiceError(str(e), 500) from e

    def download_template(self, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='csv')
        headers = ['标题', '编码', '副标题', '分类', '标签', '发布状态', '负责人', '优先级', '状态', '描述']
        rows = [['示例卡片A', 'card_001', '副标题示例', 'product', '新品', 'draft', 'admin', 10, '启用', '示例描述']]
        try:
            return build_table_response(headers, rows, 'card_list_page_import_template', file_type=file_type)
        except RuntimeError as e:
            raise CardListPageServiceError(str(e), 500) from e

    def import_items(self, file_storage):
        if not file_storage:
            raise CardListPageServiceError('请上传导入文件', 400)

        try:
            fieldnames, rows_with_line, _ = read_table_file(file_storage)
        except ValueError as e:
            raise CardListPageServiceError(str(e), 400) from e
        except RuntimeError as e:
            raise CardListPageServiceError(str(e), 500) from e

        if not fieldnames:
            raise CardListPageServiceError('导入内容为空', 400)

        row_header_map = {}
        for header in fieldnames:
            key = (header or '').strip()
            if key in IMPORT_HEADER_MAP:
                row_header_map[header] = IMPORT_HEADER_MAP[key]

        if 'title' not in row_header_map.values() or 'card_code' not in row_header_map.values():
            raise CardListPageServiceError('导入文件缺少"标题/编码"列', 400)

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
                card_code = str(mapped.get('card_code') or '').strip()
                if not title or not card_code:
                    errors.append(build_error_row(line, '标题和编码不能为空', row))
                    continue

                category = str(mapped.get('category') or 'general').strip() or 'general'
                status = self.normalize_status(mapped.get('status'), default='draft')
                subtitle = str(mapped.get('subtitle') or '').strip() or None
                tag = str(mapped.get('tag') or '').strip() or None
                owner = str(mapped.get('owner') or '').strip() or None
                priority = parse_int(mapped.get('priority'), default=0)
                is_active = parse_bool(mapped.get('is_active'), default=True)
                description = str(mapped.get('description') or '').strip() or None

                item = self.crud.get_by_code(card_code)
                if item:
                    item.title = title
                    item.subtitle = subtitle
                    item.category = category
                    item.tag = tag
                    item.status = status
                    item.owner = owner
                    item.priority = priority
                    item.is_active = is_active
                    item.description = description
                    updated += 1
                else:
                    item = self.CardItem(
                        title=title,
                        card_code=card_code,
                        subtitle=subtitle,
                        category=category,
                        tag=tag,
                        status=status,
                        owner=owner,
                        priority=priority,
                        is_active=is_active,
                        description=description,
                    )
                    self.crud.add(item)
                    created += 1

            if errors:
                self.crud.rollback()
                raise CardListPageServiceError('导入失败，存在错误数据', 400, {
                    'error_rows': errors[:500],
                    'error_count': len(errors),
                })

            self.crud.commit()
            return {'message': '导入成功', 'created': created, 'updated': updated}
        except CardListPageServiceError:
            raise
        except Exception as e:
            self.crud.rollback()
            raise CardListPageServiceError(str(e), 500) from e
