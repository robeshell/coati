"""add kanban_boards and kanban_cards tables

Revision ID: e3f4a5b6c7d8
Revises: d2e3f4a5b6c7
Create Date: 2026-03-20 22:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from datetime import datetime, date

revision = 'e3f4a5b6c7d8'
down_revision = 'd2e3f4a5b6c7'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'kanban_boards',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(100), nullable=False),
        sa.Column('board_code', sa.String(50), nullable=False),
        sa.Column('color', sa.String(20), nullable=True, server_default='#4080FF'),
        sa.Column('sort_order', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('wip_limit', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('is_active', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('board_code'),
    )
    op.create_table(
        'kanban_cards',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('board_id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(200), nullable=False),
        sa.Column('card_code', sa.String(80), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('priority', sa.String(20), nullable=True, server_default='medium'),
        sa.Column('assignee', sa.String(100), nullable=True),
        sa.Column('due_date', sa.Date(), nullable=True),
        sa.Column('tags', sa.String(200), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('is_active', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('card_code'),
        sa.ForeignKeyConstraint(['board_id'], ['kanban_boards.id'], ondelete='CASCADE'),
    )

    # ── 种子数据：4 列看板 ──────────────────────────────────────────────
    now = datetime.utcnow()
    boards_t = sa.table(
        'kanban_boards',
        sa.column('id', sa.Integer), sa.column('title', sa.String),
        sa.column('board_code', sa.String), sa.column('color', sa.String),
        sa.column('sort_order', sa.Integer), sa.column('wip_limit', sa.Integer),
        sa.column('is_active', sa.Boolean),
        sa.column('created_at', sa.DateTime), sa.column('updated_at', sa.DateTime),
    )
    op.bulk_insert(boards_t, [
        {'id': 1, 'title': '待办',   'board_code': 'todo',        'color': '#8c8c8c', 'sort_order': 0, 'wip_limit': 0, 'is_active': True, 'created_at': now, 'updated_at': now},
        {'id': 2, 'title': '进行中', 'board_code': 'in_progress', 'color': '#4080FF', 'sort_order': 1, 'wip_limit': 3, 'is_active': True, 'created_at': now, 'updated_at': now},
        {'id': 3, 'title': '审核中', 'board_code': 'review',      'color': '#FA8C16', 'sort_order': 2, 'wip_limit': 0, 'is_active': True, 'created_at': now, 'updated_at': now},
        {'id': 4, 'title': '已完成', 'board_code': 'done',        'color': '#00B96B', 'sort_order': 3, 'wip_limit': 0, 'is_active': True, 'created_at': now, 'updated_at': now},
    ])

    # ── 种子数据：示例卡片 ──────────────────────────────────────────────
    cards_t = sa.table(
        'kanban_cards',
        sa.column('id', sa.Integer), sa.column('board_id', sa.Integer),
        sa.column('title', sa.String), sa.column('card_code', sa.String),
        sa.column('description', sa.Text), sa.column('priority', sa.String),
        sa.column('assignee', sa.String), sa.column('due_date', sa.Date),
        sa.column('tags', sa.String), sa.column('sort_order', sa.Integer),
        sa.column('is_active', sa.Boolean),
        sa.column('created_at', sa.DateTime), sa.column('updated_at', sa.DateTime),
    )
    op.bulk_insert(cards_t, [
        {'id': 1, 'board_id': 1, 'title': '用户权限模块需求评审', 'card_code': 'CARD-001',
         'description': '梳理用户权限相关需求，输出 PRD 文档', 'priority': 'high',
         'assignee': 'Alice', 'due_date': date(2026, 3, 28), 'tags': '需求,权限',
         'sort_order': 0, 'is_active': True, 'created_at': now, 'updated_at': now},
        {'id': 2, 'board_id': 1, 'title': '数据导出功能优化', 'card_code': 'CARD-002',
         'description': '支持 Excel/CSV 多格式导出，增加字段筛选', 'priority': 'medium',
         'assignee': 'Bob', 'due_date': date(2026, 4, 5), 'tags': '优化,导出',
         'sort_order': 1, 'is_active': True, 'created_at': now, 'updated_at': now},
        {'id': 3, 'board_id': 1, 'title': '修复移动端菜单适配问题', 'card_code': 'CARD-003',
         'description': None, 'priority': 'low',
         'assignee': None, 'due_date': None, 'tags': 'Bug,移动端',
         'sort_order': 2, 'is_active': True, 'created_at': now, 'updated_at': now},
        {'id': 4, 'board_id': 2, 'title': '看板拖拽功能开发', 'card_code': 'CARD-004',
         'description': '使用 dnd-kit 实现 Kanban 跨列拖拽', 'priority': 'urgent',
         'assignee': 'Charlie', 'due_date': date(2026, 3, 22), 'tags': '开发,前端',
         'sort_order': 0, 'is_active': True, 'created_at': now, 'updated_at': now},
        {'id': 5, 'board_id': 2, 'title': 'ECharts 大屏接入真实数据', 'card_code': 'CARD-005',
         'description': '对接后端 API 替换静态示例数据', 'priority': 'high',
         'assignee': 'Alice', 'due_date': date(2026, 3, 25), 'tags': '数据,图表',
         'sort_order': 1, 'is_active': True, 'created_at': now, 'updated_at': now},
        {'id': 6, 'board_id': 3, 'title': '动态表单页单元测试', 'card_code': 'CARD-006',
         'description': '完成核心接口的单元测试覆盖，目标 80%+', 'priority': 'medium',
         'assignee': 'Dave', 'due_date': date(2026, 3, 21), 'tags': '测试',
         'sort_order': 0, 'is_active': True, 'created_at': now, 'updated_at': now},
        {'id': 7, 'board_id': 4, 'title': '组件中心菜单分类改造', 'card_code': 'CARD-007',
         'description': '将示例页面按行业方向分为 6 大类', 'priority': 'medium',
         'assignee': 'Charlie', 'due_date': None, 'tags': '重构',
         'sort_order': 0, 'is_active': True, 'created_at': now, 'updated_at': now},
        {'id': 8, 'board_id': 4, 'title': '树形列表页实现', 'card_code': 'CARD-008',
         'description': None, 'priority': 'low',
         'assignee': 'Bob', 'due_date': None, 'tags': '',
         'sort_order': 1, 'is_active': True, 'created_at': now, 'updated_at': now},
    ])


def downgrade():
    op.drop_table('kanban_cards')
    op.drop_table('kanban_boards')
