# -*- coding: utf-8 -*-
"""公告输入校验。"""

from datetime import datetime


class AnnouncementSchemaError(ValueError):
    pass


def normalize_announcement(data, *, partial=False):
    data = data or {}
    out = {}
    if not partial or 'title' in data:
        title = str(data.get('title') or '').strip()
        if not title:
            raise AnnouncementSchemaError('标题不能为空')
        if len(title) > 100:
            raise AnnouncementSchemaError('标题不能超过 100 个字符')
        out['title'] = title
    if not partial or 'content' in data:
        content = str(data.get('content') or '')
        if len(content) > 50000:
            raise AnnouncementSchemaError('内容不能超过 50000 个字符')
        out['content'] = content
    if not partial or 'announce_type' in data:
        value = str(data.get('announce_type') or 'system').strip()
        if value not in {'system', 'activity', 'update'}:
            raise AnnouncementSchemaError('公告类型不合法')
        out['announce_type'] = value
    if not partial or 'status' in data:
        value = str(data.get('status') or 'draft').strip()
        if value not in {'draft', 'published'}:
            raise AnnouncementSchemaError('公告状态不合法')
        out['status'] = value
    if not partial or 'is_top' in data:
        value = data.get('is_top', False)
        if not isinstance(value, bool):
            raise AnnouncementSchemaError('置顶状态必须是布尔值')
        out['is_top'] = value
    if not partial or 'sort_order' in data:
        try:
            value = int(data.get('sort_order') or 0)
        except (TypeError, ValueError) as exc:
            raise AnnouncementSchemaError('排序权重必须是整数') from exc
        if not -100000 <= value <= 100000:
            raise AnnouncementSchemaError('排序权重超出范围')
        out['sort_order'] = value
    if 'publish_at' in data:
        raw = data.get('publish_at')
        if not raw:
            out['publish_at'] = None
        else:
            try:
                out['publish_at'] = datetime.fromisoformat(str(raw).replace('Z', '+00:00'))
            except ValueError as exc:
                raise AnnouncementSchemaError('发布时间格式不合法') from exc
    return out
