# -*- coding: utf-8 -*-
"""角色模块 CRUD 层"""


class RoleCRUD:
    def __init__(self, db, role_model, menu_model):
        self.db = db
        self.Role = role_model
        self.Menu = menu_model

    def query_roles(self):
        return self.Role.query

    def get_role_or_404(self, role_id):
        return self.Role.query.get_or_404(role_id)

    def get_role_by_code(self, code):
        return self.Role.query.filter_by(code=code).first()

    def list_roles_by_ids(self, ids):
        return self.Role.query.filter(self.Role.id.in_(ids))

    def list_menus_by_ids(self, ids):
        if not ids:
            return []
        return self.Menu.query.filter(self.Menu.id.in_(ids)).all()

    def list_menus_by_codes(self, codes):
        if not codes:
            return []
        return self.Menu.query.filter(self.Menu.code.in_(codes)).all()

    def add_role(self, role):
        self.db.session.add(role)

    def delete_role(self, role):
        self.db.session.delete(role)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
