"""add agent request trace and user quota

Revision ID: f1a2b3c4d5e6
Revises: e0f1a2b3c4d5
Create Date: 2026-08-21 09:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'f1a2b3c4d5e6'
down_revision = 'e0f1a2b3c4d5'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('agent_usage_event', sa.Column('request_id', sa.String(length=64), nullable=True))
    op.add_column('agent_usage_event', sa.Column('upstream_model', sa.String(length=128), nullable=True))
    op.add_column('agent_usage_event', sa.Column('route_id', sa.Integer(), nullable=True))
    op.add_column('agent_usage_event', sa.Column('http_status', sa.Integer(), nullable=True))
    op.add_column('agent_usage_event', sa.Column('error_summary', sa.String(length=500), nullable=True))
    op.add_column('agent_usage_event', sa.Column('attempt_count', sa.Integer(), nullable=False, server_default='1'))
    op.add_column('agent_usage_event', sa.Column('fallback_used', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.execute("UPDATE agent_usage_event SET request_id = 'legacy_' || id::text WHERE request_id IS NULL")
    op.alter_column('agent_usage_event', 'request_id', nullable=False)
    op.create_index('ix_agent_usage_event_request_id', 'agent_usage_event', ['request_id'], unique=True)
    op.create_index('ix_agent_usage_event_route_id', 'agent_usage_event', ['route_id'], unique=False)
    op.create_foreign_key(
        'fk_agent_usage_event_route_id', 'agent_usage_event', 'agent_route_config',
        ['route_id'], ['id'], ondelete='SET NULL',
    )

    op.create_table(
        'agent_user_quota',
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('daily_token_quota', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['admin_users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('user_id'),
    )


def downgrade():
    op.drop_table('agent_user_quota')
    op.drop_constraint('fk_agent_usage_event_route_id', 'agent_usage_event', type_='foreignkey')
    op.drop_index('ix_agent_usage_event_route_id', table_name='agent_usage_event')
    op.drop_index('ix_agent_usage_event_request_id', table_name='agent_usage_event')
    op.drop_column('agent_usage_event', 'fallback_used')
    op.drop_column('agent_usage_event', 'attempt_count')
    op.drop_column('agent_usage_event', 'error_summary')
    op.drop_column('agent_usage_event', 'http_status')
    op.drop_column('agent_usage_event', 'route_id')
    op.drop_column('agent_usage_event', 'upstream_model')
    op.drop_column('agent_usage_event', 'request_id')
