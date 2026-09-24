"""上游凭证数据访问。"""

from datetime import datetime, timedelta

from sqlalchemy import case, func, or_

from .base import AgentCRUDBase


class AgentCredentialCRUD(AgentCRUDBase):
    def __init__(self, db, models):
        super().__init__(db, models)
        self.Credential = models['AgentLlmCredential']
        self.Route = models['AgentRouteConfig']

    def get(self, credential_id):
        return self.Credential.query.get(credential_id)

    def _scope_filter(self, query, *, scope='platform', owner_user_id=None):
        if scope == 'personal':
            return query.filter(
                self.Credential.scope == 'personal',
                self.Credential.owner_user_id == owner_user_id,
            )
        return query.filter(
            or_(self.Credential.scope == 'platform', self.Credential.scope.is_(None)),
            self.Credential.owner_user_id.is_(None),
        )

    def page(
        self, page=1, per_page=20, search=None, enabled=None, upstream_protocol=None, health_status=None,
        *, scope='platform', owner_user_id=None, provider=None,
    ):
        query = self._scope_filter(self.Credential.query, scope=scope, owner_user_id=owner_user_id)
        if search:
            like = f'%{search}%'
            query = query.filter(or_(
                self.Credential.name.ilike(like),
                self.Credential.upstream_protocol.ilike(like),
                self.Credential.default_model.ilike(like),
            ))
        if enabled is not None:
            query = query.filter(self.Credential.enabled == enabled)
        if upstream_protocol:
            query = query.filter(self.Credential.upstream_protocol == upstream_protocol)
        if provider:
            query = query.filter(self.Credential.provider == provider)
        if health_status:
            query = query.filter(self.Credential.health_status == health_status)
        total = query.count()
        rows = query.order_by(self.Credential.id.desc()).offset((page - 1) * per_page).limit(per_page).all()
        return rows, total

    def summary(self, *, scope='platform', owner_user_id=None):
        now = datetime.utcnow()
        base = self._scope_filter(self.Credential.query, scope=scope, owner_user_id=owner_user_id)
        total = base.count()
        enabled = base.filter_by(enabled=True).count()
        used = base.filter(self.Credential.last_used_at.isnot(None)).count()
        healthy = base.filter_by(enabled=True, health_status='healthy').count()
        enabled_base = base.filter(self.Credential.enabled.is_(True))
        status_unhealthy = enabled_base.filter(
            self.Credential.health_status == 'unhealthy',
        ).count()
        # 已过期的冷却单独成档：调度已放行，只是还没有新的成功观测。
        active_cooldown = enabled_base.filter(
            self.Credential.health_status == 'cooldown',
            self.Credential.cooldown_until > now,
        ).count()
        recovery_pending = enabled_base.filter(
            self.Credential.health_status == 'cooldown',
            or_(self.Credential.cooldown_until.is_(None), self.Credential.cooldown_until <= now),
        ).count()
        unknown = max(0, enabled - healthy - status_unhealthy - active_cooldown - recovery_pending)
        return {
            'total': total, 'enabled': enabled, 'disabled': total - enabled, 'used': used,
            'healthy': healthy,
            # 沿用原口径：异常卡数 = 异常状态 + 冷却中的账号；过期冷却不再混入。
            'unhealthy': status_unhealthy + active_cooldown,
            'cooling': active_cooldown,
            'recovering': recovery_pending,
            'unknown': unknown,
        }

    def reset_session(self):
        """后台探测线程整轮异常后复位会话，避免脏状态影响下一轮。"""
        try:
            self.db.session.rollback()
        except Exception:
            pass

    def probe_candidates(self, *, quiet_seconds=600, limit=5):
        """需要主动探活的启用账号：异常/冷却/未检测，且距上次探测超过静默窗口。"""
        cutoff = datetime.utcnow() - timedelta(seconds=max(30, int(quiet_seconds or 600)))
        limit = max(1, int(limit or 1))
        return self.Credential.query.filter(
            self.Credential.enabled.is_(True),
            self.Credential.health_status.in_(['unhealthy', 'cooldown', 'unknown']),
            or_(
                self.Credential.last_checked_at.is_(None),
                self.Credential.last_checked_at <= cutoff,
            ),
        ).order_by(
            self.Credential.last_checked_at.asc().nulls_first(),
            self.Credential.id.asc(),
        ).limit(limit).all()

    def enabled_items(self, *, scope='platform', owner_user_id=None):
        query = self._scope_filter(
            self.Credential.query.filter_by(enabled=True),
            scope=scope, owner_user_id=owner_user_id,
        )
        return query.order_by(
            self.Credential.priority.desc(), self.Credential.id.asc(),
        ).all()

    def list_all(self):
        return self.Credential.query.order_by(self.Credential.id.asc()).all()

    def count_personal(self, owner_user_id):
        return self.Credential.query.filter_by(scope='personal', owner_user_id=owner_user_id).count()

    def get_owned(self, credential_id, owner_user_id):
        return self.Credential.query.filter_by(
            id=credential_id, scope='personal', owner_user_id=owner_user_id,
        ).first()

    def get_enabled(self, credential_id):
        return self.Credential.query.filter_by(id=credential_id, enabled=True).first()

    def route_reference_count(self, credential_id):
        return self.Route.query.filter_by(credential_id=credential_id).count()

    def touch(self, row):
        row.last_used_at = datetime.utcnow()
        self.commit()

    def mark_success(self, row, latency_ms=None, *, checked=False, observed_at=None):
        now = datetime.utcnow()
        observed_at = observed_at or now
        values = {
            'health_status': 'healthy',
            'consecutive_failures': 0,
            'last_success_at': now,
            # 连最近一次失败观测一起清掉：否则软降权窗口会在成功后继续误伤。
            'last_error_at': None,
            'last_error': None,
            'cooldown_until': None,
        }
        if checked:
            values['last_checked_at'] = now
        if latency_ms is not None:
            values['last_latency_ms'] = max(0, int(latency_ms))
        self.Credential.query.filter(
            self.Credential.id == row.id,
            or_(self.Credential.last_error_at.is_(None), self.Credential.last_error_at <= observed_at),
        ).update(values, synchronize_session=False)
        self.commit()
        self.db.session.expire(row)

    def mark_checked(self, row, latency_ms=None):
        """只记录探测发生，不改变健康状态或失败/冷却信息。

        某些原生协议没有模型列表接口，不能用 mark_success 伪造“已验证健康”。
        """
        values = {'last_checked_at': datetime.utcnow()}
        if latency_ms is not None:
            values['last_latency_ms'] = max(0, int(latency_ms))
        self.Credential.query.filter(self.Credential.id == row.id).update(
            values, synchronize_session=False,
        )
        self.commit()
        self.db.session.expire(row)

    def mark_failure(
        self, row, message, *, threshold=3, cooldown_seconds=60,
        checked=False, observed_at=None, soft=False,
    ):
        """记录一次上游失败。

        soft=True（软记账）：只刷新 last_error_at/last_error，不累计
        consecutive_failures、不改变健康状态、不设冷却——降权由选号时的
        时间窗口判定自动生效与解除。适用于"换 Key 可能成功"的可重试错误。
        """
        now = datetime.utcnow()
        observed_at = observed_at or now
        values = {
            'last_error_at': now,
            'last_error': str(message or '上游请求失败')[:1000],
        }
        if not soft:
            threshold = max(1, int(threshold))
            next_failures = func.coalesce(self.Credential.consecutive_failures, 0) + 1
            reached_threshold = next_failures >= threshold
            values['consecutive_failures'] = next_failures
            values['health_status'] = case((reached_threshold, 'cooldown'), else_='unhealthy')
            values['cooldown_until'] = case(
                (reached_threshold, now + timedelta(seconds=max(1, int(cooldown_seconds)))),
                else_=self.Credential.cooldown_until,
            )
        if checked:
            values['last_checked_at'] = now
        self.Credential.query.filter(
            self.Credential.id == row.id,
            or_(self.Credential.last_success_at.is_(None), self.Credential.last_success_at <= observed_at),
        ).update(values, synchronize_session=False)
        self.commit()
        self.db.session.expire(row)
