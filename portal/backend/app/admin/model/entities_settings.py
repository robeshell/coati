# -*- coding: utf-8 -*-
"""系统设置模型定义"""

from datetime import datetime


def build_settings_models(db):
    class AppSetting(db.Model):
        """通用 key-value 系统设置项（数据库优先，环境变量兜底）"""

        __tablename__ = 'app_settings'

        id = db.Column(db.Integer, primary_key=True)
        key = db.Column(db.String(100), nullable=False, unique=True)
        value = db.Column(db.Text)
        description = db.Column(db.String(200))
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'key': self.key,
                'value': self.value,
                'description': self.description,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

    return {'AppSetting': AppSetting}
