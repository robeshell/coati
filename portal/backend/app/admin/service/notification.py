# -*- coding: utf-8 -*-
"""通知业务服务。"""

from datetime import datetime

from backend.app.admin.crud.notification import NotificationCRUD
from backend.app.admin.schema.notification import NotificationSchemaError, normalize_notification


class NotificationServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class NotificationService:
    def __init__(self, db, models):
        self.Notification = models['Notification']
        self.NotificationRead = models['NotificationRead']
        self.crud = NotificationCRUD(db, models)

    def list_items(self, user_id, page=1, per_page=20, is_read_filter='all'):
        if is_read_filter not in {'all', 'true', 'false'}:
            raise NotificationServiceError('已读状态筛选值不合法')
        pagination = self.crud.page(user_id, page, per_page, is_read_filter)
        read_set = self.crud.read_set(user_id, [item.id for item in pagination.items])
        return {'items': [item.to_dict(item.id in read_set) for item in pagination.items],
                'total': pagination.total, 'page': page, 'per_page': per_page}

    def create_item(self, data):
        try:
            payload = normalize_notification(data)
        except NotificationSchemaError as exc:
            raise NotificationServiceError(str(exc)) from exc
        if payload['user_id'] and not self.crud.user_exists(payload['user_id']):
            raise NotificationServiceError('指定用户不存在')
        row = self.Notification(**payload)
        try:
            self.crud.add(row)
            self.crud.commit()
        except Exception as exc:
            raise NotificationServiceError('创建通知失败，请稍后重试', 500) from exc
        return row.to_dict(is_read=False), 201

    def unread_count(self, user_id):
        return self.crud.unread_count(user_id)

    def mark_read(self, user_id, notification_id):
        if not self.crud.visible_item(user_id, notification_id):
            raise NotificationServiceError('通知不存在或无权限', 404)
        if not self.crud.read_record(user_id, notification_id):
            try:
                self.crud.add(self.NotificationRead(notification_id=notification_id, user_id=user_id))
                self.crud.commit()
            except Exception as exc:
                raise NotificationServiceError('操作失败，请稍后重试', 500) from exc
        return {'success': True}

    def mark_all_read(self, user_id):
        unread = self.crud.unread_items(user_id)
        now = datetime.utcnow()
        try:
            for item in unread:
                self.crud.add(self.NotificationRead(notification_id=item.id, user_id=user_id, read_at=now))
            self.crud.commit()
        except Exception as exc:
            raise NotificationServiceError('操作失败，请稍后重试', 500) from exc
        return {'success': True, 'marked': len(unread)}

    def delete_item(self, user_id, notification_id, can_delete_global):
        item = self.crud.visible_item(user_id, notification_id)
        if not item:
            raise NotificationServiceError('通知不存在或无权限', 404)
        if item.is_global and not can_delete_global:
            raise NotificationServiceError('无权限删除全局通知', 403)
        try:
            self.crud.delete(item)
            self.crud.commit()
        except Exception as exc:
            raise NotificationServiceError('删除失败，请稍后重试', 500) from exc
        return {'success': True}
