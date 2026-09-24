"""add card_items table

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-03-20 16:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b2c3d4e5f6a7'
down_revision = 'a1b2c3d4e5f6'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'card_items',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(120), nullable=False),
        sa.Column('card_code', sa.String(120), nullable=False),
        sa.Column('subtitle', sa.String(200), nullable=True),
        sa.Column('category', sa.String(50), nullable=True),
        sa.Column('cover_url', sa.String(500), nullable=True),
        sa.Column('tag', sa.String(50), nullable=True),
        sa.Column('status', sa.String(20), nullable=False, server_default='draft'),
        sa.Column('owner', sa.String(100), nullable=True),
        sa.Column('priority', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('is_active', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('card_code'),
    )


def downgrade():
    op.drop_table('card_items')
