# -*- coding: utf-8 -*-
"""PAT / Device Code / 令牌解析业务服务。"""

import json
import secrets
from datetime import datetime, timedelta

from flask import current_app

from backend.app.agent.crud import AgentAuthCRUD
from backend.app.agent.schema.auth import normalize_user_code
from backend.app.agent.schema.common import AgentValidationError
from backend.app.agent.service.bearer import hash_token


class AgentAuthError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


DEVICE_CONFIRM_MESSAGES = {
    'confirmed': '该登录请求已确认，请返回发起登录的应用继续',
    'consumed': '该登录请求已经完成，无需重复授权',
    'expired': '用户码已过期，请重新发起登录',
}


def device_confirmation_message(status):
    """将内部设备状态转换为面向用户的中文提示。"""
    return DEVICE_CONFIRM_MESSAGES.get(status, '当前登录请求无法确认，请重新发起登录')


class AgentAuthService:
    def __init__(self, db, models):
        self.Pat = models['AgentPat']
        self.DeviceCode = models['AgentDeviceCode']
        self.crud = AgentAuthCRUD(db, models)

    @staticmethod
    def _mint_raw_token():
        raw = 'coati_' + secrets.token_urlsafe(32)
        return raw, raw[:12], hash_token(raw)

    def create_pat(
        self, user_id, name='default', expires_days=None, token_type='personal',
        scopes=None, note=None,
    ):
        raw, prefix, digest = self._mint_raw_token()
        row = self.Pat(
            user_id=user_id, name=(name or 'default').strip()[:100] or 'default',
            token_type=token_type,
            scopes_json=json.dumps(scopes or ['chat', 'profile'], ensure_ascii=False),
            note=(note or '').strip()[:255] or None,
            token_prefix=prefix, token_hash=digest,
            expires_at=datetime.utcnow() + timedelta(days=int(expires_days)) if expires_days else None,
        )
        self.crud.add(row)
        data = row.to_dict()
        data['token'] = raw
        return data

    def list_pats(self, user_id, page=1, per_page=20, search=None, status=None, token_type=None):
        page = max(1, int(page or 1))
        per_page = min(100, max(1, int(per_page or 20)))
        rows, total = self.crud.page_pats(
            user_id, page, per_page, (search or '').strip() or None,
            (status or '').strip() or None, (token_type or '').strip() or None,
        )
        items = [row.to_dict() for row in rows]
        from backend.app.agent.service.usage_service import AgentUsageService
        usage = AgentUsageService(self.crud.db, self.crud.models).summarize_pats(
            user_id, [row.id for row in rows],
        )
        for item in items:
            stats = usage.get(item['id']) or {}
            item['requests_7d'] = int(stats.get('requests_7d') or 0)
            item['tokens_7d'] = int(stats.get('tokens_7d') or 0)
        return {'items': items, 'total': total, 'page': page, 'per_page': per_page}

    def revoke_pat(self, user_id, pat_id):
        row = self.crud.get_pat_for_user(pat_id, user_id)
        if not row:
            raise AgentAuthError('令牌不存在', 404)
        if not row.revoked_at:
            row.revoked_at = datetime.utcnow()
            self.crud.commit()
        return row.to_dict()

    def update_pat(self, user_id, pat_id, *, name, expires_days=None):
        row = self.crud.get_pat_for_user(pat_id, user_id)
        if not row:
            raise AgentAuthError('令牌不存在', 404)
        now = datetime.utcnow()
        if row.token_type != 'personal':
            raise AgentAuthError('只能编辑 API Key', 409)
        if row.revoked_at or (row.expires_at and row.expires_at <= now):
            raise AgentAuthError('只能编辑当前有效的令牌', 409)
        row.name = (name or '').strip()[:100]
        row.expires_at = now + timedelta(days=int(expires_days)) if expires_days else None
        self.crud.commit()
        return row.to_dict()

    def rotate_pat(self, user_id, pat_id):
        old = self.crud.get_pat_for_user(pat_id, user_id)
        if not old:
            raise AgentAuthError('令牌不存在', 404)
        now = datetime.utcnow()
        if old.revoked_at or (old.expires_at and old.expires_at <= now):
            raise AgentAuthError('只能轮换当前有效的令牌', 409)
        raw, prefix, digest = self._mint_raw_token()
        replacement = self.Pat(
            user_id=user_id, name=old.name, token_type=old.token_type,
            scopes_json=old.scopes_json, note=old.note,
            token_prefix=prefix, token_hash=digest, expires_at=old.expires_at,
        )
        self.crud.rotate_pat(old, replacement)
        data = replacement.to_dict()
        data['token'] = raw
        data['rotated_from_id'] = old.id
        return data

    def resolve_bearer(self, raw_token):
        if not raw_token:
            return None, None
        pat = self.crud.get_pat_by_hash(hash_token(raw_token))
        if not pat or pat.revoked_at or (pat.expires_at and pat.expires_at < datetime.utcnow()):
            return None, None
        user = self.crud.get_user(pat.user_id)
        if not user:
            return None, None
        pat.last_used_at = datetime.utcnow()
        try:
            self.crud.commit()
        except Exception:
            pass
        return user, pat

    def start_device_flow(self):
        alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
        user_code = '-'.join(''.join(secrets.choice(alphabet) for _ in range(4)) for _ in range(2))
        interval = int(current_app.config.get('AGENT_DEVICE_INTERVAL_SECONDS', 5))
        ttl = int(current_app.config.get('AGENT_DEVICE_TTL_SECONDS', 600))
        now = datetime.utcnow()
        row = self.DeviceCode(
            device_code=secrets.token_urlsafe(32), user_code=user_code, status='pending',
            expires_at=now + timedelta(seconds=ttl), interval_seconds=interval,
        )
        result = self.crud.create_device_code(
            row,
            now=now,
            per_minute=current_app.config.get('AGENT_DEVICE_STARTS_PER_MINUTE', 60),
            max_active=current_app.config.get('AGENT_DEVICE_MAX_ACTIVE', 5000),
            retention_hours=current_app.config.get('AGENT_DEVICE_RETENTION_HOURS', 24),
        )
        if result == 'rate_limited':
            raise AgentAuthError('设备登录请求过于频繁，请稍后再试', 429, {'retry_after': 60})
        if result == 'capacity_exceeded':
            raise AgentAuthError('设备登录请求已达容量上限，请稍后再试', 503)
        verify_path = current_app.config.get('AGENT_DEVICE_VERIFY_PATH', '/agent/device-confirm')
        return {
            'device_code': row.device_code, 'user_code': user_code, 'verification_uri': verify_path,
            'verification_uri_complete': f'{verify_path}?user_code={user_code}',
            'expires_in': ttl, 'interval': interval,
        }

    def confirm_device(self, user_id, user_code):
        try:
            code = normalize_user_code(user_code)
        except AgentValidationError as exc:
            raise AgentAuthError(str(exc)) from exc
        row = self.crud.get_device_by_user_code(code)
        if not row:
            raise AgentAuthError('用户码无效', 404)
        if row.expires_at < datetime.utcnow() and row.status in ('pending', 'confirmed'):
            row.status = 'expired'
            self.crud.commit()
            raise AgentAuthError(device_confirmation_message('expired'), 410)
        if row.status != 'pending':
            raise AgentAuthError(device_confirmation_message(row.status), 409)
        if not self.crud.confirm_device(row, user_id=user_id, now=datetime.utcnow()):
            raise AgentAuthError(device_confirmation_message(row.status), 409)
        return {'ok': True, 'user_code': row.user_code}

    def poll_device(self, device_code):
        row = self.crud.get_device_by_device_code(device_code or '')
        if not row:
            raise AgentAuthError('登录请求无效，请重新发起登录', 404)
        now = datetime.utcnow()
        if row.expires_at < now and row.status in ('pending', 'confirmed'):
            row.status = 'expired'
            self.crud.commit()
        if row.status == 'pending':
            raise AgentAuthError('等待你在浏览器中确认授权', 400, {'error_code': 'authorization_pending'})
        if row.status == 'expired':
            raise AgentAuthError('登录请求已过期，请重新发起登录', 400, {'error_code': 'expired_token'})
        if row.status == 'consumed':
            raise AgentAuthError('令牌已领取', 409, {'error_code': 'already_consumed'})
        if row.status != 'confirmed' or not row.user_id:
            raise AgentAuthError('等待你在浏览器中确认授权', 400, {'error_code': 'authorization_pending'})
        raw, prefix, digest = self._mint_raw_token()
        pat = self.Pat(
            user_id=row.user_id, name=f'device-{row.user_code}', token_type='device',
            scopes_json='["chat","profile"]', token_prefix=prefix,
            token_hash=digest, expires_at=now + timedelta(days=30),
        )
        if not self.crud.issue_device_pat(pat, row, now=now, digest=digest, prefix=prefix):
            raise AgentAuthError('令牌已领取', 409, {'error_code': 'already_consumed'})
        user = self.crud.get_user(row.user_id)
        return {'access_token': raw, 'token_type': 'Bearer', 'expires_in': 30 * 86400,
                'user': user.to_dict() if user and hasattr(user, 'to_dict') else {'id': row.user_id}}
