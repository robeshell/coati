# -*- coding: utf-8 -*-
"""树形列表页 CRUD 层"""


class TreeListPageCRUD:
    def __init__(self, db, tree_node_model):
        self.db = db
        self.TreeNode = tree_node_model

    def query(self):
        return self.TreeNode.query

    def get_or_404(self, item_id):
        return self.TreeNode.query.get_or_404(item_id)

    def get_by_code(self, node_code):
        return self.TreeNode.query.filter_by(node_code=node_code).first()

    def list_by_ids(self, ids):
        return self.TreeNode.query.filter(self.TreeNode.id.in_(ids))

    def list_roots(self):
        return self.TreeNode.query.filter_by(parent_id=None)

    def list_children(self, parent_id):
        return self.TreeNode.query.filter_by(parent_id=parent_id)

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
