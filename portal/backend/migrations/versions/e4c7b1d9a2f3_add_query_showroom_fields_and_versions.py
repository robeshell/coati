"""add query showroom fields and versions

Revision ID: e4c7b1d9a2f3
Revises: b6c8d91a7f22
Create Date: 2026-03-20 14:40:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e4c7b1d9a2f3'
down_revision = 'b6c8d91a7f22'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('query_managements', sa.Column('status', sa.String(length=20), nullable=False, server_default='draft'))
    op.add_column('query_managements', sa.Column('condition_logic', sa.String(length=10), nullable=True, server_default='AND'))
    op.add_column('query_managements', sa.Column('conditions_json', sa.Text(), nullable=True))
    op.add_column('query_managements', sa.Column('display_config', sa.Text(), nullable=True))
    op.add_column('query_managements', sa.Column('permission_config', sa.Text(), nullable=True))
    op.add_column('query_managements', sa.Column('schema_config', sa.Text(), nullable=True))
    op.add_column('query_managements', sa.Column('version', sa.Integer(), nullable=False, server_default='1'))
    op.add_column('query_managements', sa.Column('published_at', sa.DateTime(), nullable=True))

    op.create_table(
        'query_management_versions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('query_management_id', sa.Integer(), nullable=False),
        sa.Column('version_no', sa.Integer(), nullable=False),
        sa.Column('action', sa.String(length=20), nullable=True),
        sa.Column('snapshot_json', sa.Text(), nullable=False),
        sa.Column('operator', sa.String(length=100), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['query_management_id'], ['query_managements.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_query_management_versions_query_management_id', 'query_management_versions', ['query_management_id'], unique=False)


def downgrade():
    op.drop_index('ix_query_management_versions_query_management_id', table_name='query_management_versions')
    op.drop_table('query_management_versions')

    op.drop_column('query_managements', 'published_at')
    op.drop_column('query_managements', 'version')
    op.drop_column('query_managements', 'schema_config')
    op.drop_column('query_managements', 'permission_config')
    op.drop_column('query_managements', 'display_config')
    op.drop_column('query_managements', 'conditions_json')
    op.drop_column('query_managements', 'condition_logic')
    op.drop_column('query_managements', 'status')
