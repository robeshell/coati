"""add notifications tables

Revision ID: a2b3c4d5e6f7
Revises: 9c8b7a6d5e4f
Create Date: 2026-03-22 10:00:00.000000

"""

from datetime import datetime

from alembic import op
import sqlalchemy as sa


revision = 'a2b3c4d5e6f7'
down_revision = '9c8b7a6d5e4f'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'notifications',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('content', sa.Text(), nullable=True),
        sa.Column('noti_type', sa.String(length=20), nullable=False, server_default='info'),
        sa.Column('link', sa.String(length=500), nullable=True),
        sa.Column('is_global', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['admin_users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )

    op.create_table(
        'notification_reads',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('notification_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('read_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['notification_id'], ['notifications.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['admin_users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('notification_id', 'user_id'),
    )

    # Seed sample global notifications
    bind = op.get_bind()
    now = datetime.utcnow()
    if bind.execute(sa.text("SELECT COUNT(1) FROM notifications")).scalar() == 0:
        bind.execute(
            sa.text(
                """
                INSERT INTO notifications (title, content, noti_type, link, is_global, user_id, created_at)
                VALUES
                    (:t1, :c1, 'success', '/dashboard', true, null, :now),
                    (:t2, :c2, 'info', '/system/users', true, null, :now),
                    (:t3, :c3, 'warning', null, true, null, :now),
                    (:t4, :c4, 'info', '/component-center/ai/chat', true, null, :now)
                """
            ),
            {
                't1': '欢迎使用 coati',
                'c1': '系统已成功部署，所有功能已就绪，欢迎开始使用！',
                't2': '新用户注册提醒',
                'c2': '系统管理员请注意：有新用户在等待审核，请及时前往用户管理页面处理。',
                't3': '系统维护通知',
                'c3': '计划于本周末 02:00-04:00 进行系统维护，期间服务可能短暂中断，请提前做好安排。',
                't4': 'AI 功能已上线',
                'c4': '全新 AI 对话与提示词工坊功能已正式上线，欢迎体验！',
                'now': now,
            }
        )

    # Sync sequences for PostgreSQL
    try:
        op.execute("""
            SELECT setval(
                pg_get_serial_sequence('notifications', 'id'),
                COALESCE((SELECT MAX(id) FROM notifications), 0) + 1,
                false
            )
        """)
        op.execute("""
            SELECT setval(
                pg_get_serial_sequence('notification_reads', 'id'),
                COALESCE((SELECT MAX(id) FROM notification_reads), 0) + 1,
                false
            )
        """)
    except Exception:
        pass


def downgrade():
    op.drop_table('notification_reads')
    op.drop_table('notifications')
