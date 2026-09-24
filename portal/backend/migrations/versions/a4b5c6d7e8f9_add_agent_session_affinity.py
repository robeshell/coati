"""add agent session affinity bindings

Revision ID: a4b5c6d7e8f9
Revises: f3c4d5e6a7b8
Create Date: 2026-08-25 11:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'a4b5c6d7e8f9'
down_revision = 'f3c4d5e6a7b8'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'agent_session_affinity',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.String(length=64), nullable=False),
        sa.Column('model_key', sa.String(length=255), nullable=False),
        sa.Column('credential_id', sa.Integer(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column(
            'created_at', sa.DateTime(), nullable=False,
            server_default=sa.text('CURRENT_TIMESTAMP'),
        ),
        sa.Column(
            'updated_at', sa.DateTime(), nullable=False,
            server_default=sa.text('CURRENT_TIMESTAMP'),
        ),
        sa.ForeignKeyConstraint(
            ['credential_id'], ['agent_llm_credential.id'],
            name='fk_agent_session_affinity_credential_id', ondelete='CASCADE',
        ),
        sa.ForeignKeyConstraint(
            ['user_id'], ['admin_users.id'],
            name='fk_agent_session_affinity_user_id', ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'user_id', 'session_id', 'model_key',
            name='uq_agent_session_affinity_key',
        ),
    )
    op.create_index(
        'ix_agent_session_affinity_credential_id',
        'agent_session_affinity', ['credential_id'], unique=False,
    )
    op.create_index(
        'ix_agent_session_affinity_expires_at',
        'agent_session_affinity', ['expires_at'], unique=False,
    )


def downgrade():
    op.drop_index(
        'ix_agent_session_affinity_expires_at',
        table_name='agent_session_affinity',
    )
    op.drop_index(
        'ix_agent_session_affinity_credential_id',
        table_name='agent_session_affinity',
    )
    op.drop_table('agent_session_affinity')
