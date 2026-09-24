"""add stats_items table

Revision ID: a1b2c3d4e5f6
Revises: e4c7b1d9a2f3
Create Date: 2026-03-20 15:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a1b2c3d4e5f6'
down_revision = 'e4c7b1d9a2f3'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'stats_items',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(120), nullable=False),
        sa.Column('item_code', sa.String(120), nullable=False),
        sa.Column('category', sa.String(50), nullable=True),
        sa.Column('status', sa.String(20), nullable=False, server_default='draft'),
        sa.Column('amount', sa.Numeric(14, 2), nullable=True, server_default='0'),
        sa.Column('quantity', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('owner', sa.String(100), nullable=True),
        sa.Column('priority', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('is_active', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('item_code'),
    )


def downgrade():
    op.drop_table('stats_items')
