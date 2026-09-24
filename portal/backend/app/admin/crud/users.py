# -*- coding: utf-8 -*-
"""用户模块 CRUD 层"""


class UserCRUD:
    def __init__(self, db, admin_model, role_model):
        self.db = db
        self.Admin = admin_model
        self.Role = role_model

    def query_users(self):
        return self.Admin.query

    def get_user_or_404(self, user_id):
        return self.Admin.query.get_or_404(user_id)

    def get_user_by_username(self, username):
        return self.Admin.query.filter_by(username=username).first()

    def list_users_by_ids(self, ids):
        return self.Admin.query.filter(self.Admin.id.in_(ids))

    def list_roles_by_ids(self, ids):
        if not ids:
            return []
        return self.Role.query.filter(self.Role.id.in_(ids)).all()

    def list_roles_by_codes(self, codes):
        if not codes:
            return []
        return self.Role.query.filter(self.Role.code.in_(codes)).all()

    def add_user(self, user):
        self.db.session.add(user)

    def delete_user(self, user):
        self.db.session.delete(user)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
