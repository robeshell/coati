# -*- coding: utf-8 -*-
"""
TODO: 替换 <Resource> 为实际模型类名（大驼峰，如 Customer）
TODO: 替换 <resource> 为资源名（下划线，如 customer）
TODO: 替换 <table_name> 为数据库表名（复数下划线，如 customers）
"""

from datetime import datetime


def build_<resource>_models(db):

    class <Resource>(db.Model):
        __tablename__ = '<table_name>'

        id = db.Column(db.Integer, primary_key=True)

        # TODO: 替换为实际字段，参考字段类型推断规则（见 AGENTS.md）
        name = db.Column(db.String(100), nullable=False)
        # status = db.Column(db.String(20), nullable=False, default='active')
        # description = db.Column(db.Text)
        # sort_order = db.Column(db.Integer, default=0)

        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                # TODO: 补充实际字段
                'name': self.name,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

    return {'<Resource>': <Resource>}
