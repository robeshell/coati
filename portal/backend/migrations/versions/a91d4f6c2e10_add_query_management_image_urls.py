"""add image_urls to query_managements

Revision ID: a91d4f6c2e10
Revises: f3d2c7a9b001
Create Date: 2026-03-20 11:20:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a91d4f6c2e10'
down_revision = 'f3d2c7a9b001'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('query_managements', sa.Column('image_urls', sa.Text(), nullable=True))


def downgrade():
    op.drop_column('query_managements', 'image_urls')
