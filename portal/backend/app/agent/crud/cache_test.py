# -*- coding: utf-8 -*-
"""缓存命中率测试记录的数据访问。"""

from sqlalchemy import or_

from .base import AgentCRUDBase


class AgentCacheTestCRUD(AgentCRUDBase):
    def __init__(self, db, models):
        super().__init__(db, models)
        self.CacheTest = models['AgentCacheTest']
        self.Usage = models['AgentUsageEvent']
        self.Credential = models['AgentLlmCredential']

    def page(self, user_id, page=1, per_page=20, search=None):
        query = self.CacheTest.query.filter_by(user_id=user_id)
        if search:
            like = f'%{search}%'
            query = query.filter(or_(
                self.CacheTest.name.ilike(like),
                self.CacheTest.model.ilike(like),
            ))
        total = query.count()
        rows = query.order_by(self.CacheTest.id.desc()).offset(
            (page - 1) * per_page
        ).limit(per_page).all()
        return rows, total

    def get(self, test_id, user_id=None):
        query = self.CacheTest.query.filter_by(id=test_id)
        if user_id is not None:
            query = query.filter_by(user_id=user_id)
        return query.first()

    def create(self, **payload):
        row = self.CacheTest(**payload)
        self.add(row)
        return row

    def remove(self, row):
        self.delete(row)

    def usage_event(self, request_id):
        """按网关 request_id 回查用量事件，取测试轮次实际使用的账号信息。"""
        if not request_id:
            return None
        return self.Usage.query.filter_by(request_id=request_id).first()

    def credential(self, credential_id):
        if not credential_id:
            return None
        return self.Credential.query.filter(self.Credential.id == credential_id).first()
