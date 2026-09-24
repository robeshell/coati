"""drop agent_llm_credential.multimodal_models_json

Revision ID: e7f8a9b0c1d2
Revises: d6e7f8a9b0c1
Create Date: 2026-08-22 09:06:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'e7f8a9b0c1d2'
down_revision = 'd6e7f8a9b0c1'
branch_labels = None
depends_on = None


def upgrade():
    op.drop_column('agent_llm_credential', 'multimodal_models_json')


def downgrade():
    op.add_column(
        'agent_llm_credential',
        sa.Column('multimodal_models_json', sa.Text(), nullable=False, server_default='[]'),
    )
