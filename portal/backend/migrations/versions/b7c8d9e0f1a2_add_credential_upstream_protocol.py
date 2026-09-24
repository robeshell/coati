"""add credential upstream protocol

Revision ID: b7c8d9e0f1a2
Revises: a6b7c8d9e0f1
"""

from alembic import op
import sqlalchemy as sa


revision = 'b7c8d9e0f1a2'
down_revision = 'a6b7c8d9e0f1'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'agent_llm_credential',
        sa.Column('upstream_protocol', sa.String(length=32), nullable=False, server_default='openai-chat'),
    )
    # 旧 provider 曾隐含多套能力；迁移时优先保持历史主路径兼容。
    # URL 明确含 anthropic 的第三方入口（包括 DashScope），或原生 Anthropic
    # provider 才按 Messages 处理；DeepSeek 历史账号主路径是 Chat。
    op.execute(sa.text("""
        UPDATE agent_llm_credential
        SET upstream_protocol = CASE
            WHEN lower(base_url) LIKE '%/anthropic%' THEN 'anthropic-messages'
            WHEN lower(provider) = 'anthropic' THEN 'anthropic-messages'
            WHEN lower(provider) = 'openai' THEN 'openai-chat'
            ELSE 'openai-chat'
        END
    """))
    op.create_index(
        'ix_agent_llm_credential_upstream_protocol',
        'agent_llm_credential', ['upstream_protocol'], unique=False,
    )
    op.add_column('agent_usage_event', sa.Column('inbound_protocol', sa.String(length=32), nullable=True))
    op.add_column('agent_usage_event', sa.Column('upstream_protocol', sa.String(length=32), nullable=True))


def downgrade():
    op.drop_column('agent_usage_event', 'upstream_protocol')
    op.drop_column('agent_usage_event', 'inbound_protocol')
    op.drop_index('ix_agent_llm_credential_upstream_protocol', table_name='agent_llm_credential')
    op.drop_column('agent_llm_credential', 'upstream_protocol')
