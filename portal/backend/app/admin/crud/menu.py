# -*- coding: utf-8 -*-
"""菜单模块 CRUD 层"""


class MenuCRUD:
    def __init__(self, db, menu_model):
        self.db = db
        self.Menu = menu_model

    def query(self):
        return self.Menu.query

    def get_or_404(self, menu_id):
        return self.Menu.query.get_or_404(menu_id)

    def get_by_code(self, code):
        return self.Menu.query.filter_by(code=code).first()

    def list_all(self):
        return self.Menu.query.all()

    def list_by_ids(self, ids):
        return self.Menu.query.filter(self.Menu.id.in_(ids))

    def list_root(self):
        return self.Menu.query.filter(self.Menu.parent_id.is_(None))

    def list_by_parent(self, parent_id):
        return self.Menu.query.filter(self.Menu.parent_id == parent_id)

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def flush(self):
        self.db.session.flush()

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()

    def sync_id_sequence(self):
        if self.db.engine.dialect.name != 'postgresql':
            return
        self.db.session.execute(self.db.text("""
            SELECT setval(
                pg_get_serial_sequence('menus', 'id'),
                COALESCE((SELECT MAX(id) FROM menus), 0) + 1,
                false
            )
        """))
