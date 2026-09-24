# -*- coding: utf-8 -*-
"""数据字典模型定义"""

from datetime import datetime


def build_dict_models(db):
    class DictType(db.Model):
        __tablename__ = 'dict_types'

        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(100), nullable=False)
        code = db.Column(db.String(100), nullable=False, unique=True)
        description = db.Column(db.Text)
        sort_order = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        items = db.relationship(
            'DictItem',
            backref=db.backref('dict_type'),
            cascade='all, delete-orphan',
            lazy='dynamic',
        )

        def to_dict(self, include_items=False):
            data = {
                'id': self.id,
                'name': self.name,
                'code': self.code,
                'description': self.description,
                'sort_order': self.sort_order,
                'is_active': self.is_active,
                'item_count': self.items.count(),
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }
            if include_items:
                data['items'] = [
                    item.to_dict(include_type=False)
                    for item in self.items.order_by(DictItem.sort_order.asc(), DictItem.id.asc()).all()
                ]
            return data

    class DictItem(db.Model):
        __tablename__ = 'dict_items'
        __table_args__ = (
            db.UniqueConstraint('dict_type_id', 'value', name='uq_dict_items_type_value'),
        )

        id = db.Column(db.Integer, primary_key=True)
        dict_type_id = db.Column(db.Integer, db.ForeignKey('dict_types.id', ondelete='CASCADE'), nullable=False)
        label = db.Column(db.String(100), nullable=False)
        value = db.Column(db.String(100), nullable=False)
        color = db.Column(db.String(30))
        sort_order = db.Column(db.Integer, default=0)
        is_default = db.Column(db.Boolean, default=False)
        is_active = db.Column(db.Boolean, default=True)
        description = db.Column(db.Text)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self, include_type=True):
            data = {
                'id': self.id,
                'dict_type_id': self.dict_type_id,
                'label': self.label,
                'value': self.value,
                'color': self.color,
                'sort_order': self.sort_order,
                'is_default': self.is_default,
                'is_active': self.is_active,
                'description': self.description,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }
            if include_type and self.dict_type:
                data['dict_type_code'] = self.dict_type.code
                data['dict_type_name'] = self.dict_type.name
            return data

    return {
        'DictType': DictType,
        'DictItem': DictItem,
    }
