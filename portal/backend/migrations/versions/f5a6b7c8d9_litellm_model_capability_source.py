"""add LiteLLM defaults and administrator overrides to model profiles

Revision ID: f5a6b7c8d9
Revises: e4f5a6b7c8d9
"""

from alembic import op
import sqlalchemy as sa


revision = 'f5a6b7c8d9'
down_revision = 'e4f5a6b7c8d9'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('agent_model_profile', sa.Column('context_window_override', sa.Integer(), nullable=True))
    op.add_column('agent_model_profile', sa.Column('max_output_tokens_override', sa.Integer(), nullable=True))
    op.add_column('agent_model_profile', sa.Column('litellm_model_name', sa.String(length=255), nullable=True))
    op.add_column('agent_model_profile', sa.Column('litellm_context_window', sa.Integer(), nullable=True))
    op.add_column('agent_model_profile', sa.Column('litellm_max_output_tokens', sa.Integer(), nullable=True))
    op.add_column('agent_model_profile', sa.Column('litellm_synced_at', sa.DateTime(), nullable=True))

    # Existing rows were explicitly configured by an administrator before the
    # LiteLLM source existed. Preserve their effective values as overrides.
    op.execute(sa.text(
        'UPDATE agent_model_profile '
        'SET context_window_override = context_window, '
        '    max_output_tokens_override = max_output_tokens'
    ))


def downgrade():
    op.drop_column('agent_model_profile', 'litellm_synced_at')
    op.drop_column('agent_model_profile', 'litellm_max_output_tokens')
    op.drop_column('agent_model_profile', 'litellm_context_window')
    op.drop_column('agent_model_profile', 'litellm_model_name')
    op.drop_column('agent_model_profile', 'max_output_tokens_override')
    op.drop_column('agent_model_profile', 'context_window_override')
