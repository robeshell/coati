"""link server-tool usage events to their parent request

Revision ID: c8e9f0a1b2c3
Revises: b7c8d9e0f1a2
"""

from alembic import op
import sqlalchemy as sa


revision = 'c8e9f0a1b2c3'
down_revision = 'b7c8d9e0f1a2'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'agent_usage_event',
        sa.Column('parent_request_id', sa.String(length=64), nullable=True),
    )
    op.create_index(
        'ix_agent_usage_event_parent_request_id',
        'agent_usage_event', ['parent_request_id'], unique=False,
    )


def downgrade():
    op.drop_index(
        'ix_agent_usage_event_parent_request_id',
        table_name='agent_usage_event',
    )
    op.drop_column('agent_usage_event', 'parent_request_id')
