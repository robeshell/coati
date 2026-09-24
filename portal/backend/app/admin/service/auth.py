# -*- coding: utf-8 -*-
"""认证模块 service 层"""

from datetime import datetime, timedelta

from flask import current_app
from sqlalchemy import or_

from backend.app.admin.crud.auth import AuthCRUD
from backend.app.admin.schema.auth import validate_change_password_payload


class AuthServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class AuthService:
    def __init__(self, db, admin_model, login_log_model, operation_log_model):
        self.db = db
        self.Admin = admin_model
        self.LoginLog = login_log_model
        self.OperationLog = operation_log_model
        self.crud = AuthCRUD(db, admin_model, login_log_model, operation_log_model)

    def _is_login_blocked(self, username, ip):
        """基于 login_logs 的近窗口失败计数，超过阈值则锁定。

        双维度防护（任一命中即拦截）：
        - IP 维度：同一 IP 的失败总数（防针对多用户名/多账号的分布式撞库）
        - 用户名维度：同一用户名的失败总数（防同一账号多 IP 换着试）
        """
        max_failures = current_app.config.get('LOGIN_MAX_FAILURES', 10)
        lockout_minutes = current_app.config.get('LOGIN_LOCKOUT_MINUTES', 15)
        since = datetime.utcnow() - timedelta(minutes=lockout_minutes)

        base = self.LoginLog.query.filter(
            self.LoginLog.status == 'failed',
            self.LoginLog.created_at >= since,
        )
        if ip and base.filter(self.LoginLog.ip == ip).count() >= max_failures:
            return True
        if username and base.filter(self.LoginLog.username == username).count() >= max_failures:
            return True
        return False

    def _clear_failed_attempts(self, username, ip):
        """登录成功后清零窗口内的失败计数，避免历史误触再次触发限流。"""
        lockout_minutes = current_app.config.get('LOGIN_LOCKOUT_MINUTES', 15)
        since = datetime.utcnow() - timedelta(minutes=lockout_minutes)
        try:
            q = self.LoginLog.query.filter(
                self.LoginLog.status == 'failed',
                self.LoginLog.created_at >= since,
            )
            if username and ip:
                q = q.filter(or_(self.LoginLog.username == username, self.LoginLog.ip == ip))
            elif username or ip:
                q = q.filter(self.LoginLog.username == username) if username \
                    else q.filter(self.LoginLog.ip == ip)
            q.delete(synchronize_session=False)
            self.crud.commit()
        except Exception:
            self.crud.rollback()

    def login(self, username, password, session_obj, client_ip, user_agent):
        if self._is_login_blocked(username, client_ip):
            raise AuthServiceError('登录失败次数过多，请稍后再试', 429)

        user = self.crud.get_admin_by_username(username)

        if user and user.check_password(password):
            session_obj['logged_in'] = True
            session_obj['username'] = username
            # 使 PERMANENT_SESSION_LIFETIME 生效（否则浏览器关闭即失效）
            session_obj.permanent = True
            try:
                self.crud.add_login_log(self.LoginLog(
                    username=username,
                    user_id=user.id,
                    status='success',
                    ip=client_ip,
                    user_agent=user_agent,
                    message='登录成功',
                ))
                self.crud.commit()
                # 登录成功：清零窗口内失败计数，避免历史误触继续限流
                self._clear_failed_attempts(username, client_ip)
            except Exception:
                self.crud.rollback()

            return {
                'message': '登录成功',
                'user': user.to_dict(),
            }, 200

        try:
            self.crud.add_login_log(self.LoginLog(
                username=username or '',
                user_id=user.id if user else None,
                status='failed',
                ip=client_ip,
                user_agent=user_agent,
                message='用户名或密码错误',
            ))
            self.crud.commit()
        except Exception:
            self.crud.rollback()

        raise AuthServiceError('用户名或密码错误', 401)

    def logout(self, username, session_obj, client_ip, user_agent):
        user = self.crud.get_admin_by_username(username) if username else None
        try:
            self.crud.add_operation_log(self.OperationLog(
                username=username or 'unknown',
                user_id=user.id if user else None,
                module='auth',
                action='logout',
                method='POST',
                path='/api/admin/logout',
                target_id=None,
                payload=None,
                ip=client_ip,
                user_agent=user_agent,
                status_code=200,
            ))
            self.crud.commit()
        except Exception:
            self.crud.rollback()

        session_obj.clear()
        return {'message': '已退出登录'}

    def change_password(self, username, data):
        error = validate_change_password_payload(data)
        if error:
            raise AuthServiceError(error, 400)

        old_password = data.get('old_password')
        new_password = data.get('new_password')
        admin = self.crud.get_admin_by_username(username)

        if not admin:
            raise AuthServiceError('用户不存在', 404)
        if not admin.check_password(old_password):
            raise AuthServiceError('旧密码错误', 400)

        try:
            admin.set_password(new_password)
            self.crud.commit()
            return {'message': '密码修改成功'}
        except Exception as e:
            self.crud.rollback()
            raise AuthServiceError(str(e), 500) from e

    def get_current_user(self, username):
        if not username:
            raise AuthServiceError('未登录', 401)
        user = self.crud.get_admin_by_username(username)
        if not user:
            raise AuthServiceError('登录已失效，请重新登录', 401)
        return {'user': user.to_dict()}
