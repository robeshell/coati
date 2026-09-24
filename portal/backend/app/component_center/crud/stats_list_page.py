# -*- coding: utf-8 -*-
"""带统计的列表页 CRUD 层"""


class StatsListPageCRUD:
    def __init__(self, db, stats_item_model):
        self.db = db
        self.StatsItem = stats_item_model

    def query(self):
        return self.StatsItem.query

    def get_or_404(self, item_id):
        return self.StatsItem.query.get_or_404(item_id)

    def get_by_code(self, item_code):
        return self.StatsItem.query.filter_by(item_code=item_code).first()

    def list_by_ids(self, ids):
        return self.StatsItem.query.filter(self.StatsItem.id.in_(ids))

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
