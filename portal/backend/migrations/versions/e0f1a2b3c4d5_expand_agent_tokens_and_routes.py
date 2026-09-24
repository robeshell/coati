"""expand agent tokens and routes

Revision ID: e0f1a2b3c4d5
Revises: d9e0f1a2b3c4
Create Date: 2026-08-20 22:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'e0f1a2b3c4d5'
down_revision = 'd9e0f1a2b3c4'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('agent_pat', sa.Column('token_type', sa.String(length=20), nullable=False, server_default='personal'))
    op.add_column('agent_pat', sa.Column('scopes_json', sa.Text(), nullable=False, server_default='["chat","usage","profile"]'))
    op.add_column('agent_pat', sa.Column('note', sa.String(length=255), nullable=True))
    op.execute("UPDATE agent_pat SET token_type = 'device' WHERE name LIKE 'device-%'")

    op.add_column('agent_route_config', sa.Column('description', sa.String(length=255), nullable=True))
    op.add_column('agent_route_config', sa.Column('fallback_enabled', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    op.drop_column('agent_route_config', 'fallback_enabled')
    op.drop_column('agent_route_config', 'description')
    op.drop_column('agent_pat', 'note')
    op.drop_column('agent_pat', 'scopes_json')
    op.drop_column('agent_pat', 'token_type')
