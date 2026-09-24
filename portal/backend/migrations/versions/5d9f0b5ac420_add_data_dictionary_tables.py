"""add data dictionary tables

Revision ID: 5d9f0b5ac420
Revises: 341b7e3b8297
Create Date: 2026-03-19 11:45:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '5d9f0b5ac420'
down_revision = '341b7e3b8297'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'dict_types',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('code', sa.String(length=100), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('code')
    )

    op.create_table(
        'dict_items',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('dict_type_id', sa.Integer(), nullable=False),
        sa.Column('label', sa.String(length=100), nullable=False),
        sa.Column('value', sa.String(length=100), nullable=False),
        sa.Column('color', sa.String(length=30), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=True),
        sa.Column('is_default', sa.Boolean(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['dict_type_id'], ['dict_types.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('dict_type_id', 'value', name='uq_dict_items_type_value')
    )
    op.create_index('ix_dict_items_dict_type_id', 'dict_items', ['dict_type_id'], unique=False)


def downgrade():
    op.drop_index('ix_dict_items_dict_type_id', table_name='dict_items')
    op.drop_table('dict_items')
    op.drop_table('dict_types')
