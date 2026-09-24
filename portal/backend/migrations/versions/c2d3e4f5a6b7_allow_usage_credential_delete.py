"""preserve usage history when deleting credentials

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
"""

from alembic import op


revision = 'c2d3e4f5a6b7'
down_revision = 'b1c2d3e4f5a6'
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint(
        'fk_agent_usage_event_credential_id',
        'agent_usage_event',
        type_='foreignkey',
    )
    op.create_foreign_key(
        'fk_agent_usage_event_credential_id',
        'agent_usage_event',
        'agent_llm_credential',
        ['credential_id'],
        ['id'],
        ondelete='SET NULL',
    )


def downgrade():
    op.drop_constraint(
        'fk_agent_usage_event_credential_id',
        'agent_usage_event',
        type_='foreignkey',
    )
    op.create_foreign_key(
        'fk_agent_usage_event_credential_id',
        'agent_usage_event',
        'agent_llm_credential',
        ['credential_id'],
        ['id'],
    )
