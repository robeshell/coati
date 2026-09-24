"""add file_url and file_urls to query_managements

Revision ID: b6c8d91a7f22
Revises: a91d4f6c2e10
Create Date: 2026-03-20 12:05:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b6c8d91a7f22'
down_revision = 'a91d4f6c2e10'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('query_managements', sa.Column('file_url', sa.String(length=500), nullable=True))
    op.add_column('query_managements', sa.Column('file_urls', sa.Text(), nullable=True))


def downgrade():
    op.drop_column('query_managements', 'file_urls')
    op.drop_column('query_managements', 'file_url')
