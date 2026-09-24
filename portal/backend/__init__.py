"""
Backend 包初始化
"""
from flask_sqlalchemy import SQLAlchemy

# 全局数据库实例
db = SQLAlchemy()

__all__ = ['db']
