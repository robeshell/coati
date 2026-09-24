"""expand and encrypt agent credentials

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3
Create Date: 2026-08-20 21:45:00.000000

"""
import base64
import hashlib
import json

from alembic import op
from cryptography.fernet import Fernet
from flask import current_app
import sqlalchemy as sa


revision = 'd9e0f1a2b3c4'
down_revision = 'c8d9e0f1a2b3'
branch_labels = None
depends_on = None

PREFIX = 'enc:v1:'


def _fernet():
    material = str(current_app.config.get('AGENT_CREDENTIAL_ENCRYPTION_KEY') or '').strip()
    if not material:
        raise RuntimeError('迁移上游凭证前必须配置 AGENT_CREDENTIAL_ENCRYPTION_KEY')
    key = base64.urlsafe_b64encode(hashlib.sha256(material.encode('utf-8')).digest())
    return Fernet(key)


def _hint(raw):
    return '****' if len(raw) <= 8 else f'{raw[:4]}…{raw[-4:]}'


def upgrade():
    op.add_column('agent_llm_credential', sa.Column('api_key_hint', sa.String(length=32), nullable=False, server_default='****'))
    op.add_column('agent_llm_credential', sa.Column('key_fingerprint', sa.String(length=64), nullable=True))
    op.add_column('agent_llm_credential', sa.Column('models_json', sa.Text(), nullable=False, server_default='[]'))
    op.add_column('agent_llm_credential', sa.Column('tags_json', sa.Text(), nullable=False, server_default='[]'))
    op.add_column('agent_llm_credential', sa.Column('priority', sa.Integer(), nullable=False, server_default='100'))
    op.add_column('agent_llm_credential', sa.Column('request_timeout_seconds', sa.Integer(), nullable=False, server_default='120'))
    op.add_column('agent_llm_credential', sa.Column('health_status', sa.String(length=20), nullable=False, server_default='unknown'))
    op.add_column('agent_llm_credential', sa.Column('consecutive_failures', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('agent_llm_credential', sa.Column('last_checked_at', sa.DateTime(), nullable=True))
    op.add_column('agent_llm_credential', sa.Column('last_success_at', sa.DateTime(), nullable=True))
    op.add_column('agent_llm_credential', sa.Column('last_error_at', sa.DateTime(), nullable=True))
    op.add_column('agent_llm_credential', sa.Column('last_error', sa.Text(), nullable=True))
    op.add_column('agent_llm_credential', sa.Column('last_latency_ms', sa.Integer(), nullable=True))
    op.add_column('agent_llm_credential', sa.Column('cooldown_until', sa.DateTime(), nullable=True))
    op.create_index('ix_agent_llm_credential_key_fingerprint', 'agent_llm_credential', ['key_fingerprint'])

    bind = op.get_bind()
    rows = bind.execute(sa.text('SELECT id, api_key, default_model FROM agent_llm_credential')).mappings().all()
    cipher = _fernet()
    for row in rows:
        stored = str(row['api_key'] or '')
        raw = cipher.decrypt(stored[len(PREFIX):].encode('ascii')).decode('utf-8') if stored.startswith(PREFIX) else stored
        encrypted = stored
        if stored and not stored.startswith(PREFIX):
            encrypted = PREFIX + cipher.encrypt(stored.encode('utf-8')).decode('ascii')
        fingerprint = hashlib.sha256(raw.encode('utf-8')).hexdigest()
        default_model = 'deepseek-v4-pro' if row['default_model'] in (None, '', 'deepseek-chat', 'deepseek-reasoner') else row['default_model']
        models = json.dumps([default_model] if default_model else [], ensure_ascii=False)
        bind.execute(
            sa.text('''
                UPDATE agent_llm_credential
                SET api_key = :encrypted, api_key_hint = :hint,
                    key_fingerprint = :fingerprint, models_json = :models,
                    default_model = :default_model
                WHERE id = :id
            '''),
            {
                'encrypted': encrypted, 'hint': _hint(raw), 'fingerprint': fingerprint,
                'models': models, 'default_model': default_model, 'id': row['id'],
            },
        )
    op.alter_column('agent_llm_credential', 'key_fingerprint', existing_type=sa.String(length=64), nullable=False)


def downgrade():
    bind = op.get_bind()
    rows = bind.execute(sa.text('SELECT id, api_key FROM agent_llm_credential')).mappings().all()
    cipher = _fernet()
    for row in rows:
        stored = str(row['api_key'] or '')
        if stored.startswith(PREFIX):
            raw = cipher.decrypt(stored[len(PREFIX):].encode('ascii')).decode('utf-8')
            bind.execute(sa.text('UPDATE agent_llm_credential SET api_key = :raw WHERE id = :id'), {'raw': raw, 'id': row['id']})

    op.drop_index('ix_agent_llm_credential_key_fingerprint', table_name='agent_llm_credential')
    for name in [
        'cooldown_until', 'last_latency_ms', 'last_error', 'last_error_at', 'last_success_at',
        'last_checked_at', 'consecutive_failures', 'health_status', 'request_timeout_seconds',
        'priority', 'tags_json', 'models_json', 'key_fingerprint', 'api_key_hint',
    ]:
        op.drop_column('agent_llm_credential', name)
