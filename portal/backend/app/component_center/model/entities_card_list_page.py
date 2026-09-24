# -*- coding: utf-8 -*-
"""卡片列表页模型定义"""

from datetime import datetime


def build_card_list_page_model(db):
    class CardItem(db.Model):
        __tablename__ = 'card_items'

        id = db.Column(db.Integer, primary_key=True)
        title = db.Column(db.String(120), nullable=False)
        card_code = db.Column(db.String(120), nullable=False, unique=True)
        subtitle = db.Column(db.String(200))
        category = db.Column(db.String(50), default='general')
        cover_url = db.Column(db.String(500))
        tag = db.Column(db.String(50))
        status = db.Column(db.String(20), default='draft', nullable=False)
        owner = db.Column(db.String(100))
        priority = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)
        description = db.Column(db.Text)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'title': self.title,
                'card_code': self.card_code,
                'subtitle': self.subtitle,
                'category': self.category,
                'cover_url': self.cover_url,
                'tag': self.tag,
                'status': self.status or 'draft',
                'owner': self.owner,
                'priority': self.priority if self.priority is not None else 0,
                'is_active': self.is_active,
                'description': self.description,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

    return {'CardItem': CardItem}
