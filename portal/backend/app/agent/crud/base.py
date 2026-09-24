"""Agent CRUD 事务基类。"""


class AgentCRUDBase:
    def __init__(self, db, models):
        self.db = db
        self.models = models

    def add(self, row):
        self.db.session.add(row)
        self.commit()
        return row

    def add_pending(self, row):
        """加入当前事务但不立即提交，供需要批量物化的 service 使用。"""
        self.db.session.add(row)
        return row

    def delete(self, row):
        self.db.session.delete(row)
        self.commit()

    def commit(self):
        try:
            self.db.session.commit()
        except Exception:
            self.db.session.rollback()
            raise

    def rollback(self):
        self.db.session.rollback()
