# -*- coding: utf-8 -*-
"""通知输入校验。"""


class NotificationSchemaError(ValueError):
    pass


def normalize_notification(data):
    data = data or {}
    title = str(data.get('title') or '').strip()
    if not title:
        raise NotificationSchemaError('标题不能为空')
    if len(title) > 200:
        raise NotificationSchemaError('标题不能超过 200 个字符')
    content = str(data.get('content') or '').strip()
    if len(content) > 10000:
        raise NotificationSchemaError('内容不能超过 10000 个字符')
    noti_type = str(data.get('noti_type') or 'info').strip()
    if noti_type not in {'info', 'warning', 'success', 'error'}:
        raise NotificationSchemaError('通知类型不合法')
    is_global = data.get('is_global', True)
    if not isinstance(is_global, bool):
        raise NotificationSchemaError('全局通知必须是布尔值')
    user_id = None
    if not is_global:
        try:
            user_id = int(data.get('user_id'))
        except (TypeError, ValueError) as exc:
            raise NotificationSchemaError('指定用户不能为空') from exc
    link = str(data.get('link') or '').strip() or None
    if link and (not link.startswith('/') or link.startswith('//') or len(link) > 500):
        raise NotificationSchemaError('跳转链接必须是平台内部路径')
    return {
        'title': title, 'content': content or None, 'noti_type': noti_type,
        'link': link, 'is_global': is_global, 'user_id': user_id,
    }
