"""add per-account model capability declarations

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
"""

from alembic import op
import sqlalchemy as sa


revision = 'd3e4f5a6b7c8'
down_revision = 'c2d3e4f5a6b7'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'agent_llm_credential',
        sa.Column('model_capabilities_json', sa.Text(), nullable=False, server_default='{}'),
    )


def downgrade():
    op.drop_column('agent_llm_credential', 'model_capabilities_json')
