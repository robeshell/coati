# -*- coding: utf-8 -*-
"""通知数据访问层。"""

from sqlalchemy import or_


class NotificationCRUD:
    def __init__(self, db, models):
        self.db = db
        self.Notification = models['Notification']
        self.NotificationRead = models['NotificationRead']
        self.Admin = models['Admin']

    def visible_query(self, user_id):
        return self.Notification.query.filter(or_(
            self.Notification.is_global.is_(True), self.Notification.user_id == user_id,
        ))

    def read_ids_query(self, user_id):
        return self.db.session.query(self.NotificationRead.notification_id).filter(
            self.NotificationRead.user_id == user_id
        )

    def page(self, user_id, page, per_page, is_read_filter):
        query = self.visible_query(user_id)
        read_ids = self.read_ids_query(user_id).subquery()
        if is_read_filter == 'true':
            query = query.filter(self.Notification.id.in_(read_ids))
        elif is_read_filter == 'false':
            query = query.filter(self.Notification.id.notin_(read_ids))
        return query.order_by(self.Notification.created_at.desc()).paginate(
            page=page, per_page=per_page, error_out=False,
        )

    def read_set(self, user_id, notification_ids):
        if not notification_ids:
            return set()
        rows = self.NotificationRead.query.filter(
            self.NotificationRead.notification_id.in_(notification_ids),
            self.NotificationRead.user_id == user_id,
        ).all()
        return {row.notification_id for row in rows}

    def visible_item(self, user_id, notification_id):
        return self.visible_query(user_id).filter(self.Notification.id == notification_id).first()

    def unread_items(self, user_id):
        read_ids = self.read_ids_query(user_id).subquery()
        return self.visible_query(user_id).filter(self.Notification.id.notin_(read_ids)).all()

    def unread_count(self, user_id):
        read_ids = self.read_ids_query(user_id).subquery()
        return self.visible_query(user_id).filter(self.Notification.id.notin_(read_ids)).count()

    def read_record(self, user_id, notification_id):
        return self.NotificationRead.query.filter_by(user_id=user_id, notification_id=notification_id).first()

    def user_exists(self, user_id):
        return bool(self.Admin.query.get(user_id))

    def add(self, row):
        self.db.session.add(row)

    def delete(self, row):
        self.db.session.delete(row)

    def commit(self):
        try:
            self.db.session.commit()
        except Exception:
            self.db.session.rollback()
            raise
