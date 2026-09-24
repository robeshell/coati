"""add app_settings

Revision ID: a2b3c4d5e6f8
Revises: f2b3c4d5e6f7
Create Date: 2026-08-22 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'a2b3c4d5e6f8'
down_revision = 'f2b3c4d5e6f7'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'app_settings',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('key', sa.String(length=100), nullable=False),
        sa.Column('value', sa.Text(), nullable=True),
        sa.Column('description', sa.String(length=200), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('key', name='uq_app_settings_key'),
    )


def downgrade():
    op.drop_table('app_settings')
