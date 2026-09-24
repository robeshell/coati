"""add agent route vision_model

Revision ID: b3c4d5e6f8a9
Revises: a2b3c4d5e6f8
Create Date: 2026-08-21 19:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'b3c4d5e6f8a9'
down_revision = 'a2b3c4d5e6f8'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('agent_route_config', sa.Column('vision_model', sa.String(length=128), nullable=True))


def downgrade():
    op.drop_column('agent_route_config', 'vision_model')
