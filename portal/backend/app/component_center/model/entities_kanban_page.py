# -*- coding: utf-8 -*-
"""看板页模型定义"""

from datetime import datetime


def build_kanban_page_model(db):
    class KanbanCard(db.Model):
        __tablename__ = 'kanban_cards'

        id = db.Column(db.Integer, primary_key=True)
        board_id = db.Column(
            db.Integer,
            db.ForeignKey('kanban_boards.id', ondelete='CASCADE'),
            nullable=False,
        )
        title = db.Column(db.String(200), nullable=False)
        card_code = db.Column(db.String(80), nullable=False, unique=True)
        description = db.Column(db.Text)
        priority = db.Column(db.String(20), default='medium')
        assignee = db.Column(db.String(100))
        due_date = db.Column(db.Date)
        tags = db.Column(db.String(200))
        sort_order = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'board_id': self.board_id,
                'title': self.title,
                'card_code': self.card_code,
                'description': self.description,
                'priority': self.priority or 'medium',
                'assignee': self.assignee,
                'due_date': self.due_date.isoformat() if self.due_date else None,
                'tags': self.tags or '',
                'sort_order': self.sort_order if self.sort_order is not None else 0,
                'is_active': self.is_active,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

    class KanbanBoard(db.Model):
        __tablename__ = 'kanban_boards'

        id = db.Column(db.Integer, primary_key=True)
        title = db.Column(db.String(100), nullable=False)
        board_code = db.Column(db.String(50), nullable=False, unique=True)
        color = db.Column(db.String(20), default='#4080FF')
        sort_order = db.Column(db.Integer, default=0)
        wip_limit = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        cards = db.relationship(
            'KanbanCard',
            backref='board',
            cascade='all, delete-orphan',
            order_by='KanbanCard.sort_order',
            lazy='dynamic',
        )

        def to_dict(self, include_cards=False):
            d = {
                'id': self.id,
                'title': self.title,
                'board_code': self.board_code,
                'color': self.color or '#4080FF',
                'sort_order': self.sort_order if self.sort_order is not None else 0,
                'wip_limit': self.wip_limit if self.wip_limit is not None else 0,
                'is_active': self.is_active,
                'cards_count': self.cards.count(),
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }
            if include_cards:
                d['cards'] = [c.to_dict() for c in self.cards.order_by(KanbanCard.sort_order).all()]
            return d

    return {'KanbanBoard': KanbanBoard, 'KanbanCard': KanbanCard}
