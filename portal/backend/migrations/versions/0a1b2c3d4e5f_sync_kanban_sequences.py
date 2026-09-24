"""sync kanban table id sequences

Revision ID: 0a1b2c3d4e5f
Revises: f5b6c7d8e9a0
Create Date: 2026-03-20 22:20:00.000000

"""

from alembic import op


revision = '0a1b2c3d4e5f'
down_revision = 'f5b6c7d8e9a0'
branch_labels = None
depends_on = None


def _sync_sequence(table_name):
    op.execute(f"""
        SELECT setval(
            pg_get_serial_sequence('{table_name}', 'id'),
            COALESCE((SELECT MAX(id) FROM {table_name}), 0) + 1,
            false
        )
    """)


def upgrade():
    bind = op.get_bind()
    if bind.dialect.name != 'postgresql':
        return
    _sync_sequence('kanban_boards')
    _sync_sequence('kanban_cards')


def downgrade():
    # sequence sync is non-destructive and does not require rollback
    pass
