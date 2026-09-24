# -*- coding: utf-8 -*-
"""高级表格页 service 层"""

from datetime import date

from backend.app.component_center.crud.advanced_table_page import AdvancedTablePageCRUD
from backend.app.component_center.schema.advanced_table_page import (
    CATEGORY_VALUES,
    STATUS_VALUES,
    parse_bool,
    parse_float,
    parse_int,
)
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete


class AdvancedTablePageServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class AdvancedTablePageService:
    INT32_MIN = -2147483648
    INT32_MAX = 2147483647

    def __init__(self, db, row_model):
        self.db = db
        self.AdvancedTableRow = row_model
        self.crud = AdvancedTablePageCRUD(db, row_model)

    @staticmethod
    def normalize_status(value, default='draft'):
        if value is None:
            return default
        raw = str(value).strip().lower()
        if not raw:
            return default
        if raw not in STATUS_VALUES:
            raise AdvancedTablePageServiceError('状态仅支持 draft/published/archived', 400)
        return raw

    @staticmethod
    def normalize_category(value, default='general'):
        raw = str(value or '').strip().lower() or default
        if raw not in CATEGORY_VALUES:
            return default
        return raw

    @staticmethod
    def normalize_progress(value, default=0):
        progress = parse_int(value, default=default)
        if progress < 0:
            return 0
        if progress > 100:
            return 100
        return progress

    @classmethod
    def normalize_sort_order(cls, value, default=0):
        sort_order = parse_int(value, default=default)
        if sort_order < cls.INT32_MIN or sort_order > cls.INT32_MAX:
            raise AdvancedTablePageServiceError('排序值超出范围', 400)
        return sort_order

    @staticmethod
    def parse_due_date(value):
        if not value:
            return None
        if isinstance(value, date):
            return value
        try:
            return date.fromisoformat(str(value)[:10])
        except ValueError:
            return None

    def _build_query(self, search='', status='', category='', owner='', is_active=None, pinned_only=False):
        query = self.crud.query()
        if search:
            query = query.filter(self.db.or_(
                self.AdvancedTableRow.name.ilike(f'%{search}%'),
                self.AdvancedTableRow.row_code.ilike(f'%{search}%'),
                self.AdvancedTableRow.tags.ilike(f'%{search}%'),
                self.AdvancedTableRow.remark.ilike(f'%{search}%'),
                self.AdvancedTableRow.owner.ilike(f'%{search}%'),
            ))
        if status:
            query = query.filter(self.AdvancedTableRow.status == status)
        if category:
            query = query.filter(self.AdvancedTableRow.category == category)
        if owner:
            query = query.filter(self.AdvancedTableRow.owner.ilike(f'%{owner}%'))
        if is_active is not None:
            query = query.filter(self.AdvancedTableRow.is_active == is_active)
        if pinned_only:
            query = query.filter(self.AdvancedTableRow.is_pinned == True)
        return query

    def list_items(
        self,
        page=1,
        per_page=20,
        search='',
        status='',
        category='',
        owner='',
        is_active=None,
        pinned_only=False,
        sort_field='sort_order',
        sort_order='asc',
    ):
        query = self._build_query(
            search=search,
            status=status,
            category=category,
            owner=owner,
            is_active=is_active,
            pinned_only=pinned_only,
        )

        sortable_fields = {
            'sort_order': self.AdvancedTableRow.sort_order,
            'priority': self.AdvancedTableRow.priority,
            'progress': self.AdvancedTableRow.progress,
            'score': self.AdvancedTableRow.score,
            'updated_at': self.AdvancedTableRow.updated_at,
            'due_date': self.AdvancedTableRow.due_date,
            'id': self.AdvancedTableRow.id,
        }
        order_column = sortable_fields.get(sort_field, self.AdvancedTableRow.sort_order)
        order_clause = order_column.desc() if str(sort_order).lower() == 'desc' else order_column.asc()

        pagination = query.order_by(
            self.AdvancedTableRow.is_pinned.desc(),
            order_clause,
            self.AdvancedTableRow.id.asc(),
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
        active_count = self.crud.query().filter(self.AdvancedTableRow.is_active == True).count()
        pinned_count = self.crud.query().filter(self.AdvancedTableRow.is_pinned == True).count()
        published_count = self.crud.query().filter(self.AdvancedTableRow.status == 'published').count()

        avg_row = self.db.session.query(
            func.avg(self.AdvancedTableRow.progress),
            func.avg(self.AdvancedTableRow.score),
        ).first()

        category_rows = self.db.session.query(
            self.AdvancedTableRow.category,
            func.count(self.AdvancedTableRow.id),
        ).group_by(self.AdvancedTableRow.category).all()

        return {
            'total': total,
            'active_count': active_count,
            'inactive_count': total - active_count,
            'pinned_count': pinned_count,
            'published_count': published_count,
            'avg_progress': round(float(avg_row[0] or 0), 2),
            'avg_score': round(float(avg_row[1] or 0), 2),
            'category_stats': [
                {'category': row[0] or 'general', 'count': row[1]}
                for row in category_rows
            ],
        }

    def create_item(self, data):
        name = str(data.get('name') or '').strip()
        row_code = str(data.get('row_code') or '').strip()
        if not name:
            raise AdvancedTablePageServiceError('名称不能为空')
        if not row_code:
            raise AdvancedTablePageServiceError('编码不能为空')
        if self.crud.get_by_code(row_code):
            raise AdvancedTablePageServiceError('编码已存在')

        item = self.AdvancedTableRow(
            name=name,
            row_code=row_code,
            category=self.normalize_category(data.get('category')),
            owner=str(data.get('owner') or '').strip() or None,
            status=self.normalize_status(data.get('status'), default='draft'),
            priority=parse_int(data.get('priority'), default=0),
            progress=self.normalize_progress(data.get('progress'), default=0),
            score=parse_float(data.get('score'), default=0.0),
            tags=str(data.get('tags') or '').strip() or None,
            is_active=parse_bool(data.get('is_active'), default=True),
            is_pinned=parse_bool(data.get('is_pinned'), default=False),
            due_date=self.parse_due_date(data.get('due_date')),
            sort_order=self.normalize_sort_order(data.get('sort_order'), default=0),
            remark=str(data.get('remark') or '').strip() or None,
        )
        try:
            self.crud.add(item)
            self.crud.commit()
            return item.to_dict(), 201
        except Exception as e:
            self.crud.rollback()
            raise AdvancedTablePageServiceError(str(e), 500) from e

    def update_item(self, item, data):
        if 'name' in data and not str(data.get('name') or '').strip():
            raise AdvancedTablePageServiceError('名称不能为空')

        if 'row_code' in data:
            next_code = str(data.get('row_code') or '').strip()
            if not next_code:
                raise AdvancedTablePageServiceError('编码不能为空')
            duplicate = self.crud.query().filter(
                self.AdvancedTableRow.row_code == next_code,
                self.AdvancedTableRow.id != item.id,
            ).first()
            if duplicate:
                raise AdvancedTablePageServiceError('编码已存在')

        update_map = {
            'name': lambda v: str(v or '').strip(),
            'row_code': lambda v: str(v or '').strip(),
            'category': lambda v: self.normalize_category(v, default=item.category or 'general'),
            'owner': lambda v: str(v or '').strip() or None,
            'priority': lambda v: parse_int(v, default=item.priority or 0),
            'progress': lambda v: self.normalize_progress(v, default=item.progress or 0),
            'score': lambda v: parse_float(v, default=float(item.score) if item.score is not None else 0.0),
            'tags': lambda v: str(v or '').strip() or None,
            'is_active': lambda v: parse_bool(v, default=item.is_active),
            'is_pinned': lambda v: parse_bool(v, default=item.is_pinned),
            'sort_order': lambda v: self.normalize_sort_order(v, default=item.sort_order or 0),
            'remark': lambda v: str(v or '').strip() or None,
        }
        for field, converter in update_map.items():
            if field in data:
                setattr(item, field, converter(data.get(field)))

        if 'status' in data:
            item.status = self.normalize_status(data.get('status'), default=item.status or 'draft')
        if 'due_date' in data:
            item.due_date = self.parse_due_date(data.get('due_date'))

        try:
            self.crud.commit()
            return item.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise AdvancedTablePageServiceError(str(e), 500) from e

    def delete_item(self, item):
        if is_enabled_for_delete(item):
            raise AdvancedTablePageServiceError(enabled_delete_message('记录'), 409)
        try:
            self.crud.delete(item)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise AdvancedTablePageServiceError(str(e), 500) from e

    def reorder_rows(self, items):
        if not isinstance(items, list):
            raise AdvancedTablePageServiceError('参数格式错误，需要数组')
        try:
            for item in items:
                row_id = parse_int(item.get('id'), default=0)
                sort_order = self.normalize_sort_order(item.get('sort_order'), default=0)
                if not row_id:
                    continue
                row = self.AdvancedTableRow.query.get(row_id)
                if row:
                    row.sort_order = sort_order
            self.crud.commit()
            return {'message': '排序已保存'}
        except Exception as e:
            self.crud.rollback()
            raise AdvancedTablePageServiceError(str(e), 500) from e

    def batch_update(self, data):
        ids = data.get('ids') or []
        if not isinstance(ids, list) or not ids:
            raise AdvancedTablePageServiceError('请先选择要操作的数据')

        items = self.crud.list_by_ids(ids).all()
        if not items:
            raise AdvancedTablePageServiceError('未找到可更新的数据')

        try:
            for item in items:
                if 'status' in data:
                    item.status = self.normalize_status(data.get('status'), default=item.status)
                if 'owner' in data:
                    item.owner = str(data.get('owner') or '').strip() or None
                if 'is_active' in data:
                    item.is_active = parse_bool(data.get('is_active'), default=item.is_active)
                if 'is_pinned' in data:
                    item.is_pinned = parse_bool(data.get('is_pinned'), default=item.is_pinned)
                if 'priority' in data:
                    item.priority = parse_int(data.get('priority'), default=item.priority or 0)
            self.crud.commit()
            return {'message': f'已更新 {len(items)} 条记录'}
        except Exception as e:
            self.crud.rollback()
            raise AdvancedTablePageServiceError(str(e), 500) from e

    def batch_delete(self, data):
        ids = data.get('ids') or []
        if not isinstance(ids, list) or not ids:
            raise AdvancedTablePageServiceError('请先选择要删除的数据')

        items = self.crud.list_by_ids(ids).all()
        if not items:
            raise AdvancedTablePageServiceError('未找到可删除的数据')

        protected = [item for item in items if is_enabled_for_delete(item)]
        if protected:
            raise AdvancedTablePageServiceError(
                f'选中的 {len(protected)} 条记录仍处于启用状态，请先停用后再删除',
                409,
            )

        try:
            for item in items:
                self.crud.delete(item)
            self.crud.commit()
            return {'message': f'已删除 {len(items)} 条记录'}
        except Exception as e:
            self.crud.rollback()
            raise AdvancedTablePageServiceError(str(e), 500) from e
