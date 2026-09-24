# -*- coding: utf-8 -*-
"""详情标签页 CRUD 层"""


class DetailTabsPageCRUD:
    def __init__(self, db, member_model):
        self.db = db
        self.DetailMember = member_model

    def all_members(self, search=None):
        q = self.DetailMember.query
        if search:
            like = f'%{search}%'
            q = q.filter(
                self.DetailMember.name.ilike(like)
                | self.DetailMember.department.ilike(like)
                | self.DetailMember.role_title.ilike(like)
            )
        return q.order_by(self.DetailMember.sort_order).all()

    def get_member_or_404(self, member_id):
        return self.DetailMember.query.get_or_404(member_id)

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def flush(self):
        self.db.session.flush()

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
