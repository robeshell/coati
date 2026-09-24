# -*- coding: utf-8 -*-
"""通知消息模型定义"""

from datetime import datetime


def build_notification_models(db):

    class Notification(db.Model):
        __tablename__ = 'notifications'

        id = db.Column(db.Integer, primary_key=True)
        title = db.Column(db.String(200), nullable=False)
        content = db.Column(db.Text, nullable=True)
        noti_type = db.Column(db.String(20), nullable=False, default='info')  # info/warning/success/error
        link = db.Column(db.String(500), nullable=True)  # optional navigation path
        is_global = db.Column(db.Boolean, default=True)  # True = all users, False = specific user
        user_id = db.Column(db.Integer, db.ForeignKey('admin_users.id', ondelete='CASCADE'), nullable=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

        reads = db.relationship('NotificationRead', backref='notification', cascade='all, delete-orphan', lazy='dynamic')

        def to_dict(self, is_read=False):
            return {
                'id': self.id,
                'title': self.title,
                'content': self.content,
                'noti_type': self.noti_type,
                'link': self.link,
                'is_global': self.is_global,
                'user_id': self.user_id,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'is_read': is_read,
            }

    class NotificationRead(db.Model):
        __tablename__ = 'notification_reads'

        id = db.Column(db.Integer, primary_key=True)
        notification_id = db.Column(db.Integer, db.ForeignKey('notifications.id', ondelete='CASCADE'), nullable=False)
        user_id = db.Column(db.Integer, db.ForeignKey('admin_users.id', ondelete='CASCADE'), nullable=False)
        read_at = db.Column(db.DateTime, default=datetime.utcnow)

        __table_args__ = (db.UniqueConstraint('notification_id', 'user_id'),)

    return {
        'Notification': Notification,
        'NotificationRead': NotificationRead,
    }
