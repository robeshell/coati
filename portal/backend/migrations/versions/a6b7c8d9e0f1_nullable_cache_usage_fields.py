"""preserve the distinction between reported zero and an unreported cache field

Revision ID: a6b7c8d9e0f1
Revises: f5a6b7c8d9
"""

from alembic import op
import sqlalchemy as sa


revision = 'a6b7c8d9e0f1'
down_revision = 'f5a6b7c8d9'
branch_labels = None
depends_on = None


def upgrade():
    for name in ('cache_read_tokens', 'cache_write_tokens', 'cache_miss_tokens'):
        op.alter_column(
            'agent_usage_event',
            name,
            existing_type=sa.Integer(),
            nullable=True,
            server_default=None,
        )


def downgrade():
    # Historical rows use 0 for the old "not reported" representation. Fill
    # future NULLs before restoring the original non-null contract.
    op.execute(sa.text(
        'UPDATE agent_usage_event SET cache_read_tokens = 0 WHERE cache_read_tokens IS NULL'
    ))
    op.execute(sa.text(
        'UPDATE agent_usage_event SET cache_write_tokens = 0 WHERE cache_write_tokens IS NULL'
    ))
    op.execute(sa.text(
        'UPDATE agent_usage_event SET cache_miss_tokens = 0 WHERE cache_miss_tokens IS NULL'
    ))
    for name in ('cache_read_tokens', 'cache_write_tokens', 'cache_miss_tokens'):
        op.alter_column(
            'agent_usage_event',
            name,
            existing_type=sa.Integer(),
            nullable=False,
            server_default='0',
        )
