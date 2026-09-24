"""add unified model capability profiles

Revision ID: e4f5a6b7c8d9
Revises: d3e4f5a6b7c8
"""

import json

from alembic import op
import sqlalchemy as sa


revision = 'e4f5a6b7c8d9'
down_revision = 'd3e4f5a6b7c8'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'agent_model_profile',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('model_name', sa.String(length=128), nullable=False),
        sa.Column('context_window', sa.Integer(), nullable=False, server_default='131072'),
        sa.Column('max_output_tokens', sa.Integer(), nullable=False, server_default='8192'),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('note', sa.String(length=255), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('model_name', name='uq_agent_model_profile_model_name'),
    )
    op.create_index('ix_agent_model_profile_model_name', 'agent_model_profile', ['model_name'])

    # The former account-level field is retained for old clients, but its values
    # are merged once into the platform table.  A smaller declaration wins so a
    # shared model is never advertised beyond the safest configured account.
    bind = op.get_bind()
    rows = bind.execute(sa.text('SELECT model_capabilities_json FROM agent_llm_credential')).fetchall()
    merged = {}
    for (raw,) in rows:
        try:
            values = json.loads(raw or '{}')
        except (TypeError, ValueError):
            values = {}
        if not isinstance(values, dict):
            continue
        for model, profile in values.items():
            if not isinstance(profile, dict):
                continue
            try:
                context_window = int(profile.get('context_window') or 0)
                max_output_tokens = int(profile.get('max_output_tokens') or 8192)
            except (TypeError, ValueError):
                continue
            if not model or context_window <= 0 or max_output_tokens <= 0:
                continue
            model = str(model)
            current = merged.get(model)
            if current is None:
                merged[model] = {
                    'context_window': context_window,
                    'max_output_tokens': max_output_tokens,
                }
            else:
                current['context_window'] = min(current['context_window'], context_window)
                current['max_output_tokens'] = min(current['max_output_tokens'], max_output_tokens)

    if merged:
        table = sa.table(
            'agent_model_profile',
            sa.column('model_name', sa.String()),
            sa.column('context_window', sa.Integer()),
            sa.column('max_output_tokens', sa.Integer()),
        )
        op.bulk_insert(table, [
            {'model_name': model, **profile} for model, profile in sorted(merged.items())
        ])


def downgrade():
    op.drop_index('ix_agent_model_profile_model_name', table_name='agent_model_profile')
    op.drop_table('agent_model_profile')
