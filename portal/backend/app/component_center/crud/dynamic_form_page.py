# -*- coding: utf-8 -*-
"""动态表单页 CRUD 层"""


class DynamicFormPageCRUD:
    def __init__(self, db, record_model, field_model):
        self.db = db
        self.DynamicFormRecord = record_model
        self.DynamicFormField = field_model

    def query(self):
        return self.DynamicFormRecord.query

    def get_or_404(self, item_id):
        return self.DynamicFormRecord.query.get_or_404(item_id)

    def get_by_code(self, record_code):
        return self.DynamicFormRecord.query.filter_by(record_code=record_code).first()

    def list_by_ids(self, ids):
        return self.DynamicFormRecord.query.filter(self.DynamicFormRecord.id.in_(ids))

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def delete_fields_by_record(self, record_id):
        self.DynamicFormField.query.filter_by(record_id=record_id).delete()

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
