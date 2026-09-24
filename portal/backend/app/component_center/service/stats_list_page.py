# -*- coding: utf-8 -*-
"""带统计的列表页 service 层"""

from backend.app.component_center.crud.stats_list_page import StatsListPageCRUD
from backend.app.component_center.schema.stats_list_page import (
    EXPORT_FIELD_MAP,
    IMPORT_HEADER_MAP,
    build_error_row,
    parse_bool,
    parse_float,
    parse_int,
)
from backend.common.tabular import build_table_response, normalize_table_file_type, read_table_file
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete

STATUS_VALUES = {'draft', 'published', 'archived'}
CATEGORY_VALUES = {'general', 'order', 'user', 'finance', 'risk'}


class StatsListPageServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class StatsListPageService:
    def __init__(self, db, stats_item_model):
        self.db = db
        self.StatsItem = stats_item_model
        self.crud = StatsListPageCRUD(db, stats_item_model)

    @staticmethod
    def normalize_status(value, default='draft'):
        if value is None:
            return default
        raw = str(value).strip().lower()
        if not raw:
            return default
        if raw not in STATUS_VALUES:
            raise StatsListPageServiceError('状态仅支持 draft/published/archived', 400)
        return raw

    def _build_list_query(self, search='', category='', owner='', is_active=None, status=''):
        query = self.crud.query()
        if search:
            query = query.filter(self.db.or_(
                self.StatsItem.name.ilike(f'%{search}%'),
                self.StatsItem.item_code.ilike(f'%{search}%'),
                self.StatsItem.owner.ilike(f'%{search}%'),
            ))
        if category:
            query = query.filter(self.StatsItem.category == category)
        if owner:
            query = query.filter(self.StatsItem.owner.ilike(f'%{owner}%'))
        if is_active is not None:
            query = query.filter(self.StatsItem.is_active == is_active)
        if status:
            query = query.filter(self.StatsItem.status == status)
        return query

    def list_items(self, page=1, per_page=20, search='', category='', owner='', is_active=None, status=''):
        query = self._build_list_query(search=search, category=category, owner=owner, is_active=is_active, status=status)
        pagination = query.order_by(
            self.StatsItem.priority.desc(),
            self.StatsItem.id.desc(),
        ).paginate(page=page, per_page=per_page, error_out=False)
        return {
            'items': [item.to_dict() for item in pagination.items],
            'total': pagination.total,
            'page': page,
            'per_page': per_page,
        }

    def get_stats(self):
        from sqlalchemy import func

        total = self.crud.query().count()
        active_count = self.crud.query().filter(self.StatsItem.is_active == True).count()
        published_count = self.crud.query().filter(self.StatsItem.status == 'published').count()
        draft_count = self.crud.query().filter(self.StatsItem.status == 'draft').count()
        archived_count = self.crud.query().filter(self.StatsItem.status == 'archived').count()

        amount_row = self.db.session.query(
            func.sum(self.StatsItem.amount),
            func.avg(self.StatsItem.amount),
        ).first()
        total_amount = float(amount_row[0]) if amount_row[0] is not None else 0.0
        avg_amount = float(amount_row[1]) if amount_row[1] is not None else 0.0

        category_rows = self.db.session.query(
            self.StatsItem.category,
            func.count(self.StatsItem.id),
            func.sum(self.StatsItem.amount),
        ).group_by(self.StatsItem.category).all()
        category_stats = [
            {
                'category': row[0] or 'general',
                'count': row[1],
                'amount': float(row[2]) if row[2] is not None else 0.0,
            }
            for row in category_rows
        ]

        return {
            'total': total,
            'active_count': active_count,
            'inactive_count': total - active_count,
            'published_count': published_count,
            'draft_count': draft_count,
            'archived_count': archived_count,
            'total_amount': total_amount,
            'avg_amount': round(avg_amount, 2),
            'category_stats': category_stats,
        }

    def create_item(self, data):
        name = str(data.get('name') or '').strip()
        item_code = str(data.get('item_code') or '').strip()
        if not name:
            raise StatsListPageServiceError('名称不能为空', 400)
        if not item_code:
            raise StatsListPageServiceError('编码不能为空', 400)
        if self.crud.get_by_code(item_code):
            raise StatsListPageServiceError('编码已存在', 400)

        status = self.normalize_status(data.get('status'), default='draft')
        item = self.StatsItem(
            name=name,
            item_code=item_code,
            category=str(data.get('category') or 'general').strip() or 'general',
            status=status,
            amount=parse_float(data.get('amount'), default=0.0),
            quantity=parse_int(data.get('quantity'), default=0),
            owner=str(data.get('owner') or '').strip() or None,
            priority=parse_int(data.get('priority'), default=0),
            is_active=parse_bool(data.get('is_active'), default=True),
            description=str(data.get('description') or '').strip() or None,
        )
        try:
            self.crud.add(item)
            self.crud.commit()
            return item.to_dict(), 201
        except StatsListPageServiceError:
            self.crud.rollback()
            raise
        except Exception as e:
            self.crud.rollback()
            raise StatsListPageServiceError(str(e), 500) from e

    def update_item(self, item, data):
        if 'name' in data and not str(data.get('name') or '').strip():
            raise StatsListPageServiceError('名称不能为空', 400)

        if 'item_code' in data:
            next_code = str(data.get('item_code') or '').strip()
            if not next_code:
                raise StatsListPageServiceError('编码不能为空', 400)
            duplicate = self.crud.query().filter(
                self.StatsItem.item_code == next_code,
                self.StatsItem.id != item.id,
            ).first()
            if duplicate:
                raise StatsListPageServiceError('编码已存在', 400)

        update_map = {
            'name': lambda val: str(val or '').strip(),
            'item_code': lambda val: str(val or '').strip(),
            'category': lambda val: str(val or '').strip() or 'general',
            'owner': lambda val: str(val or '').strip() or None,
            'priority': lambda val: parse_int(val, default=item.priority or 0),
            'is_active': lambda val: parse_bool(val, default=item.is_active),
            'description': lambda val: str(val or '').strip() or None,
            'amount': lambda val: parse_float(val, default=float(item.amount) if item.amount is not None else 0.0),
            'quantity': lambda val: parse_int(val, default=item.quantity or 0),
        }
        for field, converter in update_map.items():
            if field in data:
                setattr(item, field, converter(data.get(field)))

        if 'status' in data:
            item.status = self.normalize_status(data.get('status'), default=item.status or 'draft')

        try:
            self.crud.commit()
            return item.to_dict()
        except StatsListPageServiceError:
            self.crud.rollback()
            raise
        except Exception as e:
            self.crud.rollback()
            raise StatsListPageServiceError(str(e), 500) from e

    def delete_item(self, item):
        if is_enabled_for_delete(item):
            raise StatsListPageServiceError(enabled_delete_message('记录'), 409)
        try:
            self.crud.delete(item)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise StatsListPageServiceError(str(e), 500) from e

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
            items = query.order_by(self.StatsItem.id.asc()).all()
        else:
            if not isinstance(ids, list) or not ids:
                raise StatsListPageServiceError('请先勾选要导出的数据', 400)
            items = self.crud.list_by_ids(ids).order_by(self.StatsItem.id.asc()).all()

        headers = [EXPORT_FIELD_MAP[f][0] for f in valid_fields]
        rows = [[EXPORT_FIELD_MAP[f][1](item) for f in valid_fields] for item in items]
        try:
            return build_table_response(headers, rows, 'stats_list_page_export', file_type=file_type)
        except RuntimeError as e:
            raise StatsListPageServiceError(str(e), 500) from e

    def download_template(self, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='csv')
        headers = ['名称', '编码', '分类', '发布状态', '金额', '数量', '负责人', '优先级', '状态', '描述']
        rows = [['示例商品A', 'item_001', 'order', 'draft', 9999.00, 100, 'admin', 10, '启用', '示例描述']]
        try:
            return build_table_response(headers, rows, 'stats_list_page_import_template', file_type=file_type)
        except RuntimeError as e:
            raise StatsListPageServiceError(str(e), 500) from e

    def import_items(self, file_storage):
        if not file_storage:
            raise StatsListPageServiceError('请上传导入文件', 400)

        try:
            fieldnames, rows_with_line, _ = read_table_file(file_storage)
        except ValueError as e:
            raise StatsListPageServiceError(str(e), 400) from e
        except RuntimeError as e:
            raise StatsListPageServiceError(str(e), 500) from e

        if not fieldnames:
            raise StatsListPageServiceError('导入内容为空', 400)

        row_header_map = {}
        for header in fieldnames:
            key = (header or '').strip()
            if key in IMPORT_HEADER_MAP:
                row_header_map[header] = IMPORT_HEADER_MAP[key]

        if 'name' not in row_header_map.values() or 'item_code' not in row_header_map.values():
            raise StatsListPageServiceError('导入文件缺少"名称/编码"列', 400)

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
                item_code = str(mapped.get('item_code') or '').strip()
                if not name or not item_code:
                    errors.append(build_error_row(line, '名称和编码不能为空', row))
                    continue

                category = str(mapped.get('category') or 'general').strip() or 'general'
                status = self.normalize_status(mapped.get('status'), default='draft')
                amount = parse_float(mapped.get('amount'), default=0.0)
                quantity = parse_int(mapped.get('quantity'), default=0)
                owner = str(mapped.get('owner') or '').strip() or None
                priority = parse_int(mapped.get('priority'), default=0)
                is_active = parse_bool(mapped.get('is_active'), default=True)
                description = str(mapped.get('description') or '').strip() or None

                item = self.crud.get_by_code(item_code)
                if item:
                    item.name = name
                    item.category = category
                    item.status = status
                    item.amount = amount
                    item.quantity = quantity
                    item.owner = owner
                    item.priority = priority
                    item.is_active = is_active
                    item.description = description
                    updated += 1
                else:
                    item = self.StatsItem(
                        name=name,
                        item_code=item_code,
                        category=category,
                        status=status,
                        amount=amount,
                        quantity=quantity,
                        owner=owner,
                        priority=priority,
                        is_active=is_active,
                        description=description,
                    )
                    self.crud.add(item)
                    created += 1

            if errors:
                self.crud.rollback()
                raise StatsListPageServiceError('导入失败，存在错误数据', 400, {
                    'error_rows': errors[:500],
                    'error_count': len(errors),
                })

            self.crud.commit()
            return {'message': '导入成功', 'created': created, 'updated': updated}
        except StatsListPageServiceError:
            raise
        except Exception as e:
            self.crud.rollback()
            raise StatsListPageServiceError(str(e), 500) from e
