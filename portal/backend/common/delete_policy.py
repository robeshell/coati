# -*- coding: utf-8 -*-
"""删除前置策略。

删除请求最终必须在服务层校验，不能只依赖前端按钮状态或确认弹窗。
"""


def is_enabled_for_delete(item):
    """返回记录是否仍处于启用状态。

    不同模块历史上分别使用 ``enabled`` 和 ``is_active``。没有这两个字段的
    记录不受本规则限制；字段存在但值为 ``None`` 时按启用处理，采用安全失败。
    """
    for field in ('enabled', 'is_active'):
        if hasattr(item, field) and getattr(item, field) is not False:
            return True
    return False


def enabled_delete_message(label='记录'):
    return f'启用中的{label}不能删除，请先停用后再删除'
