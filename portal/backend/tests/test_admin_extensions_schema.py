# -*- coding: utf-8 -*-
"""公告、通知等扩展管理能力的输入边界测试。"""

import pytest

from backend.app.admin.schema.announcement import AnnouncementSchemaError, normalize_announcement
from backend.app.admin.schema.notification import NotificationSchemaError, normalize_notification
from backend.app.admin.schema.scheduled_task import ScheduledTaskSchemaError, validate_request_url


def test_notification_requires_real_target_for_private_message():
    with pytest.raises(NotificationSchemaError, match='指定用户'):
        normalize_notification({'title': '测试', 'is_global': False})


@pytest.mark.parametrize('link', ['https://evil.example', '//evil.example/path', 'javascript:alert(1)'])
def test_notification_only_accepts_internal_link(link):
    with pytest.raises(NotificationSchemaError, match='内部路径'):
        normalize_notification({'title': '测试', 'link': link})


def test_announcement_partial_update_is_strict():
    assert normalize_announcement({'is_top': False}, partial=True) == {'is_top': False}
    with pytest.raises(AnnouncementSchemaError, match='状态'):
        normalize_announcement({'status': 'deleted'}, partial=True)


def test_scheduled_task_rejects_url_credentials_and_non_global_ip():
    with pytest.raises(ScheduledTaskSchemaError, match='用户名或密码'):
        validate_request_url('https://user:pass@example.com/task')
    with pytest.raises(ScheduledTaskSchemaError, match='内网'):
        validate_request_url('http://192.0.2.1/task')
