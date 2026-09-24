"""rename agent menus

Revision ID: f2b3c4d5e6f7
Revises: f1a2b3c4d5e6
Create Date: 2026-08-21 11:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


revision = 'f2b3c4d5e6f7'
down_revision = 'f1a2b3c4d5e6'
branch_labels = None
depends_on = None


NEW_NAMES = {
    'agent': '模型网关',
    'agent_llm_keys': '模型账号',
    'agent_usage': '用量配额',
    'agent_pat': '访问令牌',
    'agent_routes': '模型路由',
    'agent_llm_keys_add': '新增模型账号',
    'agent_llm_keys_edit': '编辑模型账号',
    'agent_llm_keys_delete': '删除模型账号',
    'agent_llm_keys_test': '检测模型账号',
    'agent_routes_add': '新增模型路由',
    'agent_routes_edit': '编辑模型路由',
    'agent_routes_delete': '删除模型路由',
}

OLD_NAMES = {
    'agent': 'Agent',
    'agent_llm_keys': '模型服务账号',
    'agent_usage': '请求与配额',
    'agent_pat': '访问令牌',
    'agent_routes': '模型别名',
    'agent_llm_keys_add': '新增模型服务账号',
    'agent_llm_keys_edit': '编辑模型服务账号',
    'agent_llm_keys_delete': '删除模型服务账号',
    'agent_llm_keys_test': '检测模型服务账号',
    'agent_routes_add': '新增模型别名',
    'agent_routes_edit': '编辑模型别名',
    'agent_routes_delete': '删除模型别名',
}


def _rename(names):
    bind = op.get_bind()
    statement = sa.text('UPDATE menus SET name = :name WHERE code = :code')
    for code, name in names.items():
        bind.execute(statement, {'code': code, 'name': name})


def upgrade():
    _rename(NEW_NAMES)


def downgrade():
    _rename(OLD_NAMES)
