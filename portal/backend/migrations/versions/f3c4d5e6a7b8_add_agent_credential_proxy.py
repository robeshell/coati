"""add per-credential outbound proxy settings

Revision ID: f3c4d5e6a7b8
Revises: d7e8f9a0b1c2
Create Date: 2026-08-25 09:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'f3c4d5e6a7b8'
down_revision = 'd7e8f9a0b1c2'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('agent_llm_credential', sa.Column('proxy_url', sa.Text(), nullable=True))
    op.add_column('agent_llm_credential', sa.Column('proxy_hint', sa.String(length=255), nullable=True))


def downgrade():
    op.drop_column('agent_llm_credential', 'proxy_hint')
    op.drop_column('agent_llm_credential', 'proxy_url')
