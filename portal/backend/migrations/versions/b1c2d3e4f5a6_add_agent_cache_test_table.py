"""add agent cache test table

Revision ID: b1c2d3e4f5a6
Revises: a4b5c6d7e8f9
Create Date: 2026-09-08 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'b1c2d3e4f5a6'
down_revision = 'a4b5c6d7e8f9'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'agent_cache_test',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('model', sa.String(length=128), nullable=False),
        sa.Column('prompt', sa.Text(), nullable=False),
        sa.Column('rounds', sa.Integer(), nullable=False, server_default='3'),
        sa.Column('max_tokens', sa.Integer(), nullable=False, server_default='32'),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='ok'),
        sa.Column('summary_json', sa.Text(), nullable=False, server_default='{}'),
        sa.Column('rounds_json', sa.Text(), nullable=False, server_default='[]'),
        sa.Column('error_summary', sa.String(length=500), nullable=True),
        sa.Column(
            'created_at', sa.DateTime(), nullable=False,
            server_default=sa.text('CURRENT_TIMESTAMP'),
        ),
        sa.ForeignKeyConstraint(
            ['user_id'], ['admin_users.id'],
            name='fk_agent_cache_test_user_id', ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_agent_cache_test_user_id',
        'agent_cache_test', ['user_id'], unique=False,
    )
    op.create_index(
        'ix_agent_cache_test_created_at',
        'agent_cache_test', ['created_at'], unique=False,
    )


def downgrade():
    op.drop_index('ix_agent_cache_test_created_at', table_name='agent_cache_test')
    op.drop_index('ix_agent_cache_test_user_id', table_name='agent_cache_test')
    op.drop_table('agent_cache_test')
