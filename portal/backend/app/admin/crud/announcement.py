# -*- coding: utf-8 -*-
"""公告管理 CRUD 层"""


class AnnouncementCRUD:
    def __init__(self, db, model):
        self.db = db
        self.Announcement = model

    def query_all(self):
        return self.Announcement.query

    def get_or_404(self, item_id):
        return self.Announcement.query.get_or_404(item_id)

    def get(self, item_id):
        return self.Announcement.query.get(item_id)

    def page(self, page, per_page, search='', status=None, announce_type=None):
        query = self.query_all()
        if search:
            query = query.filter(self.Announcement.title.ilike(f'%{search}%'))
        if status:
            query = query.filter(self.Announcement.status == status)
        if announce_type:
            query = query.filter(self.Announcement.announce_type == announce_type)
        return query.order_by(
            self.Announcement.is_top.desc(), self.Announcement.sort_order.asc(), self.Announcement.id.desc(),
        ).paginate(page=page, per_page=per_page, error_out=False)

    def export_items(self, ids=None):
        query = self.query_all()
        if ids:
            return query.filter(self.Announcement.id.in_(ids)).order_by(self.Announcement.id.asc()).all()
        return query.order_by(self.Announcement.is_top.desc(), self.Announcement.id.desc()).all()

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
