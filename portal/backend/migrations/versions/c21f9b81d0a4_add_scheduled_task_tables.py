"""add scheduled task tables

Revision ID: c21f9b81d0a4
Revises: 8c3a7d67be42
Create Date: 2026-03-19 17:20:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'c21f9b81d0a4'
down_revision = '8c3a7d67be42'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'scheduled_tasks',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('task_code', sa.String(length=120), nullable=False),
        sa.Column('cron_expression', sa.String(length=120), nullable=False),
        sa.Column('request_method', sa.String(length=10), nullable=True),
        sa.Column('request_url', sa.String(length=500), nullable=False),
        sa.Column('request_headers', sa.Text(), nullable=True),
        sa.Column('request_body', sa.Text(), nullable=True),
        sa.Column('timeout_seconds', sa.Integer(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=True),
        sa.Column('remark', sa.Text(), nullable=True),
        sa.Column('last_status', sa.String(length=20), nullable=True),
        sa.Column('last_error', sa.Text(), nullable=True),
        sa.Column('last_duration_ms', sa.Integer(), nullable=True),
        sa.Column('run_count', sa.Integer(), nullable=True),
        sa.Column('last_run_at', sa.DateTime(), nullable=True),
        sa.Column('next_run_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('task_code'),
    )
    op.create_index('ix_scheduled_tasks_is_active', 'scheduled_tasks', ['is_active'], unique=False)
    op.create_index('ix_scheduled_tasks_next_run_at', 'scheduled_tasks', ['next_run_at'], unique=False)

    op.create_table(
        'scheduled_task_runs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('task_id', sa.Integer(), nullable=False),
        sa.Column('trigger_type', sa.String(length=20), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('response_status', sa.Integer(), nullable=True),
        sa.Column('response_body', sa.Text(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('started_at', sa.DateTime(), nullable=True),
        sa.Column('finished_at', sa.DateTime(), nullable=True),
        sa.Column('duration_ms', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['task_id'], ['scheduled_tasks.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_scheduled_task_runs_task_id', 'scheduled_task_runs', ['task_id'], unique=False)
    op.create_index('ix_scheduled_task_runs_status', 'scheduled_task_runs', ['status'], unique=False)


def downgrade():
    op.drop_index('ix_scheduled_task_runs_status', table_name='scheduled_task_runs')
    op.drop_index('ix_scheduled_task_runs_task_id', table_name='scheduled_task_runs')
    op.drop_table('scheduled_task_runs')

    op.drop_index('ix_scheduled_tasks_next_run_at', table_name='scheduled_tasks')
    op.drop_index('ix_scheduled_tasks_is_active', table_name='scheduled_tasks')
    op.drop_table('scheduled_tasks')
