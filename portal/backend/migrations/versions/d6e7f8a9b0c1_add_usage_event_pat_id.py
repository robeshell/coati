"""add agent_usage_event.pat_id

Revision ID: d6e7f8a9b0c1
Revises: c4d5e6f7a8b0
Create Date: 2026-08-22 08:50:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'd6e7f8a9b0c1'
down_revision = 'c4d5e6f7a8b0'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('agent_usage_event', sa.Column('pat_id', sa.Integer(), nullable=True))
    op.create_index('ix_agent_usage_event_pat_id', 'agent_usage_event', ['pat_id'])
    op.create_foreign_key(
        'fk_agent_usage_event_pat_id',
        'agent_usage_event', 'agent_pat',
        ['pat_id'], ['id'], ondelete='SET NULL',
    )


def downgrade():
    op.drop_constraint('fk_agent_usage_event_pat_id', 'agent_usage_event', type_='foreignkey')
    op.drop_index('ix_agent_usage_event_pat_id', table_name='agent_usage_event')
    op.drop_column('agent_usage_event', 'pat_id')
