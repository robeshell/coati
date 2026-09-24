"""add dynamic_form_records and dynamic_form_fields tables

Revision ID: d2e3f4a5b6c7
Revises: c1d2e3f4a5b6
Create Date: 2026-03-20 18:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'd2e3f4a5b6c7'
down_revision = 'c1d2e3f4a5b6'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'dynamic_form_records',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(120), nullable=False),
        sa.Column('record_code', sa.String(120), nullable=False),
        sa.Column('category', sa.String(50), nullable=True, server_default='general'),
        sa.Column('status', sa.String(20), nullable=False, server_default='draft'),
        sa.Column('owner', sa.String(100), nullable=True),
        sa.Column('priority', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('is_active', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('record_code'),
    )
    op.create_table(
        'dynamic_form_fields',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('record_id', sa.Integer(), nullable=False),
        sa.Column('field_key', sa.String(100), nullable=True),
        sa.Column('field_value', sa.String(500), nullable=True),
        sa.Column('field_type', sa.String(50), nullable=True, server_default='text'),
        sa.Column('sort_order', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('remark', sa.String(200), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['record_id'], ['dynamic_form_records.id'], ondelete='CASCADE'),
    )


def downgrade():
    op.drop_table('dynamic_form_fields')
    op.drop_table('dynamic_form_records')
