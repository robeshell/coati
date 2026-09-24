# -*- coding: utf-8 -*-
"""详情标签页 service 层"""

from datetime import date

from backend.app.component_center.crud.detail_tabs_page import DetailTabsPageCRUD
from backend.app.component_center.schema.detail_tabs_page import (
    STATUS_VALUES,
    parse_bool,
    parse_int,
)
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete


class DetailTabsPageServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class DetailTabsPageService:
    def __init__(self, db, member_model):
        self.db = db
        self.DetailMember = member_model
        self.crud = DetailTabsPageCRUD(db, member_model)

    def _parse_date(self, value):
        if not value:
            return None
        if isinstance(value, date):
            return value
        try:
            return date.fromisoformat(str(value)[:10])
        except ValueError:
            return None

    # ── 成员 ─────────────────────────────────────────────────────────────

    def get_all_members(self, search=None):
        members = self.crud.all_members(search=search)
        return [m.to_dict() for m in members]

    def get_member(self, member_id):
        member = self.crud.get_member_or_404(member_id)
        return member.to_dict()

    def create_member(self, data):
        name = str(data.get('name') or '').strip()
        if not name:
            raise DetailTabsPageServiceError('姓名不能为空')

        status = str(data.get('status') or 'active').strip()
        if status not in STATUS_VALUES:
            status = 'active'

        member = self.DetailMember(
            name=name,
            department=str(data.get('department') or '').strip() or None,
            role_title=str(data.get('role_title') or '').strip() or None,
            email=str(data.get('email') or '').strip() or None,
            phone=str(data.get('phone') or '').strip() or None,
            status=status,
            join_date=self._parse_date(data.get('join_date')),
            avatar_color=str(data.get('avatar_color') or '#4080FF').strip() or '#4080FF',
            bio=str(data.get('bio') or '').strip() or None,
            sort_order=parse_int(data.get('sort_order'), default=0),
            is_active=parse_bool(data.get('is_active'), default=True),
        )
        try:
            self.crud.add(member)
            self.crud.commit()
            return member.to_dict(), 201
        except Exception as e:
            self.crud.rollback()
            raise DetailTabsPageServiceError(str(e), 500) from e

    def update_member(self, member, data):
        if 'name' in data and not str(data.get('name') or '').strip():
            raise DetailTabsPageServiceError('姓名不能为空')

        field_map = {
            'name':         lambda v: str(v or '').strip(),
            'department':   lambda v: str(v or '').strip() or None,
            'role_title':   lambda v: str(v or '').strip() or None,
            'email':        lambda v: str(v or '').strip() or None,
            'phone':        lambda v: str(v or '').strip() or None,
            'avatar_color': lambda v: str(v or '#4080FF').strip() or '#4080FF',
            'bio':          lambda v: str(v or '').strip() or None,
            'sort_order':   lambda v: parse_int(v, default=member.sort_order or 0),
            'is_active':    lambda v: parse_bool(v, default=member.is_active),
        }
        for field, converter in field_map.items():
            if field in data:
                setattr(member, field, converter(data[field]))

        if 'status' in data:
            s = str(data['status'] or 'active').strip()
            member.status = s if s in STATUS_VALUES else 'active'

        if 'join_date' in data:
            member.join_date = self._parse_date(data['join_date'])

        try:
            self.crud.commit()
            return member.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise DetailTabsPageServiceError(str(e), 500) from e

    def delete_member(self, member):
        if is_enabled_for_delete(member):
            raise DetailTabsPageServiceError(enabled_delete_message('成员'), 409)
        try:
            self.crud.delete(member)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise DetailTabsPageServiceError(str(e), 500) from e
