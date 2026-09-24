# -*- coding: utf-8 -*-
"""JSON 编码工具"""

import json
import math


class CustomJSONEncoder(json.JSONEncoder):
    """自定义 JSON 编码器，处理 NaN 值"""

    def default(self, obj):
        if isinstance(obj, float) and math.isnan(obj):
            return None
        try:
            return super().default(obj)
        except TypeError:
            return str(obj)
