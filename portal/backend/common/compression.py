# -*- coding: utf-8 -*-
"""响应压缩工具"""

import gzip
from functools import wraps
from io import BytesIO

from flask import Response, request


def gzip_response(f):
    """压缩响应装饰器"""

    @wraps(f)
    def decorated_function(*args, **kwargs):
        accept_encoding = request.headers.get('Accept-Encoding', '')
        response = f(*args, **kwargs)

        if not isinstance(response, Response):
            from flask import current_app

            response = current_app.make_response(response)

        if 'gzip' not in accept_encoding.lower():
            return response

        data = response.get_data()
        if len(data) < 1024:
            return response

        gzip_buffer = BytesIO()
        with gzip.GzipFile(mode='wb', fileobj=gzip_buffer, compresslevel=6) as gzip_file:
            gzip_file.write(data)

        gzip_data = gzip_buffer.getvalue()
        response.set_data(gzip_data)
        response.headers['Content-Encoding'] = 'gzip'
        response.headers['Content-Length'] = len(gzip_data)
        response.headers['Vary'] = 'Accept-Encoding'

        return response

    return decorated_function
