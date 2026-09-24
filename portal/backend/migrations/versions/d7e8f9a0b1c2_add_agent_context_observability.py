"""add agent context observability fields

Revision ID: d7e8f9a0b1c2
Revises: c5d6e7f8a9b0
Create Date: 2026-08-24 22:20:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'd7e8f9a0b1c2'
down_revision = 'c5d6e7f8a9b0'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('agent_usage_event', sa.Column('client_request_id', sa.String(length=128), nullable=True))
    op.add_column('agent_usage_event', sa.Column('step_index', sa.Integer(), nullable=True))
    op.add_column('agent_usage_event', sa.Column('retry_index', sa.Integer(), nullable=True))
    op.create_index('ix_agent_usage_event_client_request_id', 'agent_usage_event', ['client_request_id'])

    columns = (
        ('context_tokens_estimate', sa.Integer()),
        ('context_bytes', sa.Integer()),
        ('message_count', sa.Integer()),
        ('tool_count', sa.Integer()),
        ('image_count', sa.Integer()),
        ('tool_result_bytes', sa.Integer()),
        ('largest_message_bytes', sa.Integer()),
        ('cache_read_tokens', sa.Integer()),
        ('cache_write_tokens', sa.Integer()),
        ('cache_miss_tokens', sa.Integer()),
    )
    for name, column_type in columns:
        op.add_column(
            'agent_usage_event',
            sa.Column(name, column_type, nullable=False, server_default='0'),
        )


def downgrade():
    for name in (
        'cache_miss_tokens', 'cache_write_tokens', 'cache_read_tokens',
        'largest_message_bytes', 'tool_result_bytes', 'image_count',
        'tool_count', 'message_count', 'context_bytes', 'context_tokens_estimate',
    ):
        op.drop_column('agent_usage_event', name)
    op.drop_index('ix_agent_usage_event_client_request_id', table_name='agent_usage_event')
    op.drop_column('agent_usage_event', 'retry_index')
    op.drop_column('agent_usage_event', 'step_index')
    op.drop_column('agent_usage_event', 'client_request_id')
