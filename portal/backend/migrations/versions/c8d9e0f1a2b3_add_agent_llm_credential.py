"""add agent llm credential pool

Revision ID: c8d9e0f1a2b3
Revises: b7e8f9a0c1d2
Create Date: 2026-08-20 17:15:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'c8d9e0f1a2b3'
down_revision = 'b7e8f9a0c1d2'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'agent_llm_credential',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('provider', sa.String(length=64), nullable=False),
        sa.Column('base_url', sa.String(length=512), nullable=False),
        sa.Column('api_key', sa.Text(), nullable=False),
        sa.Column('default_model', sa.String(length=128), nullable=False),
        sa.Column('weight', sa.Integer(), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False),
        sa.Column('note', sa.String(length=255), nullable=True),
        sa.Column('last_used_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.add_column('agent_usage_event', sa.Column('credential_id', sa.Integer(), nullable=True))
    op.create_index('ix_agent_usage_event_credential_id', 'agent_usage_event', ['credential_id'])
    op.create_foreign_key(
        'fk_agent_usage_event_credential_id',
        'agent_usage_event', 'agent_llm_credential',
        ['credential_id'], ['id'],
    )
    op.add_column('agent_route_config', sa.Column('credential_id', sa.Integer(), nullable=True))
    op.create_index('ix_agent_route_config_credential_id', 'agent_route_config', ['credential_id'])
    op.create_foreign_key(
        'fk_agent_route_config_credential_id',
        'agent_route_config', 'agent_llm_credential',
        ['credential_id'], ['id'],
    )


def downgrade():
    op.drop_constraint('fk_agent_route_config_credential_id', 'agent_route_config', type_='foreignkey')
    op.drop_index('ix_agent_route_config_credential_id', table_name='agent_route_config')
    op.drop_column('agent_route_config', 'credential_id')
    op.drop_constraint('fk_agent_usage_event_credential_id', 'agent_usage_event', type_='foreignkey')
    op.drop_index('ix_agent_usage_event_credential_id', table_name='agent_usage_event')
    op.drop_column('agent_usage_event', 'credential_id')
    op.drop_table('agent_llm_credential')
