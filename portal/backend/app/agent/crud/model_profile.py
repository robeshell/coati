"""统一模型能力档案数据访问。"""

from sqlalchemy import or_

from .base import AgentCRUDBase


class AgentModelProfileCRUD(AgentCRUDBase):
    def __init__(self, db, models):
        super().__init__(db, models)
        self.Profile = models['AgentModelProfile']

    def get(self, profile_id):
        return self.Profile.query.get(profile_id)

    def get_by_model(self, model_name):
        return self.Profile.query.filter_by(model_name=model_name).first()

    def get_enabled_by_model(self, model_name):
        return self.Profile.query.filter_by(model_name=model_name, enabled=True).first()

    def page(self, page=1, per_page=20, search=None, enabled=None):
        query = self.Profile.query
        if search:
            query = query.filter(or_(
                self.Profile.model_name.ilike(f'%{search}%'),
                self.Profile.note.ilike(f'%{search}%'),
            ))
        if enabled is not None:
            query = query.filter(self.Profile.enabled == enabled)
        total = query.count()
        rows = query.order_by(self.Profile.model_name.asc()).offset(
            (page - 1) * per_page
        ).limit(per_page).all()
        return rows, total

    def list_all(self):
        return self.Profile.query.order_by(self.Profile.model_name.asc()).all()
