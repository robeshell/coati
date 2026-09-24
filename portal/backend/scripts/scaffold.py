#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
coati 代码骨架生成脚本

用法：
  python3 backend/scripts/scaffold.py --name customer --domain admin --fields "name:str,phone:str,status:str"

  --name    资源名（snake_case，如 customer）
  --domain  所属域（admin 或 component_center）
  --fields  字段列表，格式 "field:type,field:type"
            支持类型：str / text / int / float / bool / date / datetime

生成文件：
  backend/app/<domain>/model/entities_<name>.py
  backend/app/<domain>/crud/<name>_crud.py
  backend/app/<domain>/service/<name>_service.py
  backend/app/<domain>/api/<name>.py
  frontend/src/modules/<module>/api/<name>.js
  frontend/src/modules/<module>/pages/<subdir>/<name>_page/index.jsx
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# ─── 字段类型映射 ──────────────────────────────────────────────────────────────

FIELD_TYPE_MAP = {
    'str':      ('db.String(100)', 'str', "''"),
    'str50':    ('db.String(50)',  'str', "''"),
    'str20':    ('db.String(20)',  'str', "''"),
    'str500':   ('db.String(500)', 'str', "''"),
    'text':     ('db.Text',        'str', 'None'),
    'int':      ('db.Integer',     'int', '0'),
    'float':    ('db.Numeric(10,2)', 'float', '0'),
    'bool':     ('db.Boolean',     'bool', 'True'),
    'date':     ('db.Date',        'str', 'None'),
    'datetime': ('db.DateTime',    'str', 'None'),
}

# ─── 命名工具 ──────────────────────────────────────────────────────────────────

def to_pascal(name: str) -> str:
    return ''.join(w.capitalize() for w in name.split('_'))

def to_kebab(name: str) -> str:
    return name.replace('_', '-')

def to_label(name: str) -> str:
    """snake_case → 中文友好展示（首字母大写英文，实际由 AI 翻译）"""
    return name.replace('_', ' ').title()

# ─── 代码生成 ──────────────────────────────────────────────────────────────────

def gen_model(name: str, fields: list[tuple[str, str]], domain: str) -> str:
    pascal = to_pascal(name)
    table = f"{name}s"

    field_lines = []
    dict_lines = []
    for fname, ftype in fields:
        db_type, _, _ = FIELD_TYPE_MAP.get(ftype, FIELD_TYPE_MAP['str'])
        nullable = '' if ftype in ('str', 'str50', 'str20') else ', nullable=True'
        field_lines.append(f"        {fname} = db.Column({db_type}{nullable})")
        dict_lines.append(f"                '{fname}': self.{fname},")

    fields_str = '\n'.join(field_lines)
    dict_str = '\n'.join(dict_lines)

    return f'''# -*- coding: utf-8 -*-
"""{pascal} 模型"""

from datetime import datetime


def build_{name}_models(db):

    class {pascal}(db.Model):
        __tablename__ = '{table}'

        id = db.Column(db.Integer, primary_key=True)
{fields_str}
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        def to_dict(self):
            return {{
                'id': self.id,
{dict_str}
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }}

    return {{'{pascal}': {pascal}}}
'''


def gen_crud(name: str) -> str:
    pascal = to_pascal(name)
    return f'''# -*- coding: utf-8 -*-
"""{pascal} CRUD 层"""


class {pascal}CRUD:
    def __init__(self, db, model):
        self.db = db
        self.{pascal} = model

    def query_all(self):
        return self.{pascal}.query

    def get_or_404(self, item_id):
        return self.{pascal}.query.get_or_404(item_id)

    def add(self, item):
        self.db.session.add(item)

    def delete(self, item):
        self.db.session.delete(item)

    def commit(self):
        self.db.session.commit()

    def rollback(self):
        self.db.session.rollback()
'''


def gen_service(name: str, fields: list[tuple[str, str]], domain: str) -> str:
    pascal = to_pascal(name)

    # 找第一个 str 类型字段作为 name 字段
    name_field = next((f for f, t in fields if t in ('str', 'str50', 'str100')), fields[0][0] if fields else 'name')

    set_lines = []
    for fname, _ in fields:
        set_lines.append(f"            {fname}=data.get('{fname}'),")

    update_lines = []
    for fname, _ in fields:
        update_lines.append(f"        if '{fname}' in data:")
        update_lines.append(f"            item.{fname} = data['{fname}']")

    set_str = '\n'.join(set_lines)
    update_str = '\n'.join(update_lines)

    # 生成导出字段映射（取前几个字段，其余由 AI 补充）
    export_map_lines = ["    'id': 'ID',"]
    for fname, _ in fields[:4]:
        export_map_lines.append(f"    '{fname}': '{to_label(fname)}',")
    export_map_lines.append("    'created_at': '创建时间',")
    export_map_str = '\n'.join(export_map_lines)

    import_map_lines = []
    for fname, ftype in fields[:3]:
        if ftype in ('str', 'str50', 'str20', 'str100'):
            import_map_lines.append(f"    '{to_label(fname)}': '{fname}',")
    import_map_str = '\n'.join(import_map_lines) if import_map_lines else f"    '{to_label(name_field)}': '{name_field}',"

    return f'''# -*- coding: utf-8 -*-
"""{pascal} Service 层"""

from backend.app.{domain}.crud.{name}_crud import {pascal}CRUD

# 导出字段映射（key=模型字段名, value=表头中文名）
EXPORT_FIELD_MAP = {{
{export_map_str}
}}

# 导入列头映射（key=中文表头, value=模型字段名）
IMPORT_HEADER_MAP = {{
{import_map_str}
}}


class {pascal}ServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {{}}


class {pascal}Service:
    def __init__(self, db, model):
        self.db = db
        self.crud = {pascal}CRUD(db, model)

    def list_items(self, page=1, per_page=20, search=''):
        query = self.crud.query_all()
        if search:
            query = query.filter(self.crud.{pascal}.{name_field}.ilike(f\'%{{search}}%\'))
        pagination = query.order_by(self.crud.{pascal}.id.desc()).paginate(
            page=page, per_page=per_page, error_out=False
        )
        return {{
            'items': [item.to_dict() for item in pagination.items],
            'total': pagination.total,
            'page': page,
            'per_page': per_page,
        }}

    def create_item(self, data):
        item = self.crud.{pascal}(
{set_str}
        )
        try:
            self.crud.add(item)
            self.crud.commit()
            return item.to_dict(), 201
        except Exception as e:
            self.crud.rollback()
            raise {pascal}ServiceError(str(e), 500) from e

    def update_item(self, item, data):
{update_str}
        try:
            self.crud.commit()
            return item.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise {pascal}ServiceError(str(e), 500) from e

    def delete_item(self, item):
        try:
            self.crud.delete(item)
            self.crud.commit()
            return {{'message': '删除成功'}}
        except Exception as e:
            self.crud.rollback()
            raise {pascal}ServiceError(str(e), 500) from e

    def export_items(self, data):
        from backend.common.tabular import build_table_response, normalize_table_file_type
        file_type = normalize_table_file_type(data.get('file_type'), default='xlsx')
        fields = data.get('fields') or list(EXPORT_FIELD_MAP.keys())
        ids = data.get('ids')
        query = self.crud.query_all()
        if ids:
            query = query.filter(self.crud.{pascal}.id.in_(ids))
        items = query.order_by(self.crud.{pascal}.id.desc()).all()
        headers = [EXPORT_FIELD_MAP.get(f, f) for f in fields]
        rows = [[item.to_dict().get(f, '') for f in fields] for item in items]
        return build_table_response(headers, rows, '{name}_export', file_type=file_type)

    def download_template(self, file_type_raw='xlsx'):
        from backend.common.tabular import build_table_response, normalize_table_file_type
        file_type = normalize_table_file_type(file_type_raw, default='xlsx')
        return build_table_response(list(IMPORT_HEADER_MAP.keys()), [], '{name}_import_template', file_type=file_type)

    def import_items(self, file_storage):
        from backend.common.tabular import read_table_file
        try:
            _, rows, _ = read_table_file(file_storage)
        except ValueError as e:
            raise {pascal}ServiceError(str(e), 400) from e
        created = 0
        error_rows = []
        for line, row in rows:
            try:
                {name_field}_val = row.get(list(IMPORT_HEADER_MAP.keys())[0] if IMPORT_HEADER_MAP else '', '').strip()
                if not {name_field}_val:
                    error_rows.append({{'line': line, 'reason': '{to_label(name_field)}不能为空', 'row': row}})
                    continue
                item = self.crud.{pascal}(**{{IMPORT_HEADER_MAP[k]: v for k, v in row.items() if k in IMPORT_HEADER_MAP and v}})
                self.crud.add(item)
                created += 1
            except Exception as e:
                error_rows.append({{'line': line, 'reason': str(e), 'row': row}})
        if created:
            try:
                self.crud.commit()
            except Exception as e:
                self.crud.rollback()
                raise {pascal}ServiceError(str(e), 500) from e
        if error_rows:
            raise {pascal}ServiceError('部分数据导入失败', 400, {{'error_rows': error_rows}})
        return {{'created': created, 'updated': 0}}
'''


def gen_api(name: str, domain: str, perm_prefix: str) -> str:
    pascal = to_pascal(name)
    kebab = to_kebab(name)

    return f'''# -*- coding: utf-8 -*-
"""{pascal} API 层"""

from flask import jsonify, request

from backend.common.auth import has_menu_permission, login_required
from backend.common.pagination import parse_pagination
from backend.app.{domain}.service.{name}_service import {pascal}Service, {pascal}ServiceError


def init_{name}_api(bp, db, models):
    {pascal} = models.get('{pascal}')
    service = {pascal}Service(db, {pascal})

    def handle_error(e):
        # 5xx 不向客户端暴露内部细节（避免 DB 错误泄漏）
        if e.status_code >= 500:
            return jsonify({{'error': '服务器内部错误，请稍后重试'}}), e.status_code
        return jsonify({{'error': e.message, **e.payload}}), e.status_code

    @bp.route('/api/admin/{kebab}s', methods=['GET', 'POST'])
    @login_required
    def manage_{name}s():
        if request.method == 'GET':
            if not has_menu_permission('{perm_prefix}'):
                return jsonify({{'error': '无权限'}}), 403
            page, per_page = parse_pagination()
            search = request.args.get('search', '').strip()
            return jsonify(service.list_items(page=page, per_page=per_page, search=search))

        if not has_menu_permission('{perm_prefix}_add'):
            return jsonify({{'error': '无权限新增'}}), 403
        try:
            payload, status = service.create_item(request.get_json() or {{}})
            return jsonify(payload), status
        except {pascal}ServiceError as e:
            return handle_error(e)

    @bp.route('/api/admin/{kebab}s/<int:item_id>', methods=['PUT', 'DELETE'])
    @login_required
    def update_{name}(item_id):
        item = service.crud.get_or_404(item_id)

        if request.method == 'DELETE':
            if not has_menu_permission('{perm_prefix}_delete'):
                return jsonify({{'error': '无权限删除'}}), 403
            try:
                return jsonify(service.delete_item(item))
            except {pascal}ServiceError as e:
                return handle_error(e)

        if not has_menu_permission('{perm_prefix}_edit'):
            return jsonify({{'error': '无权限编辑'}}), 403
        try:
            return jsonify(service.update_item(item, request.get_json() or {{}}))
        except {pascal}ServiceError as e:
            return handle_error(e)

    @bp.route('/api/admin/{kebab}s/export', methods=['POST'])
    @login_required
    def export_{name}():
        if not has_menu_permission('{perm_prefix}_export'):
            return jsonify({{'error': '无权限导出'}}), 403
        try:
            return service.export_items(request.get_json() or {{}})
        except {pascal}ServiceError as e:
            return handle_error(e)

    @bp.route('/api/admin/{kebab}s/template', methods=['GET'])
    @login_required
    def download_{name}_template():
        if not has_menu_permission('{perm_prefix}'):
            return jsonify({{'error': '无权限'}}), 403
        return service.download_template(request.args.get('file_type', 'xlsx'))

    @bp.route('/api/admin/{kebab}s/import', methods=['POST'])
    @login_required
    def import_{name}():
        if not has_menu_permission('{perm_prefix}_import'):
            return jsonify({{'error': '无权限导入'}}), 403
        try:
            return jsonify(service.import_items(request.files.get('file')))
        except {pascal}ServiceError as e:
            return handle_error(e)
'''


def gen_frontend_api(name: str, domain_path: str) -> str:
    kebab = to_kebab(name)
    return f"""import request from '@/shared/api/request'

const BASE = '/admin/{kebab}s'

export const getItems = (params) => request.get(BASE, {{ params }})
export const createItem = (data) => request.post(BASE, data)
export const updateItem = (id, data) => request.put(`${{BASE}}/${{id}}`, data)
export const deleteItem = (id) => request.delete(`${{BASE}}/${{id}}`)

export const exportItems = (data) =>
  request.post(`${{BASE}}/export`, data, {{ responseType: 'blob' }})

export const downloadTemplate = (fileType = 'xlsx') =>
  request.get(`${{BASE}}/template`, {{ params: {{ file_type: fileType }}, responseType: 'blob' }})

export const importItems = (file) => {{
  const formData = new FormData()
  formData.append('file', file)
  return request.post(`${{BASE}}/import`, formData, {{
    headers: {{ 'Content-Type': 'multipart/form-data' }},
  }})
}}
"""


def gen_frontend_page(name: str, fields: list[tuple[str, str]], module: str) -> str:
    pascal = to_pascal(name)
    kebab = to_kebab(name)

    col_lines = []
    for fname, _ in fields[:4]:
        col_lines.append(f"    {{ title: '{to_label(fname)}', dataIndex: '{fname}' }},")
    cols_str = '\n'.join(col_lines)

    form_lines = []
    for fname, ftype in fields:
        if ftype == 'text':
            form_lines.append(f"          <Form.TextArea field=\"{fname}\" label=\"{to_label(fname)}\" />")
        elif ftype == 'bool':
            form_lines.append(f"          <Form.Switch field=\"{fname}\" label=\"{to_label(fname)}\" />")
        else:
            form_lines.append(f"          <Form.Input field=\"{fname}\" label=\"{to_label(fname)}\" />")
    forms_str = '\n'.join(form_lines)

    # 生成导出字段选项
    export_field_lines = ["  { label: 'ID', value: 'id' },"]
    for fname, _ in fields[:4]:
        export_field_lines.append(f"  {{ label: '{to_label(fname)}', value: '{fname}' }},")
    export_field_lines.append("  { label: '创建时间', value: 'created_at' },")
    export_fields_str = '\n'.join(export_field_lines)

    return f"""import {{ useState, useEffect, useRef }} from 'react'
import {{
  Button, Form, Input, Modal, Popconfirm, Space, Table, Toast, Typography,
}} from '@douyinfe/semi-ui'
import {{ IconPlus, IconSearch }} from '@douyinfe/semi-icons'
import {{ useCrudList }} from '@/shared/hooks/useCrudList'
import ExportFieldsModal from '@/shared/components/import-export/ExportFieldsModal'
import ImportCsvModal from '@/shared/components/import-export/ImportCsvModal'
import {{ downloadBlobFile }} from '@/shared/utils/file'
import {{
  getItems, createItem, updateItem, deleteItem,
  exportItems, downloadTemplate, importItems,
}} from '@/modules/{module}/api/{name}'

const {{ Title }} = Typography

const EXPORT_FIELDS = [
{export_fields_str}
]

export default function {pascal}Page() {{
  const list = useCrudList(
    (params) => getItems(params).catch(() => {{
      Toast.error('加载失败')
      return {{ items: [], total: 0 }}
    }}),
    {{ defaultPerPage: 20 }},
  )
  const {{ data, total, loading, page, handlePageChange, handleSearch, handleReset, fetchData }} = list
  const [search, setSearch] = useState('')
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState(null)
  const [exportModalVisible, setExportModalVisible] = useState(false)
  const [importModalVisible, setImportModalVisible] = useState(false)
  const formApiRef = useRef()

  useEffect(() => {{ fetchData() }}, []) // eslint-disable-line

  const openCreate = () => {{
    setEditingItem(null)
    setModalVisible(true)
    setTimeout(() => formApiRef.current?.reset(), 0)
  }}

  const openEdit = (item) => {{
    setEditingItem(item)
    setModalVisible(true)
    setTimeout(() => formApiRef.current?.setValues(item), 0)
  }}

  const handleModalOk = async () => {{
    let values
    try {{ values = await formApiRef.current.validate() }} catch {{ return }}
    try {{
      editingItem ? await updateItem(editingItem.id, values) : await createItem(values)
      Toast.success(editingItem ? '更新成功' : '创建成功')
      setModalVisible(false)
      fetchData()
    }} catch (err) {{ Toast.error(err?.error || '操作失败') }}
  }}

  const handleDelete = async (id) => {{
    try {{
      await deleteItem(id)
      Toast.success('删除成功')
      fetchData()
    }} catch {{ Toast.error('删除失败') }}
  }}

  const handleExport = ({{ fields, fileType }}) => {{
    exportItems({{ fields, file_type: fileType }})
      .then((blob) => {{
        downloadBlobFile(blob, `{kebab}s_export.${{fileType}}`)
        Toast.success('导出成功')
        setExportModalVisible(false)
      }})
      .catch(() => Toast.error('导出失败'))
  }}

  const columns = [
    {{ title: 'ID', dataIndex: 'id', width: 80 }},
{cols_str}
    {{
      title: '操作', width: 160,
      render: (_, record) => (
        <Space>
          <Button size="small" onClick={{() => openEdit(record)}}>编辑</Button>
          <Popconfirm title="确认删除？" onConfirm={{() => handleDelete(record.id)}}>
            <Button size="small" type="danger">删除</Button>
          </Popconfirm>
        </Space>
      ),
    }},
  ]

  return (
    <div>
      <Title heading={{5}} style={{marginBottom: 16}}>TODO: 替换标题</Title>

      <div style={{{{ padding: 16, marginBottom: 16, background: 'var(--semi-color-bg-1)', borderRadius: 8, border: '1px solid var(--semi-color-border)' }}}}>
        <Space style={{flexWrap: 'wrap'}}>
          <Input
            prefix={{<IconSearch />}}
            placeholder="搜索…"
            value={{search}}
            onChange={{setSearch}}
            onEnterPress={{() => handleSearch({{ search: search.trim() }})}}
            style={{width: 240}}
          />
          <Button icon={{<IconSearch />}} type="primary" onClick={{() => handleSearch({{ search: search.trim() }})}}>查询</Button>
          <Button onClick={{() => {{ setSearch(''); handleReset() }}}}>重置</Button>
        </Space>
      </div>

      <div style={{{{ padding: 16, background: 'var(--semi-color-bg-1)', borderRadius: 8, border: '1px solid var(--semi-color-border)' }}}}>
        <div style={{{{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}}}>
          <Title heading={{6}}>列表</Title>
          <Space>
            <Button onClick={{() => setImportModalVisible(true)}}>导入</Button>
            <Button onClick={{() => setExportModalVisible(true)}}>导出</Button>
            <Button icon={{<IconPlus />}} type="primary" onClick={{openCreate}}>新增</Button>
          </Space>
        </div>

        <Table columns={{columns}} dataSource={{data}} loading={{loading}} rowKey="id"
          pagination={{{{ total, currentPage: page, pageSize: 20, onPageChange: handlePageChange }}}}
        />
      </div>

      <Modal title={{editingItem ? '编辑' : '新增'}} visible={{modalVisible}}
        onOk={{handleModalOk}} onCancel={{() => setModalVisible(false)}} width={{480}}>
        <Form getFormApi={{(api) => {{ formApiRef.current = api }}}} labelPosition="left" labelWidth={{90}}>
{forms_str}
        </Form>
      </Modal>

      <ExportFieldsModal
        visible={{exportModalVisible}}
        title="导出设置"
        fieldOptions={{EXPORT_FIELDS}}
        onCancel={{() => setExportModalVisible(false)}}
        onConfirm={{handleExport}}
      />

      <ImportCsvModal
        visible={{importModalVisible}}
        title="导入数据"
        targetLabel="TODO: 替换资源名"
        onCancel={{() => setImportModalVisible(false)}}
        onDownloadTemplate={{(fileType) =>
          downloadTemplate(fileType)
            .then((blob) => {{ downloadBlobFile(blob, `{kebab}s_import_template.${{fileType}}`); Toast.success('模板下载成功') }})
            .catch(() => Toast.error('模板下载失败'))
        }}
        onImport={{importItems}}
        onImported={{() => {{ setImportModalVisible(false); fetchData() }}}}
        errorExportFileName="{kebab}s_import_errors.csv"
      />
    </div>
  )
}}
"""


# ─── 写文件 ────────────────────────────────────────────────────────────────────

def write_file(path: Path, content: str, dry_run: bool = False) -> None:
    if dry_run:
        print(f"  [dry-run] would write: {path.relative_to(ROOT)}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        print(f"  [skip] already exists: {path.relative_to(ROOT)}")
        return
    path.write_text(content, encoding='utf-8')
    print(f"  [create] {path.relative_to(ROOT)}")


# ─── 主流程 ────────────────────────────────────────────────────────────────────

def parse_fields(fields_str: str) -> list[tuple[str, str]]:
    """解析 "name:str,phone:str20,amount:float" 格式"""
    if not fields_str:
        return [('name', 'str')]
    result = []
    for part in fields_str.split(','):
        part = part.strip()
        if ':' in part:
            fname, ftype = part.split(':', 1)
            result.append((fname.strip(), ftype.strip()))
        else:
            result.append((part, 'str'))
    return result


def scaffold(name: str, domain: str, fields_str: str, dry_run: bool = False) -> None:
    fields = parse_fields(fields_str)

    # 权限前缀推断
    domain_prefix = 'system' if domain == 'admin' else 'cc'
    perm_prefix = f"{domain_prefix}_{name}"

    # 前端模块路径
    # admin 域：pages/<name>/index.jsx（与 users/roles 等保持一致，无子目录无 _page 后缀）
    # component_center 域：pages/admin/<name>_page/index.jsx（含子目录和 _page 后缀）
    module = 'admin' if domain == 'admin' else 'component_center'
    fe_base = ROOT / 'frontend' / 'src' / 'modules' / module

    if domain == 'admin':
        fe_page_path = fe_base / 'pages' / name / 'index.jsx'
        menu_component = f'admin/{name}'
    else:
        fe_page_path = fe_base / 'pages' / 'admin' / f'{name}_page' / 'index.jsx'
        menu_component = f'component_center/admin/{name}_page'

    print(f"\n🔧 Scaffolding: {name} (domain={domain})")
    print(f"   Fields: {fields}")
    print(f"   Perm prefix: {perm_prefix}")
    print(f"   Menu component: {menu_component}")
    print()

    # 后端文件
    be_base = ROOT / 'backend' / 'app' / domain
    write_file(be_base / 'model' / f'entities_{name}.py', gen_model(name, fields, domain), dry_run)
    write_file(be_base / 'crud' / f'{name}_crud.py', gen_crud(name), dry_run)
    write_file(be_base / 'service' / f'{name}_service.py', gen_service(name, fields, domain), dry_run)
    write_file(be_base / 'api' / f'{name}.py', gen_api(name, domain, perm_prefix), dry_run)

    # 前端文件
    write_file(fe_base / 'api' / f'{name}.js', gen_frontend_api(name, module), dry_run)
    write_file(fe_page_path, gen_frontend_page(name, fields, module), dry_run)

    print()
    print("✅ 骨架文件生成完成！")
    print()
    print("后续手动步骤：")
    print(f"  1. 在 backend/app/{domain}/model/__init__.py 中引入 build_{name}_models")
    print(f"  2. 在 backend/app/{domain}/api/router.py 中注册 init_{name}_api")
    print(f"  3. 在 backend/scripts/init_rbac_data.py 中添加菜单 + 按钮权限")
    print(f"  4. 运行: python3 backend/scripts/init_rbac_data.py --incremental")
    print(f"  5. 运行: flask db migrate -d backend/migrations -m 'add {name} table'")
    print(f"  6. 运行: flask db upgrade -d backend/migrations")
    print(f"  7. 运行: python3 backend/scripts/verify_feature.py --module {name}")


def main() -> int:
    parser = argparse.ArgumentParser(description='coati 代码骨架生成器')
    parser.add_argument('--name', required=True, help='资源名（snake_case，如 customer）')
    parser.add_argument('--domain', default='admin', choices=['admin', 'component_center'],
                        help='所属域（默认 admin）')
    parser.add_argument('--fields', default='name:str',
                        help='字段列表，格式 "name:str,amount:float"（默认 name:str）')
    parser.add_argument('--dry-run', action='store_true', help='只打印，不写文件')
    args = parser.parse_args()

    # 校验名称格式
    if not re.match(r'^[a-z][a-z0-9_]*$', args.name):
        print('❌ --name 必须是 snake_case 格式（小写字母+下划线），如 customer_order')
        return 1

    scaffold(args.name, args.domain, args.fields, dry_run=args.dry_run)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
