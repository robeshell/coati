# -*- coding: utf-8 -*-
"""卡片列表页 CRUD 层"""


class CardListPageCRUD:
    def __init__(self, db, card_item_model):
        self.db = db
        self.CardItem = card_item_model

    def query(self):
        return self.CardItem.query

    def get_or_404(self, item_id):
        return self.CardItem.query.get_or_404(item_id)

    def get_by_code(self, card_code):
        return self.CardItem.query.filter_by(card_code=card_code).first()

    def list_by_ids(self, ids):
        return self.CardItem.query.filter(self.CardItem.id.in_(ids))

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
