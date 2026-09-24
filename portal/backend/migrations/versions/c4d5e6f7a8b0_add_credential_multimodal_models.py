"""add credential multimodal_models_json

Revision ID: c4d5e6f7a8b0
Revises: b3c4d5e6f8a9
Create Date: 2026-08-22 07:10:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'c4d5e6f7a8b0'
down_revision = 'b3c4d5e6f8a9'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'agent_llm_credential',
        sa.Column('multimodal_models_json', sa.Text(), nullable=False, server_default='[]'),
    )


def downgrade():
    op.drop_column('agent_llm_credential', 'multimodal_models_json')
