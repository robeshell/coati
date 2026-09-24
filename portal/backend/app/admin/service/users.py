# -*- coding: utf-8 -*-
"""用户模块 service 层"""

from sqlalchemy.orm import joinedload

from backend.common.tabular import build_table_response, normalize_table_file_type, read_table_file

from backend.app.admin.crud.users import UserCRUD
from backend.app.admin.schema.users import EXPORT_FIELD_MAP, IMPORT_HEADER_MAP, build_error_row, parse_role_codes


class UserServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class UserService:
    def __init__(self, db, admin_model, role_model):
        self.db = db
        self.Admin = admin_model
        self.Role = role_model
        self.crud = UserCRUD(db, admin_model, role_model)

    def list_users(self, page=1, per_page=20, search=''):
        query = self.crud.query_users()
        if search:
            query = query.filter(self.Admin.username.ilike(f'%{search}%'))

        # 预加载 roles + menus，避免每行 to_dict 触发 N+1
        query = query.options(
            joinedload(self.Admin.roles).joinedload(self.Role.menus)
        )

        pagination = query.order_by(self.Admin.id.desc()).paginate(
            page=page,
            per_page=per_page,
            error_out=False,
        )
        return {
            'items': [u.to_dict() for u in pagination.items],
            'total': pagination.total,
            'page': page,
            'per_page': per_page,
        }

    def _resolve_roles(self, role_ids):
        """校验 role_ids 全部存在，返回角色列表；存在无效 id 时报错"""
        ids = role_ids or []
        roles = self.crud.list_roles_by_ids(ids)
        valid_ids = {role.id for role in roles}
        missing = [rid for rid in ids if rid not in valid_ids]
        if missing:
            raise UserServiceError(f'角色不存在: {missing}', 400)
        return roles

    def _is_last_super_admin(self, user):
        """user 是否为最后一个超级管理员"""
        super_admin_role = self.Role.query.filter_by(code='super_admin').first()
        if not super_admin_role or super_admin_role not in user.roles:
            return False
        others = self.db.session.query(self.Admin).join(self.Admin.roles).filter(
            self.Role.id == super_admin_role.id,
            self.Admin.id != user.id,
        ).count()
        return others == 0

    def create_user(self, data):
        if not data.get('username') or not data.get('password'):
            raise UserServiceError('用户名和密码不能为空', 400)

        if self.crud.get_user_by_username(data['username']):
            raise UserServiceError('用户名已存在', 400)

        new_user = self.Admin(username=data['username'])
        new_user.set_password(data['password'])

        if 'role_ids' in data:
            new_user.roles = self._resolve_roles(data.get('role_ids'))

        try:
            self.crud.add_user(new_user)
            self.crud.commit()
            return new_user.to_dict(), 201
        except Exception as e:
            self.crud.rollback()
            raise UserServiceError(str(e), 500) from e

    def update_user(self, user, data):
        if 'password' in data and data['password']:
            user.set_password(data['password'])

        if 'role_ids' in data:
            user.roles = self._resolve_roles(data.get('role_ids'))

        try:
            self.crud.commit()
            return user.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise UserServiceError(str(e), 500) from e

    def delete_user(self, user, current_username):
        if user.username == current_username:
            raise UserServiceError('不能删除当前登录账号', 400)
        if self._is_last_super_admin(user):
            raise UserServiceError('不能删除最后一个超级管理员', 400)
        try:
            self.crud.delete_user(user)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise UserServiceError(str(e), 500) from e

    def export_users(self, data):
        ids = data.get('ids') or []
        fields = data.get('fields') or []
        export_mode = (data.get('export_mode') or 'selected').strip()
        filters = data.get('filters') or {}
        file_type = normalize_table_file_type(data.get('file_type'), default='csv')

        valid_fields = [field for field in fields if field in EXPORT_FIELD_MAP]
        if not valid_fields:
            valid_fields = list(EXPORT_FIELD_MAP.keys())

        if export_mode == 'filtered':
            query = self.crud.query_users()
            search = str(filters.get('search') or '').strip()
            if search:
                query = query.filter(self.Admin.username.ilike(f'%{search}%'))
            items = query.order_by(self.Admin.id.asc()).all()
        else:
            if not isinstance(ids, list) or not ids:
                raise UserServiceError('请先勾选要导出的用户数据', 400)
            items = self.crud.list_users_by_ids(ids).order_by(self.Admin.id.asc()).all()

        headers = [EXPORT_FIELD_MAP[field][0] for field in valid_fields]
        rows = [[EXPORT_FIELD_MAP[field][1](item) for field in valid_fields] for item in items]

        try:
            return build_table_response(headers, rows, 'users_export', file_type=file_type)
        except RuntimeError as e:
            raise UserServiceError(str(e), 500) from e

    def download_template(self, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='csv')
        headers = ['用户名', '密码', '角色编码']
        rows = [['demo_user', '123456', 'super_admin']]
        try:
            return build_table_response(headers, rows, 'users_import_template', file_type=file_type)
        except RuntimeError as e:
            raise UserServiceError(str(e), 500) from e

    def import_users(self, file_storage):
        if not file_storage:
            raise UserServiceError('请上传导入文件', 400)

        try:
            fieldnames, rows_with_line, _ = read_table_file(file_storage)
        except ValueError as e:
            raise UserServiceError(str(e), 400) from e
        except RuntimeError as e:
            raise UserServiceError(str(e), 500) from e

        if not fieldnames:
            raise UserServiceError('导入内容为空', 400)

        row_header_map = {}
        for header in fieldnames:
            key = (header or '').strip()
            if key in IMPORT_HEADER_MAP:
                row_header_map[header] = IMPORT_HEADER_MAP[key]

        if 'username' not in row_header_map.values():
            raise UserServiceError('导入文件缺少“用户名”列', 400)

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

                username = str(mapped.get('username') or '').strip()
                password = str(mapped.get('password') or '').strip()
                role_codes = parse_role_codes(mapped.get('role_codes'))

                if not username:
                    errors.append(build_error_row(line, '用户名不能为空', row))
                    continue

                roles = []
                if role_codes:
                    roles = self.crud.list_roles_by_codes(role_codes)
                    found_codes = {role.code for role in roles}
                    missing_codes = [code for code in role_codes if code not in found_codes]
                    if missing_codes:
                        errors.append(build_error_row(line, f'角色编码不存在: {", ".join(missing_codes)}', row))
                        continue

                item = self.crud.get_user_by_username(username)
                if item:
                    if password:
                        item.set_password(password)
                    if role_codes:
                        item.roles = roles
                    updated += 1
                else:
                    if not password:
                        errors.append(build_error_row(line, '新增用户必须提供密码', row))
                        continue
                    item = self.Admin(username=username)
                    item.set_password(password)
                    item.roles = roles
                    self.crud.add_user(item)
                    created += 1

            if errors:
                self.crud.rollback()
                raise UserServiceError('导入失败，存在错误数据', 400, {
                    'error_rows': errors[:500],
                    'error_count': len(errors),
                })

            self.crud.commit()
            return {'message': '导入成功', 'created': created, 'updated': updated}
        except UserServiceError:
            raise
        except Exception as e:
            self.crud.rollback()
            raise UserServiceError(str(e), 500) from e
