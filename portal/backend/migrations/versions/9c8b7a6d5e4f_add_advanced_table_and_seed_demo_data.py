"""add advanced table and seed demo data

Revision ID: 9c8b7a6d5e4f
Revises: 0a1b2c3d4e5f
Create Date: 2026-03-21 10:40:00.000000

"""

from datetime import datetime, date

from alembic import op
import sqlalchemy as sa


revision = '9c8b7a6d5e4f'
down_revision = '0a1b2c3d4e5f'
branch_labels = None
depends_on = None


def _table_is_empty(bind, table_name):
    return (bind.execute(sa.text(f"SELECT COUNT(1) FROM {table_name}")).scalar() or 0) == 0


def _sync_sequence(table_name):
    op.execute(f"""
        SELECT setval(
            pg_get_serial_sequence('{table_name}', 'id'),
            COALESCE((SELECT MAX(id) FROM {table_name}), 0) + 1,
            false
        )
    """)


def upgrade():
    op.create_table(
        'cc_advanced_table_rows',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('row_code', sa.String(length=80), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('category', sa.String(length=50), nullable=True, server_default='general'),
        sa.Column('owner', sa.String(length=100), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='draft'),
        sa.Column('priority', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('progress', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('score', sa.Numeric(precision=7, scale=2), nullable=True, server_default='0'),
        sa.Column('tags', sa.String(length=255), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('is_pinned', sa.Boolean(), nullable=True, server_default='false'),
        sa.Column('due_date', sa.Date(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('remark', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('row_code'),
    )

    bind = op.get_bind()
    now = datetime.utcnow()

    query_mgmt_t = sa.table(
        'query_managements',
        sa.column('id', sa.Integer),
        sa.column('name', sa.String),
        sa.column('query_code', sa.String),
        sa.column('category', sa.String),
        sa.column('keyword', sa.String),
        sa.column('data_source', sa.String),
        sa.column('owner', sa.String),
        sa.column('priority', sa.Integer),
        sa.column('is_active', sa.Boolean),
        sa.column('status', sa.String),
        sa.column('condition_logic', sa.String),
        sa.column('conditions_json', sa.Text),
        sa.column('display_config', sa.Text),
        sa.column('permission_config', sa.Text),
        sa.column('schema_config', sa.Text),
        sa.column('version', sa.Integer),
        sa.column('published_at', sa.DateTime),
        sa.column('description', sa.Text),
        sa.column('created_at', sa.DateTime),
        sa.column('updated_at', sa.DateTime),
    )

    stats_t = sa.table(
        'stats_items',
        sa.column('id', sa.Integer),
        sa.column('name', sa.String),
        sa.column('item_code', sa.String),
        sa.column('category', sa.String),
        sa.column('status', sa.String),
        sa.column('amount', sa.Numeric),
        sa.column('quantity', sa.Integer),
        sa.column('owner', sa.String),
        sa.column('priority', sa.Integer),
        sa.column('is_active', sa.Boolean),
        sa.column('description', sa.Text),
        sa.column('created_at', sa.DateTime),
        sa.column('updated_at', sa.DateTime),
    )

    card_t = sa.table(
        'card_items',
        sa.column('id', sa.Integer),
        sa.column('title', sa.String),
        sa.column('card_code', sa.String),
        sa.column('subtitle', sa.String),
        sa.column('category', sa.String),
        sa.column('cover_url', sa.String),
        sa.column('tag', sa.String),
        sa.column('status', sa.String),
        sa.column('owner', sa.String),
        sa.column('priority', sa.Integer),
        sa.column('is_active', sa.Boolean),
        sa.column('description', sa.Text),
        sa.column('created_at', sa.DateTime),
        sa.column('updated_at', sa.DateTime),
    )

    tree_t = sa.table(
        'tree_nodes',
        sa.column('id', sa.Integer),
        sa.column('name', sa.String),
        sa.column('node_code', sa.String),
        sa.column('parent_id', sa.Integer),
        sa.column('node_type', sa.String),
        sa.column('icon', sa.String),
        sa.column('description', sa.Text),
        sa.column('sort_order', sa.Integer),
        sa.column('is_active', sa.Boolean),
        sa.column('status', sa.String),
        sa.column('owner', sa.String),
        sa.column('created_at', sa.DateTime),
        sa.column('updated_at', sa.DateTime),
    )

    advanced_t = sa.table(
        'cc_advanced_table_rows',
        sa.column('id', sa.Integer),
        sa.column('row_code', sa.String),
        sa.column('name', sa.String),
        sa.column('category', sa.String),
        sa.column('owner', sa.String),
        sa.column('status', sa.String),
        sa.column('priority', sa.Integer),
        sa.column('progress', sa.Integer),
        sa.column('score', sa.Numeric),
        sa.column('tags', sa.String),
        sa.column('is_active', sa.Boolean),
        sa.column('is_pinned', sa.Boolean),
        sa.column('due_date', sa.Date),
        sa.column('sort_order', sa.Integer),
        sa.column('remark', sa.Text),
        sa.column('created_at', sa.DateTime),
        sa.column('updated_at', sa.DateTime),
    )

    if _table_is_empty(bind, 'query_managements'):
        op.bulk_insert(query_mgmt_t, [
            {
                'id': 1,
                'name': '订单异常预警看板',
                'query_code': 'init_query_order_alert',
                'category': 'order',
                'keyword': '异常订单,预警',
                'data_source': 'orders',
                'owner': 'admin',
                'priority': 90,
                'is_active': True,
                'status': 'published',
                'condition_logic': 'AND',
                'conditions_json': '{"groups":[{"name":"异常订单","logic":"AND"}],"items":[{"field":"status","operator":"eq","value":"abnormal","logic":"AND"},{"field":"amount","operator":"gt","value":500,"logic":"AND"}]}',
                'display_config': '{"selected_fields":["order_no","status","amount","created_at"],"preview_rows":10,"sort_by":"created_at","sort_order":"desc"}',
                'permission_config': '{"visible_roles":["super_admin"],"editable_roles":["super_admin"]}',
                'schema_config': '{"version":"1.0.0","author":"system-seed"}',
                'version': 1,
                'published_at': now,
                'description': '用于演示订单异常排查流程',
                'created_at': now,
                'updated_at': now,
            },
            {
                'id': 2,
                'name': '高价值用户复购分析',
                'query_code': 'init_query_user_rebuy',
                'category': 'user',
                'keyword': '复购,高价值',
                'data_source': 'users',
                'owner': 'admin',
                'priority': 75,
                'is_active': True,
                'status': 'draft',
                'condition_logic': 'OR',
                'conditions_json': '{"groups":[{"name":"高价值用户","logic":"OR"}],"items":[{"field":"level","operator":"eq","value":"vip","logic":"OR"},{"field":"amount","operator":"gt","value":10000,"logic":"OR"}]}',
                'display_config': '{"selected_fields":["user_id","nickname","level","register_at"],"preview_rows":8,"sort_by":"register_at","sort_order":"desc"}',
                'permission_config': '{"visible_roles":["super_admin"],"editable_roles":["super_admin"]}',
                'schema_config': '{"version":"1.0.0","author":"system-seed"}',
                'version': 1,
                'published_at': None,
                'description': '用于演示用户分层查询模板',
                'created_at': now,
                'updated_at': now,
            },
        ])

    if _table_is_empty(bind, 'stats_items'):
        op.bulk_insert(stats_t, [
            {'id': 1, 'name': '华东订单中心', 'item_code': 'init_stats_order_east', 'category': 'order', 'status': 'published', 'amount': 1265000.50, 'quantity': 3420, 'owner': '陈晨', 'priority': 90, 'is_active': True, 'description': '华东大区订单汇总', 'created_at': now, 'updated_at': now},
            {'id': 2, 'name': '会员复购专项', 'item_code': 'init_stats_user_rebuy', 'category': 'user', 'status': 'draft', 'amount': 885000.00, 'quantity': 980, 'owner': '李楠', 'priority': 70, 'is_active': True, 'description': '会员复购数据追踪', 'created_at': now, 'updated_at': now},
            {'id': 3, 'name': '风控拦截成效', 'item_code': 'init_stats_risk_block', 'category': 'risk', 'status': 'archived', 'amount': 312000.88, 'quantity': 126, 'owner': '王博', 'priority': 60, 'is_active': False, 'description': '历史风控策略效果复盘', 'created_at': now, 'updated_at': now},
        ])

    if _table_is_empty(bind, 'card_items'):
        op.bulk_insert(card_t, [
            {'id': 1, 'title': '活动运营周报', 'card_code': 'init_card_ops_weekly', 'subtitle': '多渠道投放效果追踪', 'category': 'order', 'cover_url': 'https://images.unsplash.com/photo-1551281044-8b1f67f3f42b', 'tag': '运营', 'status': 'published', 'owner': '周青', 'priority': 80, 'is_active': True, 'description': '用于展示卡片列表中的运营分析卡片', 'created_at': now, 'updated_at': now},
            {'id': 2, 'title': '客户流失预警', 'card_code': 'init_card_user_churn', 'subtitle': '近30天活跃下降用户', 'category': 'user', 'cover_url': 'https://images.unsplash.com/photo-1460925895917-afdab827c52f', 'tag': '用户', 'status': 'draft', 'owner': '林可', 'priority': 65, 'is_active': True, 'description': '用于演示用户留存分析卡片', 'created_at': now, 'updated_at': now},
            {'id': 3, 'title': '财务对账稽核', 'card_code': 'init_card_finance_check', 'subtitle': '订单与支付流水核对', 'category': 'finance', 'cover_url': 'https://images.unsplash.com/photo-1554224155-6726b3ff858f', 'tag': '财务', 'status': 'published', 'owner': '高蕾', 'priority': 88, 'is_active': True, 'description': '用于演示财务稽核场景卡片', 'created_at': now, 'updated_at': now},
        ])

    if _table_is_empty(bind, 'tree_nodes'):
        op.bulk_insert(tree_t, [
            {'id': 1, 'name': '组织架构', 'node_code': 'init_tree_org_root', 'parent_id': None, 'node_type': 'category', 'icon': 'IconHome', 'description': '组织结构总览', 'sort_order': 1, 'is_active': True, 'status': 'active', 'owner': 'admin', 'created_at': now, 'updated_at': now},
            {'id': 2, 'name': '业务中心', 'node_code': 'init_tree_business', 'parent_id': 1, 'node_type': 'folder', 'icon': 'IconGridSquare', 'description': '业务线节点', 'sort_order': 1, 'is_active': True, 'status': 'active', 'owner': 'admin', 'created_at': now, 'updated_at': now},
            {'id': 3, 'name': '数据运营组', 'node_code': 'init_tree_data_ops', 'parent_id': 2, 'node_type': 'member', 'icon': 'IconUser', 'description': '负责日常指标运营', 'sort_order': 1, 'is_active': True, 'status': 'active', 'owner': 'admin', 'created_at': now, 'updated_at': now},
            {'id': 4, 'name': '风险策略组', 'node_code': 'init_tree_risk', 'parent_id': 2, 'node_type': 'member', 'icon': 'IconAlertTriangle', 'description': '负责风险策略执行', 'sort_order': 2, 'is_active': True, 'status': 'active', 'owner': 'admin', 'created_at': now, 'updated_at': now},
        ])

    op.bulk_insert(advanced_t, [
        {'id': 1, 'row_code': 'ADV-001', 'name': '订单履约时效看板', 'category': 'order', 'owner': '陈晨', 'status': 'published', 'priority': 95, 'progress': 88, 'score': 96.5, 'tags': '核心,履约,SLA', 'is_active': True, 'is_pinned': True, 'due_date': date(2026, 3, 28), 'sort_order': 1, 'remark': '支持行内编辑与置顶演示', 'created_at': now, 'updated_at': now},
        {'id': 2, 'row_code': 'ADV-002', 'name': '会员成长计划', 'category': 'user', 'owner': '李楠', 'status': 'draft', 'priority': 76, 'progress': 45, 'score': 82.0, 'tags': '会员,留存,A/B', 'is_active': True, 'is_pinned': False, 'due_date': date(2026, 4, 3), 'sort_order': 2, 'remark': '适合演示拖拽排序', 'created_at': now, 'updated_at': now},
        {'id': 3, 'row_code': 'ADV-003', 'name': '风控规则复盘', 'category': 'risk', 'owner': '王博', 'status': 'published', 'priority': 82, 'progress': 64, 'score': 85.5, 'tags': '风控,策略,复盘', 'is_active': True, 'is_pinned': False, 'due_date': date(2026, 3, 25), 'sort_order': 3, 'remark': '用于批量状态更新演示', 'created_at': now, 'updated_at': now},
        {'id': 4, 'row_code': 'ADV-004', 'name': '财务对账自动化', 'category': 'finance', 'owner': '高蕾', 'status': 'archived', 'priority': 60, 'progress': 100, 'score': 91.0, 'tags': '财务,自动化', 'is_active': False, 'is_pinned': False, 'due_date': None, 'sort_order': 4, 'remark': '用于筛选与列设置演示', 'created_at': now, 'updated_at': now},
        {'id': 5, 'row_code': 'ADV-005', 'name': '用户召回策略优化', 'category': 'user', 'owner': '周青', 'status': 'draft', 'priority': 68, 'progress': 33, 'score': 78.8, 'tags': '召回,消息触达', 'is_active': True, 'is_pinned': False, 'due_date': date(2026, 4, 10), 'sort_order': 5, 'remark': '用于行选择和批量操作演示', 'created_at': now, 'updated_at': now},
    ])

    if bind.dialect.name == 'postgresql':
        _sync_sequence('query_managements')
        _sync_sequence('stats_items')
        _sync_sequence('card_items')
        _sync_sequence('tree_nodes')
        _sync_sequence('cc_advanced_table_rows')


def downgrade():
    op.execute(sa.text("DELETE FROM cc_advanced_table_rows WHERE row_code LIKE 'ADV-%'"))
    op.execute(sa.text("DELETE FROM query_managements WHERE query_code LIKE 'init_query_%'"))
    op.execute(sa.text("DELETE FROM stats_items WHERE item_code LIKE 'init_stats_%'"))
    op.execute(sa.text("DELETE FROM card_items WHERE card_code LIKE 'init_card_%'"))
    op.execute(sa.text("DELETE FROM tree_nodes WHERE node_code LIKE 'init_tree_%'"))
    op.drop_table('cc_advanced_table_rows')
