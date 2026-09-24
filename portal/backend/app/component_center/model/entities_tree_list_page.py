# -*- coding: utf-8 -*-
"""树形列表页模型定义"""

from datetime import datetime


def build_tree_list_page_model(db):
    class TreeNode(db.Model):
        __tablename__ = 'tree_nodes'

        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(100), nullable=False)
        node_code = db.Column(db.String(120), nullable=False, unique=True)
        parent_id = db.Column(db.Integer, db.ForeignKey('tree_nodes.id', ondelete='SET NULL'), nullable=True)
        node_type = db.Column(db.String(50), default='category')
        icon = db.Column(db.String(100))
        description = db.Column(db.Text)
        sort_order = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)
        status = db.Column(db.String(20), default='active', nullable=False)
        owner = db.Column(db.String(100))
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        children = db.relationship(
            'TreeNode',
            backref=db.backref('parent', remote_side=[id]),
            lazy='dynamic',
            foreign_keys=[parent_id],
        )

        def to_dict(self):
            return {
                'id': self.id,
                'name': self.name,
                'node_code': self.node_code,
                'parent_id': self.parent_id,
                'node_type': self.node_type or 'category',
                'icon': self.icon,
                'description': self.description,
                'sort_order': self.sort_order if self.sort_order is not None else 0,
                'is_active': self.is_active,
                'status': self.status or 'active',
                'owner': self.owner,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

        def to_tree_dict(self):
            """包含子节点列表（浅层，不递归）的 dict"""
            d = self.to_dict()
            d['children_count'] = self.children.count()
            return d

    return {'TreeNode': TreeNode}
