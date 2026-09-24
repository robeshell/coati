# -*- coding: utf-8 -*-
"""数据字典 CRUD 层"""


class DictsCRUD:
    def __init__(self, db, dict_type_model, dict_item_model):
        self.db = db
        self.DictType = dict_type_model
        self.DictItem = dict_item_model

    def query_dict_types(self):
        return self.DictType.query

    def get_dict_type_or_404(self, dict_id):
        return self.DictType.query.get_or_404(dict_id)

    def get_dict_type(self, dict_id):
        return self.DictType.query.get(dict_id)

    def get_dict_type_by_code(self, code):
        return self.DictType.query.filter_by(code=code).first()

    def list_active_dict_types_by_codes(self, codes):
        return self.DictType.query.filter(
            self.DictType.code.in_(codes),
            self.DictType.is_active.is_(True),
        ).all()

    def query_dict_items(self):
        return self.DictItem.query

    def get_dict_item_or_404(self, item_id):
        return self.DictItem.query.get_or_404(item_id)

    def get_dict_item_by_type_value(self, dict_type_id, value):
        return self.DictItem.query.filter_by(dict_type_id=dict_type_id, value=value).first()

    def list_items_by_type_id(self, dict_type_id):
        return self.DictItem.query.filter_by(dict_type_id=dict_type_id)

    def get_item_duplicate(self, dict_type_id, value, exclude_id):
        return self.DictItem.query.filter(
            self.DictItem.dict_type_id == dict_type_id,
            self.DictItem.value == value,
            self.DictItem.id != exclude_id,
        ).first()

    def clear_default_by_type_and_exclude_id(self, dict_type_id, exclude_id):
        self.DictItem.query.filter(
            self.DictItem.dict_type_id == dict_type_id,
            self.DictItem.id != exclude_id,
            self.DictItem.is_default.is_(True),
        ).update({'is_default': False})

    def clear_default_by_type_and_keep_value(self, dict_type_id, keep_value):
        self.DictItem.query.filter(
            self.DictItem.dict_type_id == dict_type_id,
            self.DictItem.value != keep_value,
            self.DictItem.is_default.is_(True),
        ).update({'is_default': False})

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
