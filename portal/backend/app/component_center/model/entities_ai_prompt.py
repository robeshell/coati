# -*- coding: utf-8 -*-
"""AI 提示词模板模型定义"""

from datetime import datetime


def build_ai_prompt_models(db):
    class AiPromptTemplate(db.Model):
        __tablename__ = 'ai_prompt_templates'

        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(120), nullable=False)
        category = db.Column(db.String(50), default='custom')
        description = db.Column(db.Text)
        content = db.Column(db.Text, nullable=False)
        # 变量定义：JSON 数组，例如 ["requirement", "target_users"]
        variables = db.Column(db.JSON, default=list)
        # 标签：逗号分隔字符串，例如 "产品,需求"
        tags = db.Column(db.String(500), default='')
        is_active = db.Column(db.Boolean, default=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            tag_list = []
            if self.tags:
                tag_list = [t.strip() for t in self.tags.split(',') if t.strip()]
            return {
                'id': self.id,
                'name': self.name,
                'category': self.category or 'custom',
                'description': self.description,
                'content': self.content,
                'variables': self.variables if isinstance(self.variables, list) else [],
                'tags': tag_list,
                'is_active': self.is_active if self.is_active is not None else True,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

    return {'AiPromptTemplate': AiPromptTemplate}
