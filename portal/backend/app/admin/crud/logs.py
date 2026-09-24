# -*- coding: utf-8 -*-
"""日志模块 CRUD 层"""


class LogsCRUD:
    def __init__(self, db, admin_model, login_log_model, operation_log_model):
        self.db = db
        self.Admin = admin_model
        self.LoginLog = login_log_model
        self.OperationLog = operation_log_model

    def get_admin_by_username(self, username):
        return self.Admin.query.filter_by(username=username).first()

    def query_login_logs(self):
        return self.LoginLog.query

    def query_operation_logs(self):
        return self.OperationLog.query

    def list_login_logs_by_ids(self, ids):
        return self.LoginLog.query.filter(self.LoginLog.id.in_(ids))

    def list_operation_logs_by_ids(self, ids):
        return self.OperationLog.query.filter(self.OperationLog.id.in_(ids))

    def add(self, item):
        self.db.session.add(item)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
