"""用量事件数据访问与多维聚合。"""

import math
from datetime import datetime, timedelta

from sqlalchemy import and_, case, func, or_

from .base import AgentCRUDBase
from backend.app.agent.constants import BILLABLE_USAGE_STATUSES
from backend.app.agent.time_utils import (
    agent_timezone_name,
    local_bucket_iso,
    sqlite_timezone_modifier,
)


class AgentUsageCRUD(AgentCRUDBase):
    def __init__(self, db, models):
        super().__init__(db, models)
        self.Usage = models['AgentUsageEvent']
        self.Admin = models['Admin']
        self.Credential = models['AgentLlmCredential']
        self.Route = models['AgentRouteConfig']
        self.Quota = models['AgentUserQuota']
        self.Pat = models['AgentPat']

    def rollback(self):
        self.db.session.rollback()

    def get_by_request_id(self, request_id):
        return self.Usage.query.filter_by(request_id=request_id).first()

    def bind_credential(self, request_id, credential_id):
        """把进行中的请求绑定到实际账号，供跨 worker 的负载统计使用。"""
        if not request_id or credential_id is None:
            return False
        # 使用独立连接提交，避免在网关主 ORM session 上触发全量过期；
        # 这条轻量更新只负责让其它 worker 立即看到进行中请求的账号。
        statement = self.Usage.__table__.update().where(
            self.Usage.__table__.c.request_id == request_id,
            self.Usage.__table__.c.status == 'reserved',
        ).values(credential_id=credential_id)
        with self.db.engine.begin() as connection:
            result = connection.execute(statement)
        return bool(result.rowcount)

    def active_credential_loads(self, credential_ids, *, since):
        """统计近期仍处于 reserved 状态的请求，作为跨 Gunicorn worker 的负载视图。"""
        credential_ids = [item for item in (credential_ids or []) if item is not None]
        if not credential_ids:
            return {}
        rows = self.db.session.query(
            self.Usage.credential_id,
            func.count(self.Usage.id),
        ).filter(
            self.Usage.status == 'reserved',
            self.Usage.created_at >= since,
            self.Usage.credential_id.in_(credential_ids),
        ).group_by(self.Usage.credential_id).all()
        return {row[0]: int(row[1] or 0) for row in rows}

    def tokens_since(self, user_id, since):
        value = self.db.session.query(func.coalesce(func.sum(self.Usage.total_tokens), 0)).filter(
            self.Usage.user_id == user_id,
            self.Usage.created_at >= since,
            self.Usage.status.in_(BILLABLE_USAGE_STATUSES),
        ).scalar()
        return int(value or 0)

    def reserve_quota(
        self, *, user_id, request_id, model, prompt_tokens, completion_tokens,
        since, reservation_since, default_quota, pat_id=None,
        parent_request_id=None, min_headroom=0,
    ):
        """锁定用户行，原子检查当日已用量并写入进行中预留。"""
        self.Admin.query.filter(self.Admin.id == user_id).with_for_update().first()
        override = self.get_quota(user_id)
        quota = override.daily_token_quota if override is not None else int(default_quota or 0)
        billable = self.Usage.status.in_(BILLABLE_USAGE_STATUSES)
        active_reservation = and_(
            self.Usage.status == 'reserved',
            self.Usage.created_at >= reservation_since,
        )
        used = int(self.db.session.query(func.coalesce(func.sum(self.Usage.total_tokens), 0)).filter(
            self.Usage.user_id == user_id,
            self.Usage.created_at >= since,
            or_(billable, active_reservation),
        ).scalar() or 0)
        prompt_tokens = max(1, int(prompt_tokens or 0))
        completion_tokens = max(1, int(completion_tokens or 0))
        remaining = max(0, quota - used) if quota > 0 else None
        # 剩余额度会被写回请求的 max_tokens。压得过低时上游必然在半句话中间
        # 截断，客户端只会拿到残缺回答或解析不了的工具调用参数，完全看不出
        # 原因是配额。min_headroom 让管理员可以直接拒绝这类必然失败的请求，
        # 默认 0 表示保持原有语义：只要还剩一点就放行。
        if quota > 0 and (remaining - prompt_tokens) < max(
            1, min(completion_tokens, int(min_headroom or 0)),
        ):
            self.commit()
            return {'allowed': False, 'quota': quota, 'used': used, 'remaining': remaining}

        # 即使未开启每日配额，也写入 reserved 事件。请求完成时会复用同一条
        # 记录；这样网关可以跨 Gunicorn worker 统计真实进行中的上游请求。
        completion_limit = (
            min(completion_tokens, remaining - prompt_tokens)
            if quota > 0 else completion_tokens
        )
        reserved = prompt_tokens + completion_limit
        row = self.Usage(
            request_id=request_id,
            parent_request_id=parent_request_id,
            user_id=user_id,
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_limit,
            total_tokens=reserved,
            status='reserved',
            attempt_count=0,
            source='gateway',
            pat_id=pat_id,
        )
        self.db.session.add(row)
        self.commit()
        return {
            'allowed': True, 'quota': quota, 'used': used,
            'remaining': remaining if remaining is not None else None,
            'reserved': reserved,
            'completion_limit': completion_limit if quota > 0 else None,
            # 客户端要的输出上限被剩余额度压低了：上游可能中途截断，
            # 排查时必须能看出这不是模型的问题。
            'completion_truncated': quota > 0 and completion_limit < completion_tokens,
        }

    def finalize_reserved(self, row, payload):
        for field, value in payload.items():
            setattr(row, field, value)
        row.total_tokens = int(row.prompt_tokens or 0) + int(row.completion_tokens or 0)
        self.commit()
        return row

    def get_user(self, user_id):
        return self.db.session.get(self.Admin, user_id)

    def get_quota(self, user_id):
        return self.db.session.get(self.Quota, user_id)

    def set_quota(self, user_id, daily_token_quota):
        row = self.get_quota(user_id)
        if row is None:
            row = self.Quota(user_id=user_id, daily_token_quota=daily_token_quota)
            self.db.session.add(row)
        else:
            row.daily_token_quota = daily_token_quota
        self.commit()
        return row

    def delete_quota(self, user_id):
        row = self.get_quota(user_id)
        if row is not None:
            self.db.session.delete(row)
            self.commit()

    def page_quota_users(self, page=1, per_page=20, search=None):
        query = self.Admin.query
        if search:
            query = query.filter(self.Admin.username.ilike(f'%{search}%'))
        total = query.count()
        rows = query.order_by(self.Admin.username.asc()).offset((page - 1) * per_page).limit(per_page).all()
        return rows, total

    def quota_context(self, user_ids, since):
        if not user_ids:
            return {}, {}
        quotas = {
            row.user_id: row
            for row in self.Quota.query.filter(self.Quota.user_id.in_(user_ids)).all()
        }
        usage_rows = self.db.session.query(
            self.Usage.user_id,
            func.coalesce(func.sum(self.Usage.total_tokens), 0),
        ).filter(
            self.Usage.user_id.in_(user_ids),
            self.Usage.created_at >= since,
            self.Usage.status.in_(BILLABLE_USAGE_STATUSES),
        ).group_by(self.Usage.user_id).all()
        return quotas, {row[0]: int(row[1] or 0) for row in usage_rows}

    def _filtered(
        self, *, days=7, user_id=None, status=None, pat_id=None, model=None,
    ):
        since = datetime.utcnow() - timedelta(days=days)
        query = self.Usage.query.filter(self.Usage.created_at >= since)
        if status != 'reserved':
            query = query.filter(self.Usage.status != 'reserved')
        if user_id:
            query = query.filter_by(user_id=user_id)
        if pat_id:
            query = query.filter_by(pat_id=pat_id)
        if model:
            # 网关记录的 model 是客户端请求的模型名（与「模型路由」的 model_name 对齐），
            # 因此这里按路由名聚合，与用量列表「模型」列口径一致。
            query = query.filter_by(model=model)
        if status:
            query = query.filter_by(status=status)
        return query

    def summarize_pats(self, user_id, pat_ids, *, days=7):
        if not pat_ids:
            return {}
        since = datetime.utcnow() - timedelta(days=days)
        rows = self.db.session.query(
            self.Usage.pat_id,
            func.coalesce(func.sum(case((self.Usage.status != 'reserved', 1), else_=0)), 0),
            func.coalesce(func.sum(case(
                (self.Usage.status.in_(BILLABLE_USAGE_STATUSES), self.Usage.total_tokens),
                else_=0,
            )), 0),
        ).filter(
            self.Usage.user_id == user_id,
            self.Usage.pat_id.in_(pat_ids),
            self.Usage.created_at >= since,
            self.Usage.status != 'reserved',
        ).group_by(self.Usage.pat_id).all()
        return {
            row[0]: {'requests_7d': int(row[1] or 0), 'tokens_7d': int(row[2] or 0)}
            for row in rows
        }

    def page(self, page=1, per_page=20, **filters):
        query = self._filtered(**filters)
        total = query.count()
        rows = query.order_by(self.Usage.id.desc()).offset((page - 1) * per_page).limit(per_page).all()
        return rows, total

    def list_for_user_ids(self, user_id, ids):
        if not ids:
            return []
        return (
            self.Usage.query.filter(self.Usage.user_id == user_id, self.Usage.id.in_(ids))
            .order_by(self.Usage.id.desc())
            .all()
        )

    def list_pats_for_user(self, user_id):
        return self.Pat.query.filter_by(user_id=user_id).order_by(self.Pat.id.desc()).all()

    def list_pats_with_usage_for_user(self, user_id, *, days=7):
        since = datetime.utcnow() - timedelta(days=days)
        pat_ids = [
            row[0] for row in self.db.session.query(self.Usage.pat_id).filter(
                self.Usage.user_id == user_id,
                self.Usage.created_at >= since,
                self.Usage.pat_id.isnot(None),
            ).distinct().all()
            if row[0] is not None
        ]
        if not pat_ids:
            return []
        return self.Pat.query.filter(self.Pat.id.in_(pat_ids)).order_by(self.Pat.name.asc()).all()

    def related_context(self, rows):
        user_ids = {row.user_id for row in rows if row.user_id}
        credential_ids = {row.credential_id for row in rows if row.credential_id}
        route_ids = {row.route_id for row in rows if row.route_id}
        users = {
            row.id: row.username
            for row in self.Admin.query.filter(self.Admin.id.in_(user_ids)).all()
        } if user_ids else {}
        credentials = {
            row.id: {
                'credential_name': row.name,
                'provider': row.provider,
                'upstream_protocol': row.upstream_protocol,
            }
            for row in self.Credential.query.filter(self.Credential.id.in_(credential_ids)).all()
        } if credential_ids else {}
        routes = {
            row.id: row.model_name
            for row in self.Route.query.filter(self.Route.id.in_(route_ids)).all()
        } if route_ids else {}
        return users, credentials, routes, self.pat_context(rows)

    def pat_context(self, rows):
        pat_ids = {row.pat_id for row in rows if row.pat_id}
        return {
            row.id: {'pat_name': row.name, 'token_type': row.token_type}
            for row in self.Pat.query.filter(self.Pat.id.in_(pat_ids)).all()
        } if pat_ids else {}

    @staticmethod
    def _billable_statuses():
        return BILLABLE_USAGE_STATUSES

    def summary(self, **filters):
        query = self._filtered(**filters)
        billable = self._billable_statuses()
        row = query.with_entities(
            func.count(self.Usage.id),
            func.coalesce(func.sum(case(
                (self.Usage.status.in_(billable), self.Usage.prompt_tokens),
                else_=0,
            )), 0),
            func.coalesce(func.sum(case(
                (self.Usage.status.in_(billable), self.Usage.completion_tokens),
                else_=0,
            )), 0),
            func.coalesce(func.sum(case((self.Usage.status != 'ok', 1), else_=0)), 0),
            func.coalesce(func.avg(self.Usage.latency_ms), 0),
            func.count(func.distinct(self.Usage.user_id)),
            func.count(func.distinct(self.Usage.model)),
        ).first()
        requests = int(row[0] or 0)
        prompt_tokens = int(row[1] or 0)
        completion_tokens = int(row[2] or 0)
        errors = int(row[3] or 0)
        return {
            'requests': requests,
            'successful_requests': max(0, requests - errors),
            'prompt_tokens': prompt_tokens,
            'completion_tokens': completion_tokens,
            'tokens': prompt_tokens + completion_tokens,
            'errors': errors,
            'success_rate': round(((requests - errors) / requests * 100), 1) if requests else 0,
            'avg_latency_ms': int(row[4] or 0),
            'p95_latency_ms': self._percentile_latency(query, 0.95),
            'active_users': int(row[5] or 0),
            'active_models': int(row[6] or 0),
        }

    def _percentile_latency(self, query, percentile):
        latency_query = query.filter(self.Usage.latency_ms.isnot(None))
        dialect = self.db.engine.dialect.name
        if dialect == 'postgresql':
            value = latency_query.with_entities(
                func.percentile_cont(percentile).within_group(self.Usage.latency_ms),
            ).scalar()
            return int(value or 0)
        values = [row[0] for row in latency_query.with_entities(self.Usage.latency_ms).order_by(self.Usage.latency_ms).all()]
        if not values:
            return 0
        return int(values[max(0, math.ceil(len(values) * percentile) - 1)])

    def trend(self, **filters):
        query = self._filtered(**filters)
        hourly = int(filters.get('days') or 7) <= 1
        if self.db.engine.dialect.name == 'postgresql':
            utc_instant = self.Usage.created_at.op('AT TIME ZONE')('UTC')
            local_time = func.timezone(agent_timezone_name(), utc_instant)
            bucket = func.date_trunc('hour' if hourly else 'day', local_time)
        else:
            bucket = func.strftime(
                '%Y-%m-%dT%H:00:00' if hourly else '%Y-%m-%dT00:00:00',
                self.Usage.created_at,
                sqlite_timezone_modifier(),
            )
        rows = query.with_entities(
            bucket.label('bucket'),
            func.count(self.Usage.id),
            func.coalesce(func.sum(case(
                (self.Usage.status.in_(self._billable_statuses()), self.Usage.total_tokens),
                else_=0,
            )), 0),
            func.coalesce(func.sum(case((self.Usage.status != 'ok', 1), else_=0)), 0),
            func.coalesce(func.avg(self.Usage.latency_ms), 0),
        ).group_by(bucket).order_by(bucket).all()
        return [{
            'bucket': local_bucket_iso(row[0]),
            'requests': int(row[1] or 0),
            'tokens': int(row[2] or 0),
            'errors': int(row[3] or 0),
            'avg_latency_ms': int(row[4] or 0),
        } for row in rows]

    def top_users(self, limit=8, **filters):
        billable = self._billable_statuses()
        billable_tokens = func.coalesce(func.sum(case(
            (self.Usage.status.in_(billable), self.Usage.total_tokens),
            else_=0,
        )), 0)
        query = self._filtered(**filters).join(self.Admin, self.Admin.id == self.Usage.user_id)
        rows = query.with_entities(
            self.Admin.id, self.Admin.username,
            func.count(self.Usage.id),
            billable_tokens,
            func.coalesce(func.sum(case((self.Usage.status != 'ok', 1), else_=0)), 0),
        ).group_by(self.Admin.id, self.Admin.username).order_by(billable_tokens.desc()).limit(limit).all()
        return [{
            'user_id': row[0], 'username': row[1], 'requests': int(row[2] or 0),
            'tokens': int(row[3] or 0), 'errors': int(row[4] or 0),
        } for row in rows]

    def model_breakdown(self, limit=8, **filters):
        """按模型聚合调用量与计费 Token，口径与 summary / top_users 保持一致。

        返回 `items` 之外还带 `tokens`（该筛选范围内全部模型的计费 Token 合计），
        供前端算占比 —— 只用 Top N 相加会在模型较多时失真。
        """
        billable = self._billable_statuses()
        billable_tokens = func.coalesce(func.sum(case(
            (self.Usage.status.in_(billable), self.Usage.total_tokens),
            else_=0,
        )), 0)
        rows = self._filtered(**filters).with_entities(
            self.Usage.model,
            func.count(self.Usage.id),
            func.coalesce(func.sum(case(
                (self.Usage.status.in_(billable), self.Usage.prompt_tokens),
                else_=0,
            )), 0),
            func.coalesce(func.sum(case(
                (self.Usage.status.in_(billable), self.Usage.completion_tokens),
                else_=0,
            )), 0),
            billable_tokens,
        ).group_by(self.Usage.model).order_by(billable_tokens.desc()).limit(limit).all()
        scope_total = int(self._filtered(**filters).with_entities(
            func.coalesce(func.sum(case(
                (self.Usage.status.in_(billable), self.Usage.total_tokens),
                else_=0,
            )), 0),
        ).scalar() or 0)
        return {
            'tokens': scope_total,
            'items': [{
                'model': row[0], 'requests': int(row[1] or 0),
                'prompt_tokens': int(row[2] or 0), 'completion_tokens': int(row[3] or 0),
                'tokens': int(row[4] or 0),
                'share_percent': round(int(row[4] or 0) / scope_total * 100, 1) if scope_total else 0,
            } for row in rows],
        }

    def model_options(self, *, days=7, user_id=None):
        """模型筛选选项。个人视角必须带 user_id，避免看到别人的模型名。"""
        since = datetime.utcnow() - timedelta(days=days)
        query = self.Usage.query.filter(
            self.Usage.created_at >= since,
            self.Usage.model.isnot(None),
        )
        if user_id:
            query = query.filter_by(user_id=user_id)
        rows = query.with_entities(self.Usage.model).distinct().order_by(self.Usage.model).all()
        return [{'value': row[0], 'label': row[0]} for row in rows]

    def filter_options(self, *, days=7):
        since = datetime.utcnow() - timedelta(days=days)
        base = self.Usage.query.filter(self.Usage.created_at >= since)
        users = base.join(self.Admin, self.Admin.id == self.Usage.user_id).with_entities(
            self.Admin.id, self.Admin.username,
        ).distinct().order_by(self.Admin.username).all()
        return {
            'users': [{'value': row[0], 'label': row[1]} for row in users],
            'models': self.model_options(days=days),
        }
