# -*- coding: utf-8 -*-
"""列表页模型定义"""

from datetime import datetime
import json


def build_list_page_model(db):
    def parse_json_url_list(raw):
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except Exception:
            return []
        return []

    def parse_json_object(raw, default_value):
        if not raw:
            return default_value
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return default_value
        return default_value

    class QueryManagement(db.Model):
        __tablename__ = 'query_managements'

        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(120), nullable=False)
        query_code = db.Column(db.String(120), nullable=False, unique=True)
        category = db.Column(db.String(50), default='general')
        keyword = db.Column(db.String(200))
        data_source = db.Column(db.String(100))
        owner = db.Column(db.String(100))
        image_url = db.Column(db.String(500))
        image_urls = db.Column(db.Text)
        file_url = db.Column(db.String(500))
        file_urls = db.Column(db.Text)
        priority = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)
        status = db.Column(db.String(20), default='draft', nullable=False)
        condition_logic = db.Column(db.String(10), default='AND')
        conditions_json = db.Column(db.Text)
        display_config = db.Column(db.Text)
        permission_config = db.Column(db.Text)
        schema_config = db.Column(db.Text)
        version = db.Column(db.Integer, default=1, nullable=False)
        published_at = db.Column(db.DateTime)
        description = db.Column(db.Text)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            parsed_image_urls = parse_json_url_list(self.image_urls)
            parsed_file_urls = parse_json_url_list(self.file_urls)
            if not parsed_image_urls and self.image_url:
                parsed_image_urls = [self.image_url]
            if not parsed_file_urls and self.file_url:
                parsed_file_urls = [self.file_url]

            return {
                'id': self.id,
                'name': self.name,
                'query_code': self.query_code,
                'category': self.category,
                'keyword': self.keyword,
                'data_source': self.data_source,
                'owner': self.owner,
                'image_url': self.image_url or (parsed_image_urls[0] if parsed_image_urls else None),
                'image_urls': parsed_image_urls,
                'file_url': self.file_url or (parsed_file_urls[0] if parsed_file_urls else None),
                'file_urls': parsed_file_urls,
                'priority': self.priority,
                'is_active': self.is_active,
                'status': self.status or 'draft',
                'condition_logic': self.condition_logic or 'AND',
                'conditions': parse_json_object(self.conditions_json, {'groups': [], 'items': []}),
                'display_config': parse_json_object(self.display_config, {}),
                'permission_config': parse_json_object(self.permission_config, {}),
                'schema_config': self.schema_config or '',
                'version': self.version or 1,
                'published_at': self.published_at.isoformat() if self.published_at else None,
                'description': self.description,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }

    class QueryManagementVersion(db.Model):
        __tablename__ = 'query_management_versions'

        id = db.Column(db.Integer, primary_key=True)
        query_management_id = db.Column(
            db.Integer,
            db.ForeignKey('query_managements.id', ondelete='CASCADE'),
            nullable=False,
            index=True,
        )
        version_no = db.Column(db.Integer, nullable=False)
        action = db.Column(db.String(20), default='save')
        snapshot_json = db.Column(db.Text, nullable=False)
        operator = db.Column(db.String(100))
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

        query_management = db.relationship(
            'QueryManagement',
            backref=db.backref('versions', lazy='dynamic', cascade='all, delete-orphan'),
        )

        def to_dict(self):
            snapshot = {}
            try:
                parsed = json.loads(self.snapshot_json or '{}')
                if isinstance(parsed, dict):
                    snapshot = parsed
            except Exception:
                snapshot = {}
            return {
                'id': self.id,
                'query_management_id': self.query_management_id,
                'version_no': self.version_no,
                'action': self.action,
                'operator': self.operator,
                'snapshot': snapshot,
                'created_at': self.created_at.isoformat() if self.created_at else None,
            }

    return {
        'QueryManagement': QueryManagement,
        'QueryManagementVersion': QueryManagementVersion,
    }
