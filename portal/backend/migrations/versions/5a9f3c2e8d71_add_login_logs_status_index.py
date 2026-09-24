"""add login_logs status/created_at index

Revision ID: 5a9f3c2e8d71
Revises: a3b4c5d6e7f8
Create Date: 2026-08-01 21:30:00.000000

"""

from alembic import op


revision = '5a9f3c2e8d71'
down_revision = 'a3b4c5d6e7f8'
branch_labels = None
depends_on = None


def upgrade():
    # 登录限流查询（status + 时间窗口）与登录日志筛选共用
    op.create_index(
        'ix_login_logs_status_created_at',
        'login_logs',
        ['status', 'created_at'],
    )


def downgrade():
    op.drop_index('ix_login_logs_status_created_at', table_name='login_logs')
