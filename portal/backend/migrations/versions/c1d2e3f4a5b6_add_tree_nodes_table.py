"""add tree_nodes table

Revision ID: c1d2e3f4a5b6
Revises: b2c3d4e5f6a7
Create Date: 2026-03-20 17:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'c1d2e3f4a5b6'
down_revision = 'b2c3d4e5f6a7'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'tree_nodes',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('node_code', sa.String(120), nullable=False),
        sa.Column('parent_id', sa.Integer(), nullable=True),
        sa.Column('node_type', sa.String(50), nullable=True, server_default='category'),
        sa.Column('icon', sa.String(100), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('is_active', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('status', sa.String(20), nullable=True, server_default='active'),
        sa.Column('owner', sa.String(100), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('node_code'),
        sa.ForeignKeyConstraint(['parent_id'], ['tree_nodes.id'], ondelete='SET NULL'),
    )


def downgrade():
    op.drop_table('tree_nodes')
