# -*- coding: utf-8 -*-
"""公告管理模型定义"""

from datetime import datetime


def build_announcement_models(db):

    class Announcement(db.Model):
        __tablename__ = 'announcements'

        id = db.Column(db.Integer, primary_key=True)
        title = db.Column(db.String(100), nullable=False)
        content = db.Column(db.Text, nullable=True)
        announce_type = db.Column(db.String(20), nullable=False, default='system')  # system/activity/update
        status = db.Column(db.String(20), nullable=False, default='draft')  # draft/published
        is_top = db.Column(db.Boolean, default=False)
        sort_order = db.Column(db.Integer, default=0)
        publish_at = db.Column(db.DateTime, nullable=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'title': self.title,
                'content': self.content,
                'announce_type': self.announce_type,
                'status': self.status,
                'is_top': self.is_top,
                'sort_order': self.sort_order,
                'publish_at': self.publish_at.isoformat() if self.publish_at else None,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

    return {'Announcement': Announcement}
