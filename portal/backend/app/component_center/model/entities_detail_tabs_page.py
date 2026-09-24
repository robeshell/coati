# -*- coding: utf-8 -*-
"""详情标签页模型定义"""

from datetime import datetime


def build_detail_tabs_page_model(db):
    class DetailMember(db.Model):
        __tablename__ = 'cc_detail_members'

        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(100), nullable=False)
        department = db.Column(db.String(100))
        role_title = db.Column(db.String(100))
        email = db.Column(db.String(200))
        phone = db.Column(db.String(50))
        status = db.Column(db.String(20), default='active')
        join_date = db.Column(db.Date)
        avatar_color = db.Column(db.String(20), default='#4080FF')
        bio = db.Column(db.Text)
        sort_order = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'name': self.name,
                'department': self.department,
                'role_title': self.role_title,
                'email': self.email,
                'phone': self.phone,
                'status': self.status or 'active',
                'join_date': self.join_date.isoformat() if self.join_date else None,
                'avatar_color': self.avatar_color or '#4080FF',
                'bio': self.bio,
                'sort_order': self.sort_order if self.sort_order is not None else 0,
                'is_active': self.is_active,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

    return {'DetailMember': DetailMember}
