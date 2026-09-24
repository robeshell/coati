# -*- coding: utf-8 -*-
"""
TODO: 替换 <Resource> 为模型类名
TODO: 替换 <resource> 为资源名（下划线）
"""


class <Resource>CRUD:
    def __init__(self, db, model):
        self.db = db
        self.<Resource> = model

    def query_all(self):
        return self.<Resource>.query

    def get_or_404(self, item_id):
        return self.<Resource>.query.get_or_404(item_id)

    def get_by_name(self, name):
        return self.<Resource>.query.filter_by(name=name).first()

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
