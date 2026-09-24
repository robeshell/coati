"""PAT 与设备授权数据访问。"""

from datetime import datetime, timedelta

from sqlalchemy import or_, text

from .base import AgentCRUDBase


class AgentAuthCRUD(AgentCRUDBase):
    def __init__(self, db, models):
        super().__init__(db, models)
        self.Admin = models['Admin']
        self.Pat = models['AgentPat']
        self.DeviceCode = models['AgentDeviceCode']

    def page_pats(self, user_id, page=1, per_page=20, search=None, status=None, token_type=None):
        query = self.Pat.query.filter_by(user_id=user_id)
        if search:
            like = f'%{search}%'
            query = query.filter(or_(
                self.Pat.name.ilike(like), self.Pat.token_prefix.ilike(like), self.Pat.note.ilike(like),
            ))
        now = datetime.utcnow()
        if status == 'active':
            query = query.filter(self.Pat.revoked_at.is_(None)).filter(
                or_(self.Pat.expires_at.is_(None), self.Pat.expires_at > now),
            )
        elif status == 'revoked':
            query = query.filter(self.Pat.revoked_at.isnot(None))
        elif status == 'expired':
            query = query.filter(self.Pat.revoked_at.is_(None), self.Pat.expires_at <= now)
        if token_type:
            query = query.filter_by(token_type=token_type)
        total = query.count()
        rows = query.order_by(self.Pat.id.desc()).offset((page - 1) * per_page).limit(per_page).all()
        return rows, total

    def get_pat_for_user(self, pat_id, user_id):
        return self.Pat.query.filter_by(id=pat_id, user_id=user_id).first()

    def get_pat_by_hash(self, digest):
        return self.Pat.query.filter_by(token_hash=digest).first()

    def get_user(self, user_id):
        return self.Admin.query.get(user_id)

    def get_device_by_user_code(self, code):
        return self.DeviceCode.query.filter_by(user_code=code).first()

    def get_device_by_device_code(self, code):
        return self.DeviceCode.query.filter_by(device_code=code).first()

    def confirm_device(self, device, *, user_id, now):
        updated = self.DeviceCode.query.filter(
            self.DeviceCode.id == device.id,
            self.DeviceCode.status == 'pending',
            self.DeviceCode.expires_at >= now,
        ).update({
            'user_id': user_id,
            'status': 'confirmed',
            'confirmed_at': now,
        }, synchronize_session=False)
        self.commit()
        self.db.session.expire(device)
        return updated == 1

    def create_device_code(self, row, *, now, per_minute, max_active, retention_hours):
        if self.db.engine.dialect.name == 'postgresql':
            self.db.session.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': 73462109})
        self.DeviceCode.query.filter(
            self.DeviceCode.created_at < now - timedelta(hours=max(1, int(retention_hours))),
        ).delete(synchronize_session=False)
        self.DeviceCode.query.filter(
            self.DeviceCode.status.in_(['pending', 'confirmed']),
            self.DeviceCode.expires_at < now,
        ).update({'status': 'expired'}, synchronize_session=False)
        recent = self.DeviceCode.query.filter(
            self.DeviceCode.created_at >= now - timedelta(minutes=1),
        ).count()
        active = self.DeviceCode.query.filter(
            self.DeviceCode.status.in_(['pending', 'confirmed']),
            self.DeviceCode.expires_at >= now,
        ).count()
        if recent >= max(1, int(per_minute)):
            self.commit()
            return 'rate_limited'
        if active >= max(1, int(max_active)):
            self.commit()
            return 'capacity_exceeded'
        self.db.session.add(row)
        self.commit()
        return 'created'

    def issue_device_pat(self, pat, device, *, now, digest, prefix):
        updated = self.DeviceCode.query.filter(
            self.DeviceCode.id == device.id,
            self.DeviceCode.status == 'confirmed',
            self.DeviceCode.user_id == device.user_id,
            self.DeviceCode.expires_at >= now,
        ).update({
            'status': 'consumed',
            'consumed_at': now,
            'access_token_hash': digest,
            'access_token_prefix': prefix,
        }, synchronize_session=False)
        if updated != 1:
            self.db.session.rollback()
            return False
        self.db.session.add(pat)
        self.commit()
        return True

    def rotate_pat(self, old_pat, new_pat):
        old_pat.revoked_at = datetime.utcnow()
        self.db.session.add(new_pat)
        self.commit()
