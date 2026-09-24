"""add cc_detail_members and cc_gantt_tasks tables

Revision ID: f5b6c7d8e9a0
Revises: e3f4a5b6c7d8
Create Date: 2026-03-20 22:30:00.000000

"""
from alembic import op
import sqlalchemy as sa
from datetime import datetime, date

revision = 'f5b6c7d8e9a0'
down_revision = 'e3f4a5b6c7d8'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'cc_detail_members',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('department', sa.String(100), nullable=True),
        sa.Column('role_title', sa.String(100), nullable=True),
        sa.Column('email', sa.String(200), nullable=True),
        sa.Column('phone', sa.String(50), nullable=True),
        sa.Column('status', sa.String(20), nullable=True, server_default='active'),
        sa.Column('join_date', sa.Date(), nullable=True),
        sa.Column('avatar_color', sa.String(20), nullable=True, server_default='#4080FF'),
        sa.Column('bio', sa.Text(), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('is_active', sa.Boolean(), nullable=True, server_default='true'),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_table(
        'cc_gantt_tasks',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(200), nullable=False),
        sa.Column('task_type', sa.String(20), nullable=True, server_default='task'),
        sa.Column('start_date', sa.Date(), nullable=False),
        sa.Column('end_date', sa.Date(), nullable=False),
        sa.Column('progress', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('assignee', sa.String(100), nullable=True),
        sa.Column('priority', sa.String(20), nullable=True, server_default='medium'),
        sa.Column('status', sa.String(20), nullable=True, server_default='not_started'),
        sa.Column('color', sa.String(20), nullable=True, server_default='#4080FF'),
        sa.Column('sort_order', sa.Integer(), nullable=True, server_default='0'),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )

    # ── 种子数据：8 名成员 ──────────────────────────────────────────────
    now = datetime.utcnow()
    members_t = sa.table(
        'cc_detail_members',
        sa.column('id', sa.Integer), sa.column('name', sa.String),
        sa.column('department', sa.String), sa.column('role_title', sa.String),
        sa.column('email', sa.String), sa.column('phone', sa.String),
        sa.column('status', sa.String), sa.column('join_date', sa.Date),
        sa.column('avatar_color', sa.String), sa.column('bio', sa.Text),
        sa.column('sort_order', sa.Integer), sa.column('is_active', sa.Boolean),
        sa.column('created_at', sa.DateTime), sa.column('updated_at', sa.DateTime),
    )
    op.bulk_insert(members_t, [
        {
            'id': 1, 'name': '张伟', 'department': '产品部', 'role_title': '产品总监',
            'email': 'zhangwei@example.com', 'phone': '13800001001',
            'status': 'active', 'join_date': date(2021, 3, 15),
            'avatar_color': '#4080FF',
            'bio': '负责平台核心产品规划与迭代，具备丰富的 B 端产品经验。',
            'sort_order': 0, 'is_active': True, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 2, 'name': '李娜', 'department': '设计部', 'role_title': 'UI/UX 设计师',
            'email': 'lina@example.com', 'phone': '13800001002',
            'status': 'active', 'join_date': date(2022, 6, 1),
            'avatar_color': '#FF7D00',
            'bio': '专注于企业级后台系统的交互设计，擅长设计规范建设。',
            'sort_order': 1, 'is_active': True, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 3, 'name': '王磊', 'department': '研发部', 'role_title': '前端工程师',
            'email': 'wanglei@example.com', 'phone': '13800001003',
            'status': 'active', 'join_date': date(2022, 9, 20),
            'avatar_color': '#00B96B',
            'bio': '熟悉 React 生态，负责组件中心前端模块开发。',
            'sort_order': 2, 'is_active': True, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 4, 'name': '刘芳', 'department': '研发部', 'role_title': '后端工程师',
            'email': 'liufang@example.com', 'phone': '13800001004',
            'status': 'active', 'join_date': date(2021, 11, 8),
            'avatar_color': '#722ED1',
            'bio': '负责服务端 API 开发与数据库设计，精通 Flask 和 PostgreSQL。',
            'sort_order': 3, 'is_active': True, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 5, 'name': '陈浩', 'department': '测试部', 'role_title': '测试工程师',
            'email': 'chenhao@example.com', 'phone': '13800001005',
            'status': 'active', 'join_date': date(2023, 2, 14),
            'avatar_color': '#EB2F96',
            'bio': '负责功能测试与自动化测试脚本编写，覆盖率达 85% 以上。',
            'sort_order': 4, 'is_active': True, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 6, 'name': '赵静', 'department': '运营部', 'role_title': '运营专员',
            'email': 'zhaojing@example.com', 'phone': '13800001006',
            'status': 'probation', 'join_date': date(2026, 2, 1),
            'avatar_color': '#FA8C16',
            'bio': '试用期成员，负责内容运营与用户增长活动策划。',
            'sort_order': 5, 'is_active': True, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 7, 'name': '孙鹏', 'department': '研发部', 'role_title': '全栈工程师',
            'email': 'sunpeng@example.com', 'phone': '13800001007',
            'status': 'leave', 'join_date': date(2020, 7, 1),
            'avatar_color': '#8C8C8C',
            'bio': '当前处于休假状态，预计下月返岗，擅长全栈架构设计。',
            'sort_order': 6, 'is_active': True, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 8, 'name': '吴婷', 'department': '产品部', 'role_title': '产品经理',
            'email': 'wuting@example.com', 'phone': '13800001008',
            'status': 'active', 'join_date': date(2023, 5, 22),
            'avatar_color': '#13C2C2',
            'bio': '负责数据分析类产品线，熟悉数据可视化业务场景。',
            'sort_order': 7, 'is_active': True, 'created_at': now, 'updated_at': now,
        },
    ])

    # ── 种子数据：10 个甘特任务（4 个阶段）──────────────────────────────
    tasks_t = sa.table(
        'cc_gantt_tasks',
        sa.column('id', sa.Integer), sa.column('title', sa.String),
        sa.column('task_type', sa.String), sa.column('start_date', sa.Date),
        sa.column('end_date', sa.Date), sa.column('progress', sa.Integer),
        sa.column('assignee', sa.String), sa.column('priority', sa.String),
        sa.column('status', sa.String), sa.column('color', sa.String),
        sa.column('sort_order', sa.Integer),
        sa.column('created_at', sa.DateTime), sa.column('updated_at', sa.DateTime),
    )
    op.bulk_insert(tasks_t, [
        # 阶段一：产品设计
        {
            'id': 1, 'title': '产品设计阶段', 'task_type': 'phase',
            'start_date': date(2026, 1, 1), 'end_date': date(2026, 1, 31),
            'progress': 100, 'assignee': '张伟', 'priority': 'high',
            'status': 'completed', 'color': '#4080FF',
            'sort_order': 0, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 2, 'title': '需求调研与竞品分析', 'task_type': 'task',
            'start_date': date(2026, 1, 1), 'end_date': date(2026, 1, 10),
            'progress': 100, 'assignee': '张伟', 'priority': 'high',
            'status': 'completed', 'color': '#4080FF',
            'sort_order': 1, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 3, 'title': 'UI 原型设计与评审', 'task_type': 'task',
            'start_date': date(2026, 1, 11), 'end_date': date(2026, 1, 31),
            'progress': 100, 'assignee': '李娜', 'priority': 'medium',
            'status': 'completed', 'color': '#4080FF',
            'sort_order': 2, 'created_at': now, 'updated_at': now,
        },
        # 阶段二：开发
        {
            'id': 4, 'title': '开发阶段', 'task_type': 'phase',
            'start_date': date(2026, 2, 1), 'end_date': date(2026, 3, 31),
            'progress': 80, 'assignee': None, 'priority': 'critical',
            'status': 'in_progress', 'color': '#00B96B',
            'sort_order': 3, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 5, 'title': '后端 API 开发', 'task_type': 'task',
            'start_date': date(2026, 2, 1), 'end_date': date(2026, 3, 10),
            'progress': 100, 'assignee': '刘芳', 'priority': 'high',
            'status': 'completed', 'color': '#00B96B',
            'sort_order': 4, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 6, 'title': '前端页面开发', 'task_type': 'task',
            'start_date': date(2026, 2, 10), 'end_date': date(2026, 3, 25),
            'progress': 75, 'assignee': '王磊', 'priority': 'high',
            'status': 'in_progress', 'color': '#00B96B',
            'sort_order': 5, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 7, 'title': '前后端联调', 'task_type': 'milestone',
            'start_date': date(2026, 3, 26), 'end_date': date(2026, 3, 31),
            'progress': 0, 'assignee': '孙鹏', 'priority': 'critical',
            'status': 'not_started', 'color': '#FA8C16',
            'sort_order': 6, 'created_at': now, 'updated_at': now,
        },
        # 阶段三：测试
        {
            'id': 8, 'title': '测试阶段', 'task_type': 'phase',
            'start_date': date(2026, 4, 1), 'end_date': date(2026, 4, 30),
            'progress': 0, 'assignee': None, 'priority': 'high',
            'status': 'not_started', 'color': '#722ED1',
            'sort_order': 7, 'created_at': now, 'updated_at': now,
        },
        {
            'id': 9, 'title': '功能测试与缺陷修复', 'task_type': 'task',
            'start_date': date(2026, 4, 1), 'end_date': date(2026, 4, 20),
            'progress': 0, 'assignee': '陈浩', 'priority': 'high',
            'status': 'not_started', 'color': '#722ED1',
            'sort_order': 8, 'created_at': now, 'updated_at': now,
        },
        # 阶段四：上线
        {
            'id': 10, 'title': '生产环境部署上线', 'task_type': 'milestone',
            'start_date': date(2026, 5, 10), 'end_date': date(2026, 5, 15),
            'progress': 0, 'assignee': '刘芳', 'priority': 'critical',
            'status': 'not_started', 'color': '#EB2F96',
            'sort_order': 9, 'created_at': now, 'updated_at': now,
        },
    ])


def downgrade():
    op.drop_table('cc_gantt_tasks')
    op.drop_table('cc_detail_members')
