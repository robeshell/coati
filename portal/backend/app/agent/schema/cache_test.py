# -*- coding: utf-8 -*-
"""缓存命中率测试参数校验。"""

from .common import AgentValidationError, integer, text


def normalize_cache_test_payload(data):
    """运行缓存测试的入参：name/model/prompt/rounds/max_tokens。

    rounds 上限 5：每轮都会真实调用上游并计入配额，防止长时间同步请求。
    max_tokens 上限 512：缓存命中效果由 prompt 前缀决定，输出 token 足够小即可对比。
    """
    data = data or {}
    return {
        'name': text(data.get('name'), '测试名称', required=True, max_length=100),
        'model': text(data.get('model'), '模型', required=True, max_length=128),
        'prompt': text(data.get('prompt'), 'Prompt 内容', required=True, max_length=200000),
        'rounds': integer(data.get('rounds'), '轮数', minimum=1, maximum=5, default=3),
        'max_tokens': integer(data.get('max_tokens'), '最大输出 Token', minimum=1, maximum=512, default=32),
    }


__all__ = ['AgentValidationError', 'normalize_cache_test_payload']
