"""add query management table

Revision ID: 8c3a7d67be42
Revises: 5d9f0b5ac420
Create Date: 2026-03-19 15:20:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '8c3a7d67be42'
down_revision = '5d9f0b5ac420'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'query_managements',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('query_code', sa.String(length=120), nullable=False),
        sa.Column('category', sa.String(length=50), nullable=True),
        sa.Column('keyword', sa.String(length=200), nullable=True),
        sa.Column('data_source', sa.String(length=100), nullable=True),
        sa.Column('owner', sa.String(length=100), nullable=True),
        sa.Column('priority', sa.Integer(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('query_code'),
    )
    op.create_index('ix_query_managements_category', 'query_managements', ['category'], unique=False)
    op.create_index('ix_query_managements_owner', 'query_managements', ['owner'], unique=False)
    op.create_index('ix_query_managements_is_active', 'query_managements', ['is_active'], unique=False)


def downgrade():
    op.drop_index('ix_query_managements_is_active', table_name='query_managements')
    op.drop_index('ix_query_managements_owner', table_name='query_managements')
    op.drop_index('ix_query_managements_category', table_name='query_managements')
    op.drop_table('query_managements')
