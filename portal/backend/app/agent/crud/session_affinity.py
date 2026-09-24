# -*- coding: utf-8 -*-
"""网关会话亲和绑定的数据访问。"""

from datetime import datetime, timedelta

from sqlalchemy.exc import IntegrityError

from .base import AgentCRUDBase


class AgentSessionAffinityCRUD(AgentCRUDBase):
    def __init__(self, db, models):
        super().__init__(db, models)
        self.Binding = models['AgentSessionAffinity']

    def rollback(self):
        self.db.session.rollback()

    def get_active(self, user_id, session_id, model_key, *, ttl_seconds, now=None):
        now = now or datetime.utcnow()
        row = self.Binding.query.filter_by(
            user_id=user_id,
            session_id=session_id,
            model_key=model_key,
        ).first()
        if not row:
            return None
        if row.expires_at <= now:
            self.db.session.delete(row)
            self.commit()
            return None

        # 滑动过期只在剩余时间不足一半时落库，避免每个网关请求都产生写事务。
        refresh_before = now + timedelta(seconds=max(1, ttl_seconds // 2))
        if row.expires_at <= refresh_before:
            row.expires_at = now + timedelta(seconds=ttl_seconds)
            row.updated_at = now
            self.commit()
        return row

    def active_binding_loads(self, user_id, model_key, credential_ids, *, now=None):
        """返回当前有效会话绑定的账号负载和最近绑定账号。

        首次绑定需要跨进程共享一个轻量负载视图，不能只依赖单 worker 内存计数。
        这里复用已有亲和表，不新增字段或迁移。user_id 为 None 时按账号池全局
        统计；首次调度必须使用全局视图，否则每个用户的第一个会话都会在全 0
        负载下选中同一个账号。
        """
        credential_ids = [item for item in (credential_ids or []) if item is not None]
        if not model_key or not credential_ids:
            return {'counts': {}, 'last_credential_id': None}
        now = now or datetime.utcnow()
        filters = [
            self.Binding.model_key == model_key,
            self.Binding.credential_id.in_(credential_ids),
            self.Binding.expires_at > now,
        ]
        if user_id is not None:
            filters.append(self.Binding.user_id == user_id)
        rows = self.Binding.query.filter(*filters).order_by(
            self.Binding.updated_at.desc(), self.Binding.id.desc(),
        ).all()
        counts = {}
        for row in rows:
            counts[row.credential_id] = counts.get(row.credential_id, 0) + 1
        return {
            'counts': counts,
            'last_credential_id': rows[0].credential_id if rows else None,
        }

    def bind(self, user_id, session_id, model_key, credential_id, *, ttl_seconds, now=None):
        now = now or datetime.utcnow()
        expires_at = now + timedelta(seconds=ttl_seconds)
        # 新会话首次绑定时顺手清理历史数据，避免独立后台清理任务。
        self.Binding.query.filter(self.Binding.expires_at <= now).delete(synchronize_session=False)
        row = self.Binding.query.filter_by(
            user_id=user_id,
            session_id=session_id,
            model_key=model_key,
        ).first()
        if row:
            # 会话绑定采用 first-writer-wins。并发首请求如果已经有其它账号
            # 抢先完成绑定，后到请求必须沿用该账号，不能把粘性覆盖掉。
            if row.credential_id == credential_id:
                row.expires_at = expires_at
                row.updated_at = now
                self.commit()
            return row

        row = self.Binding(
            user_id=user_id,
            session_id=session_id,
            model_key=model_key,
            credential_id=credential_id,
            expires_at=expires_at,
            created_at=now,
            updated_at=now,
        )
        self.db.session.add(row)
        try:
            self.commit()
            return row
        except IntegrityError:
            # 同一新会话并发首请求时，唯一键只允许一个绑定；后提交者读取
            # 先提交的规范账号，不覆盖它。
            self.db.session.rollback()
            row = self.Binding.query.filter_by(
                user_id=user_id,
                session_id=session_id,
                model_key=model_key,
            ).one()
            return row

    def invalidate(self, user_id, session_id, model_key, *, credential_id=None):
        query = self.Binding.query.filter_by(
            user_id=user_id,
            session_id=session_id,
            model_key=model_key,
        )
        if credential_id is not None:
            query = query.filter(self.Binding.credential_id == credential_id)
        deleted = query.delete(synchronize_session=False)
        if deleted:
            self.commit()
        return bool(deleted)
