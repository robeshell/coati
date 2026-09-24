"""add ai_prompt_templates table

Revision ID: a3b4c5d6e7f8
Revises: cd4c214908a0
Create Date: 2026-08-01 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a3b4c5d6e7f8'
down_revision = 'cd4c214908a0'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'ai_prompt_templates',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(120), nullable=False),
        sa.Column('category', sa.String(50), nullable=True, server_default='custom'),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('content', sa.Text(), nullable=False),
        # variables 用 JSON 列存储变量定义数组（PostgreSQL 原生 JSON）
        sa.Column('variables', sa.JSON(), nullable=True),
        sa.Column('tags', sa.String(500), nullable=True, server_default=''),
        sa.Column('is_active', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_ai_prompt_templates_category', 'ai_prompt_templates', ['category'])
    op.create_index('ix_ai_prompt_templates_name', 'ai_prompt_templates', ['name'])


def downgrade():
    op.drop_index('ix_ai_prompt_templates_name', table_name='ai_prompt_templates')
    op.drop_index('ix_ai_prompt_templates_category', table_name='ai_prompt_templates')
    op.drop_table('ai_prompt_templates')
