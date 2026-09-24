# -*- coding: utf-8 -*-
"""列表页 CRUD 层"""


class ListPageCRUD:
    def __init__(self, db, query_model, version_model):
        self.db = db
        self.QueryManagement = query_model
        self.QueryManagementVersion = version_model

    def query(self):
        return self.QueryManagement.query

    def get_or_404(self, item_id):
        return self.QueryManagement.query.get_or_404(item_id)

    def get_by_code(self, query_code):
        return self.QueryManagement.query.filter_by(query_code=query_code).first()

    def list_by_ids(self, ids):
        return self.QueryManagement.query.filter(self.QueryManagement.id.in_(ids))

    def add(self, item):
        self.db.session.add(item)

    def add_version(self, version_item):
        self.db.session.add(version_item)

    def version_query(self):
        return self.QueryManagementVersion.query

    def get_version_or_404(self, version_id):
        return self.QueryManagementVersion.query.get_or_404(version_id)

    def delete(self, item):
        self.db.session.delete(item)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
