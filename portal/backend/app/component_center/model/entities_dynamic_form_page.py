# -*- coding: utf-8 -*-
"""动态表单页模型定义"""

from datetime import datetime


def build_dynamic_form_page_model(db):
    class DynamicFormField(db.Model):
        __tablename__ = 'dynamic_form_fields'

        id = db.Column(db.Integer, primary_key=True)
        record_id = db.Column(db.Integer, db.ForeignKey('dynamic_form_records.id', ondelete='CASCADE'), nullable=False)
        field_key = db.Column(db.String(100))
        field_value = db.Column(db.String(500))
        field_type = db.Column(db.String(50), default='text')
        sort_order = db.Column(db.Integer, default=0)
        remark = db.Column(db.String(200))
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'record_id': self.record_id,
                'field_key': self.field_key or '',
                'field_value': self.field_value or '',
                'field_type': self.field_type or 'text',
                'sort_order': self.sort_order if self.sort_order is not None else 0,
                'remark': self.remark or '',
                'created_at': self.created_at.isoformat() if self.created_at else None,
            }

    class DynamicFormRecord(db.Model):
        __tablename__ = 'dynamic_form_records'

        id = db.Column(db.Integer, primary_key=True)
        title = db.Column(db.String(120), nullable=False)
        record_code = db.Column(db.String(120), nullable=False, unique=True)
        category = db.Column(db.String(50), default='general')
        status = db.Column(db.String(20), default='draft', nullable=False)
        owner = db.Column(db.String(100))
        priority = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)
        description = db.Column(db.Text)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        fields = db.relationship(
            'DynamicFormField',
            backref='record',
            cascade='all, delete-orphan',
            order_by='DynamicFormField.sort_order',
            lazy='dynamic',
        )

        def to_dict(self, include_fields=False):
            d = {
                'id': self.id,
                'title': self.title,
                'record_code': self.record_code,
                'category': self.category or 'general',
                'status': self.status or 'draft',
                'owner': self.owner,
                'priority': self.priority if self.priority is not None else 0,
                'is_active': self.is_active,
                'description': self.description,
                'fields_count': self.fields.count(),
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }
            if include_fields:
                d['fields'] = [f.to_dict() for f in self.fields.order_by(DynamicFormField.sort_order).all()]
            return d

    return {'DynamicFormRecord': DynamicFormRecord, 'DynamicFormField': DynamicFormField}
