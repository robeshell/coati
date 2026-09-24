"""add personal llm channel owner fields

Revision ID: c5d6e7f8a9b0
Revises: e7f8a9b0c1d2
Create Date: 2026-08-24 13:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'c5d6e7f8a9b0'
down_revision = 'e7f8a9b0c1d2'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'agent_llm_credential',
        sa.Column('scope', sa.String(length=20), nullable=False, server_default='platform'),
    )
    op.add_column(
        'agent_llm_credential',
        sa.Column('owner_user_id', sa.Integer(), nullable=True),
    )
    op.create_index('ix_agent_llm_credential_scope', 'agent_llm_credential', ['scope'])
    op.create_index('ix_agent_llm_credential_owner_user_id', 'agent_llm_credential', ['owner_user_id'])
    op.create_foreign_key(
        'fk_agent_llm_credential_owner_user_id',
        'agent_llm_credential', 'admin_users',
        ['owner_user_id'], ['id'],
    )
    op.add_column(
        'agent_llm_credential',
        sa.Column('model_prefix', sa.String(length=64), nullable=False, server_default=''),
    )
    op.add_column(
        'agent_llm_credential',
        sa.Column('extra_headers_json', sa.Text(), nullable=False, server_default='{}'),
    )


def downgrade():
    op.drop_column('agent_llm_credential', 'extra_headers_json')
    op.drop_column('agent_llm_credential', 'model_prefix')
    op.drop_constraint('fk_agent_llm_credential_owner_user_id', 'agent_llm_credential', type_='foreignkey')
    op.drop_index('ix_agent_llm_credential_owner_user_id', table_name='agent_llm_credential')
    op.drop_index('ix_agent_llm_credential_scope', table_name='agent_llm_credential')
    op.drop_column('agent_llm_credential', 'owner_user_id')
    op.drop_column('agent_llm_credential', 'scope')
