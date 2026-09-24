# -*- coding: utf-8 -*-
"""高级表格页 CRUD 层"""


class AdvancedTablePageCRUD:
    def __init__(self, db, row_model):
        self.db = db
        self.AdvancedTableRow = row_model

    def query(self):
        return self.AdvancedTableRow.query

    def get_or_404(self, item_id):
        return self.AdvancedTableRow.query.get_or_404(item_id)

    def get_by_code(self, row_code):
        return self.AdvancedTableRow.query.filter_by(row_code=row_code).first()

    def list_by_ids(self, ids):
        return self.AdvancedTableRow.query.filter(self.AdvancedTableRow.id.in_(ids))

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
