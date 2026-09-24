# -*- coding: utf-8 -*-
"""审计日志模型定义"""

from datetime import datetime


def build_audit_log_models(db):
    class LoginLog(db.Model):
        __tablename__ = 'login_logs'
        # 登录限流查询（status + 时间窗口）与登录日志列表排序共用
        __table_args__ = (
            db.Index('ix_login_logs_status_created_at', 'status', 'created_at'),
        )

        id = db.Column(db.Integer, primary_key=True)
        username = db.Column(db.String(100), nullable=False)
        user_id = db.Column(db.Integer, db.ForeignKey('admin_users.id', ondelete='SET NULL'))
        status = db.Column(db.String(20), nullable=False, default='success')
        ip = db.Column(db.String(64))
        user_agent = db.Column(db.String(500))
        message = db.Column(db.String(500))
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'username': self.username,
                'user_id': self.user_id,
                'status': self.status,
                'ip': self.ip,
                'user_agent': self.user_agent,
                'message': self.message,
                'created_at': self.created_at.isoformat() if self.created_at else None,
            }

    class OperationLog(db.Model):
        __tablename__ = 'operation_logs'

        id = db.Column(db.Integer, primary_key=True)
        username = db.Column(db.String(100), nullable=False)
        user_id = db.Column(db.Integer, db.ForeignKey('admin_users.id', ondelete='SET NULL'))
        module = db.Column(db.String(100), nullable=False)
        action = db.Column(db.String(50), nullable=False)
        method = db.Column(db.String(10), nullable=False)
        path = db.Column(db.String(255), nullable=False)
        target_id = db.Column(db.String(100))
        payload = db.Column(db.Text)
        ip = db.Column(db.String(64))
        user_agent = db.Column(db.String(500))
        status_code = db.Column(db.Integer)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

        def to_dict(self):
            return {
                'id': self.id,
                'username': self.username,
                'user_id': self.user_id,
                'module': self.module,
                'action': self.action,
                'method': self.method,
                'path': self.path,
                'target_id': self.target_id,
                'payload': self.payload,
                'ip': self.ip,
                'user_agent': self.user_agent,
                'status_code': self.status_code,
                'created_at': self.created_at.isoformat() if self.created_at else None,
            }

    return {
        'LoginLog': LoginLog,
        'OperationLog': OperationLog,
    }
