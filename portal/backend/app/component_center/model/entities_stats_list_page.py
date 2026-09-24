# -*- coding: utf-8 -*-
"""带统计的列表页模型定义"""

from datetime import datetime


def build_stats_list_page_model(db):
    class StatsItem(db.Model):
        __tablename__ = 'stats_items'

        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(120), nullable=False)
        item_code = db.Column(db.String(120), nullable=False, unique=True)
        category = db.Column(db.String(50), default='general')
        status = db.Column(db.String(20), default='draft', nullable=False)
        amount = db.Column(db.Numeric(14, 2), default=0)
        quantity = db.Column(db.Integer, default=0)
        owner = db.Column(db.String(100))
        priority = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)
        description = db.Column(db.Text)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'name': self.name,
                'item_code': self.item_code,
                'category': self.category,
                'status': self.status or 'draft',
                'amount': float(self.amount) if self.amount is not None else 0.0,
                'quantity': self.quantity if self.quantity is not None else 0,
                'owner': self.owner,
                'priority': self.priority if self.priority is not None else 0,
                'is_active': self.is_active,
                'description': self.description,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

    return {'StatsItem': StatsItem}
