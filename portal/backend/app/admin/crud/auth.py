# -*- coding: utf-8 -*-
"""认证模块 CRUD 层"""


class AuthCRUD:
    def __init__(self, db, admin_model, login_log_model, operation_log_model):
        self.db = db
        self.Admin = admin_model
        self.LoginLog = login_log_model
        self.OperationLog = operation_log_model

    def get_admin_by_username(self, username):
        return self.Admin.query.filter_by(username=username).first()

    def add_login_log(self, item):
        self.db.session.add(item)

    def add_operation_log(self, item):
        self.db.session.add(item)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
