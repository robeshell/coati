"""add image_url to query_managements

Revision ID: f3d2c7a9b001
Revises: c21f9b81d0a4
Create Date: 2026-03-20 10:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'f3d2c7a9b001'
down_revision = 'c21f9b81d0a4'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('query_managements', sa.Column('image_url', sa.String(length=500), nullable=True))


def downgrade():
    op.drop_column('query_managements', 'image_url')
