"""add agent control-plane tables

Revision ID: b7e8f9a0c1d2
Revises: 5a9f3c2e8d71
Create Date: 2026-08-20 17:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'b7e8f9a0c1d2'
down_revision = '5a9f3c2e8d71'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'agent_pat',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('token_prefix', sa.String(length=16), nullable=False),
        sa.Column('token_hash', sa.String(length=128), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=True),
        sa.Column('revoked_at', sa.DateTime(), nullable=True),
        sa.Column('last_used_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['admin_users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token_hash'),
    )
    op.create_index('ix_agent_pat_user_id', 'agent_pat', ['user_id'])
    op.create_index('ix_agent_pat_token_hash', 'agent_pat', ['token_hash'])

    op.create_table(
        'agent_device_code',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('device_code', sa.String(length=64), nullable=False),
        sa.Column('user_code', sa.String(length=32), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('access_token_hash', sa.String(length=128), nullable=True),
        sa.Column('access_token_prefix', sa.String(length=16), nullable=True),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('interval_seconds', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('confirmed_at', sa.DateTime(), nullable=True),
        sa.Column('consumed_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['admin_users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('device_code'),
        sa.UniqueConstraint('user_code'),
    )
    op.create_index('ix_agent_device_code_device_code', 'agent_device_code', ['device_code'])
    op.create_index('ix_agent_device_code_user_code', 'agent_device_code', ['user_code'])
    op.create_index('ix_agent_device_code_user_id', 'agent_device_code', ['user_id'])

    op.create_table(
        'agent_usage_event',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.String(length=64), nullable=True),
        sa.Column('idempotency_key', sa.String(length=128), nullable=True),
        sa.Column('model', sa.String(length=128), nullable=True),
        sa.Column('prompt_tokens', sa.Integer(), nullable=False),
        sa.Column('completion_tokens', sa.Integer(), nullable=False),
        sa.Column('total_tokens', sa.Integer(), nullable=False),
        sa.Column('latency_ms', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False),
        sa.Column('source', sa.String(length=32), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['admin_users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('idempotency_key'),
    )
    op.create_index('ix_agent_usage_event_user_id', 'agent_usage_event', ['user_id'])
    op.create_index('ix_agent_usage_event_session_id', 'agent_usage_event', ['session_id'])
    op.create_index('ix_agent_usage_event_created_at', 'agent_usage_event', ['created_at'])

    op.create_table(
        'agent_route_config',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('model_name', sa.String(length=128), nullable=False),
        sa.Column('upstream_base', sa.String(length=512), nullable=True),
        sa.Column('upstream_model', sa.String(length=128), nullable=True),
        sa.Column('weight', sa.Integer(), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('model_name'),
    )
    op.create_index('ix_agent_route_config_model_name', 'agent_route_config', ['model_name'])


def downgrade():
    op.drop_table('agent_route_config')
    op.drop_table('agent_usage_event')
    op.drop_table('agent_device_code')
    op.drop_table('agent_pat')
