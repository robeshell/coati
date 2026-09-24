# -*- coding: utf-8 -*-
"""高级表格页模型定义"""

from datetime import datetime


def build_advanced_table_page_model(db):
    class AdvancedTableRow(db.Model):
        __tablename__ = 'cc_advanced_table_rows'

        id = db.Column(db.Integer, primary_key=True)
        row_code = db.Column(db.String(80), nullable=False, unique=True)
        name = db.Column(db.String(120), nullable=False)
        category = db.Column(db.String(50), default='general')
        owner = db.Column(db.String(100))
        status = db.Column(db.String(20), default='draft', nullable=False)
        priority = db.Column(db.Integer, default=0)
        progress = db.Column(db.Integer, default=0)
        score = db.Column(db.Numeric(7, 2), default=0)
        tags = db.Column(db.String(255))
        is_active = db.Column(db.Boolean, default=True)
        is_pinned = db.Column(db.Boolean, default=False)
        due_date = db.Column(db.Date)
        sort_order = db.Column(db.Integer, default=0)
        remark = db.Column(db.Text)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'row_code': self.row_code,
                'name': self.name,
                'category': self.category,
                'owner': self.owner,
                'status': self.status or 'draft',
                'priority': self.priority if self.priority is not None else 0,
                'progress': self.progress if self.progress is not None else 0,
                'score': float(self.score) if self.score is not None else 0.0,
                'tags': self.tags or '',
                'is_active': self.is_active,
                'is_pinned': self.is_pinned,
                'due_date': self.due_date.isoformat() if self.due_date else None,
                'sort_order': self.sort_order if self.sort_order is not None else 0,
                'remark': self.remark,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

    return {'AdvancedTableRow': AdvancedTableRow}
