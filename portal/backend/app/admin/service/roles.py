# -*- coding: utf-8 -*-
"""角色模块 service 层"""

from sqlalchemy.orm import joinedload

from backend.common.tabular import build_table_response, normalize_table_file_type, read_table_file

from backend.app.admin.crud.roles import RoleCRUD
from backend.app.admin.schema.roles import EXPORT_FIELD_MAP, IMPORT_HEADER_MAP, build_error_row, parse_codes


class RoleServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class RoleService:
    def __init__(self, db, role_model, menu_model):
        self.db = db
        self.Role = role_model
        self.Menu = menu_model
        self.crud = RoleCRUD(db, role_model, menu_model)

    def list_roles(self):
        # 预加载 menus，避免每行 to_dict(include_menus=True) 触发 N+1
        roles = self.crud.query_roles().options(joinedload(self.Role.menus)).all()
        return [r.to_dict(include_menus=True) for r in roles]

    def create_role(self, data):
        if not data.get('name'):
            raise RoleServiceError('角色名称不能为空', 400)
        if not data.get('code'):
            raise RoleServiceError('角色编码不能为空', 400)

        if self.crud.get_role_by_code(data['code']):
            raise RoleServiceError('角色编码已存在', 400)

        new_role = self.Role(
            name=data['name'],
            code=data['code'],
            description=data.get('description')
        )

        if 'menu_ids' in data:
            new_role.menus = self.crud.list_menus_by_ids(data.get('menu_ids') or [])

        try:
            self.crud.add_role(new_role)
            self.crud.commit()
            return new_role.to_dict(include_menus=True), 201
        except Exception as e:
            self.crud.rollback()
            raise RoleServiceError(str(e), 500) from e

    def update_role(self, role, data):
        if 'name' in data:
            role.name = data['name']
        if 'code' in data:
            role.code = data['code']
        if 'description' in data:
            role.description = data['description']

        if 'menu_ids' in data:
            role.menus = self.crud.list_menus_by_ids(data.get('menu_ids') or [])

        try:
            self.crud.commit()
            return role.to_dict(include_menus=True)
        except Exception as e:
            self.crud.rollback()
            raise RoleServiceError(str(e), 500) from e

    def delete_role(self, role):
        try:
            self.crud.delete_role(role)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise RoleServiceError(str(e), 500) from e

    def export_roles(self, data):
        ids = data.get('ids') or []
        fields = data.get('fields') or []
        export_mode = (data.get('export_mode') or 'selected').strip()
        filters = data.get('filters') or {}
        file_type = normalize_table_file_type(data.get('file_type'), default='csv')

        valid_fields = [field for field in fields if field in EXPORT_FIELD_MAP]
        if not valid_fields:
            valid_fields = list(EXPORT_FIELD_MAP.keys())

        if export_mode == 'filtered':
            query = self.crud.query_roles()
            search = str(filters.get('search') or '').strip()
            if search:
                query = query.filter(self.db.or_(
                    self.Role.name.ilike(f'%{search}%'),
                    self.Role.code.ilike(f'%{search}%')
                ))
            items = query.order_by(self.Role.id.asc()).all()
        else:
            if not isinstance(ids, list) or not ids:
                raise RoleServiceError('请先勾选要导出的角色数据', 400)
            items = self.crud.list_roles_by_ids(ids).order_by(self.Role.id.asc()).all()

        headers = [EXPORT_FIELD_MAP[field][0] for field in valid_fields]
        rows = [[EXPORT_FIELD_MAP[field][1](item) for field in valid_fields] for item in items]
        try:
            return build_table_response(headers, rows, 'roles_export', file_type=file_type)
        except RuntimeError as e:
            raise RoleServiceError(str(e), 500) from e

    def download_template(self, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='csv')
        headers = ['角色名称', '角色编码', '描述', '菜单编码']
        rows = [['示例角色', 'demo_role', '示例描述', 'dashboard,system_users']]
        try:
            return build_table_response(headers, rows, 'roles_import_template', file_type=file_type)
        except RuntimeError as e:
            raise RoleServiceError(str(e), 500) from e

    def import_roles(self, file_storage):
        if not file_storage:
            raise RoleServiceError('请上传导入文件', 400)

        try:
            fieldnames, rows_with_line, _ = read_table_file(file_storage)
        except ValueError as e:
            raise RoleServiceError(str(e), 400) from e
        except RuntimeError as e:
            raise RoleServiceError(str(e), 500) from e

        if not fieldnames:
            raise RoleServiceError('导入内容为空', 400)

        row_header_map = {}
        for header in fieldnames:
            key = (header or '').strip()
            if key in IMPORT_HEADER_MAP:
                row_header_map[header] = IMPORT_HEADER_MAP[key]

        if 'name' not in row_header_map.values() or 'code' not in row_header_map.values():
            raise RoleServiceError('导入文件缺少“角色名称/角色编码”列', 400)

        created = 0
        updated = 0
        errors = []

        try:
            for line, row in rows_with_line:
                mapped = {}
                for key, value in row.items():
                    field = row_header_map.get(key)
                    if field:
                        mapped[field] = value

                name = str(mapped.get('name') or '').strip()
                code = str(mapped.get('code') or '').strip()
                description = str(mapped.get('description') or '').strip() or None
                menu_codes = parse_codes(mapped.get('menu_codes'))

                if not name or not code:
                    errors.append(build_error_row(line, '角色名称和编码不能为空', row))
                    continue

                menus = []
                if menu_codes:
                    menus = self.crud.list_menus_by_codes(menu_codes)
                    found_codes = {menu.code for menu in menus}
                    missing_codes = [item for item in menu_codes if item not in found_codes]
                    if missing_codes:
                        errors.append(build_error_row(line, f'菜单编码不存在: {", ".join(missing_codes)}', row))
                        continue

                item = self.crud.get_role_by_code(code)
                if item:
                    item.name = name
                    item.description = description
                    if menu_codes:
                        item.menus = menus
                    updated += 1
                else:
                    item = self.Role(name=name, code=code, description=description)
                    item.menus = menus
                    self.crud.add_role(item)
                    created += 1

            if errors:
                self.crud.rollback()
                raise RoleServiceError('导入失败，存在错误数据', 400, {
                    'error_rows': errors[:500],
                    'error_count': len(errors),
                })

            self.crud.commit()
            return {'message': '导入成功', 'created': created, 'updated': updated}
        except RoleServiceError:
            raise
        except Exception as e:
            self.crud.rollback()
            raise RoleServiceError(str(e), 500) from e
