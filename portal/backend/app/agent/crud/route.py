"""模型路由数据访问。"""

from datetime import datetime, timedelta

from sqlalchemy import case, func
from sqlalchemy import or_

from .base import AgentCRUDBase
from backend.app.agent.constants import BILLABLE_USAGE_STATUSES
from backend.app.agent.time_utils import utc_iso


class AgentRouteCRUD(AgentCRUDBase):
    def __init__(self, db, models):
        super().__init__(db, models)
        self.Route = models['AgentRouteConfig']
        self.Credential = models['AgentLlmCredential']
        self.Usage = models['AgentUsageEvent']

    def get(self, route_id):
        return self.Route.query.get(route_id)

    def get_by_model(self, model_name):
        return self.Route.query.filter_by(model_name=model_name).first()

    def get_enabled_by_model(self, model_name):
        return self.Route.query.filter_by(model_name=model_name, enabled=True).first()

    def enabled_items(self):
        return self.Route.query.filter_by(enabled=True).order_by(self.Route.model_name.asc()).all()

    def list_all(self):
        return self.Route.query.order_by(self.Route.model_name.asc()).all()

    def page(self, page=1, per_page=20, search=None, enabled=None, provider=None, credential_id=None):
        query = self.Route.query
        if search:
            like = f'%{search}%'
            query = query.filter(or_(
                self.Route.model_name.ilike(like),
                self.Route.upstream_model.ilike(like),
            ))
        if enabled is not None:
            query = query.filter(self.Route.enabled == enabled)
        if credential_id:
            query = query.filter(self.Route.credential_id == credential_id)
        if provider:
            credential_ids = self.db.session.query(self.Credential.id).filter(
                self.Credential.provider == provider,
            )
            query = query.filter(self.Route.credential_id.in_(credential_ids))
        total = query.count()
        rows = query.order_by(self.Route.model_name.asc()).offset((page - 1) * per_page).limit(per_page).all()
        return rows, total

    def credentials_map(self, rows):
        ids = {row.credential_id for row in rows if row.credential_id}
        if not ids:
            return {}
        return {row.id: row for row in self.Credential.query.filter(self.Credential.id.in_(ids)).all()}

    def usage_stats(self, rows, days=7):
        models = {row.model_name for row in rows if row.model_name}
        if not models:
            return {}
        since = datetime.utcnow() - timedelta(days=days)
        values = self.db.session.query(
            self.Usage.model,
            func.count(self.Usage.id),
            func.coalesce(func.sum(case(
                (self.Usage.status.in_(BILLABLE_USAGE_STATUSES), self.Usage.total_tokens),
                else_=0,
            )), 0),
            func.max(self.Usage.created_at),
        ).filter(
            self.Usage.model.in_(models), self.Usage.created_at >= since,
            self.Usage.status != 'reserved',
        ).group_by(self.Usage.model).all()
        return {
            row[0]: {
                'requests': int(row[1] or 0), 'tokens': int(row[2] or 0),
                'last_used_at': utc_iso(row[3]),
            }
            for row in values
        }
