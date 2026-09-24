# -*- coding: utf-8 -*-
"""菜单模块业务层（service）"""

from backend.common.tabular import build_table_response, normalize_table_file_type, read_table_file
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete
from backend.app.admin.crud.menu import MenuCRUD
from backend.app.admin.schema.menu import (
    EXPORT_FIELD_MAP,
    IMPORT_HEADER_MAP,
    MENU_MUTABLE_FIELDS,
    MENU_TYPES,
    MenuSchemaError,
    build_error_row,
    map_import_headers,
    parse_bool,
    parse_import_row,
    parse_int,
    validate_create_payload,
    validate_update_payload,
)


class MenuServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class MenuService:
    def __init__(self, db, menu_model):
        self.db = db
        self.Menu = menu_model
        self.crud = MenuCRUD(db, menu_model)

    def build_menu_entity(self, data):
        return self.Menu(
            name=data['name'],
            code=data['code'],
            icon=data.get('icon'),
            path=data.get('path'),
            component=data.get('component'),
            parent_id=data.get('parent_id'),
            sort_order=data.get('sort_order', 0),
            is_visible=data.get('is_visible', True),
            is_active=data.get('is_active', True),
            menu_type=data.get('menu_type', 'menu'),
            description=data.get('description')
        )

    def list_menus(self, format_type='tree', search=''):
        query = self.crud.query()
        if search:
            query = query.filter(self.db.or_(
                self.Menu.name.ilike(f'%{search}%'),
                self.Menu.code.ilike(f'%{search}%')
            ))

        if format_type == 'tree':
            root_menus = query.filter(self.Menu.parent_id.is_(None)).order_by(
                self.Menu.sort_order.asc(),
                self.Menu.id.asc()
            ).all()
            return [menu.to_dict(include_children=True) for menu in root_menus]

        menus = query.order_by(self.Menu.sort_order.asc(), self.Menu.id.asc()).all()
        return [menu.to_dict(include_children=False) for menu in menus]

    def create_menu(self, data):
        try:
            validate_create_payload(data)
        except MenuSchemaError as e:
            raise MenuServiceError(e.message, 400) from e

        if self.crud.get_by_code(data['code']):
            raise MenuServiceError(f'菜单编码 {data["code"]} 已存在', 400)

        try:
            self.crud.sync_id_sequence()
            new_menu = self.build_menu_entity(data)
            self.crud.add(new_menu)
            self.crud.commit()
            return new_menu.to_dict(), 201
        except Exception as e:
            self.crud.rollback()
            if 'menus_pkey' in str(e):
                try:
                    self.crud.sync_id_sequence()
                    new_menu = self.build_menu_entity(data)
                    self.crud.add(new_menu)
                    self.crud.commit()
                    return new_menu.to_dict(), 201
                except Exception as retry_error:
                    self.crud.rollback()
                    raise MenuServiceError(str(retry_error), 500) from retry_error
            raise MenuServiceError(str(e), 500) from e

    def update_menu(self, menu, data):
        try:
            validate_update_payload(data)
        except MenuSchemaError as e:
            raise MenuServiceError(e.message, 400) from e

        if data.get('code') and data['code'] != menu.code:
            if self.crud.get_by_code(data['code']):
                raise MenuServiceError(f'菜单编码 {data["code"]} 已存在', 400)

        for field in MENU_MUTABLE_FIELDS:
            if field in data:
                setattr(menu, field, data[field])

        try:
            self.crud.commit()
            return menu.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise MenuServiceError(str(e), 500) from e

    def delete_menu(self, menu):
        if is_enabled_for_delete(menu):
            raise MenuServiceError(enabled_delete_message('菜单'), 409)
        if menu.children.count() > 0:
            raise MenuServiceError('该菜单下还有子菜单，无法删除', 400)
        try:
            self.crud.delete(menu)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise MenuServiceError(str(e), 500) from e

    def sort_menu(self, menu, direction):
        direction = str(direction or '').strip().lower()
        if direction not in {'up', 'down'}:
            raise MenuServiceError('direction 参数必须是 up 或 down', 400)

        siblings = self.crud.list_by_parent(menu.parent_id).order_by(
            self.Menu.sort_order.asc(),
            self.Menu.id.asc()
        ).all()
        if len(siblings) <= 1:
            return {'message': '当前层级只有一个菜单，无需排序', 'changed': False}

        id_list = [item.id for item in siblings]
        if menu.id not in id_list:
            return {'message': '菜单不存在于当前层级', 'changed': False}

        idx = id_list.index(menu.id)
        if direction == 'up':
            if idx == 0:
                return {'message': '当前菜单已在最前', 'changed': False}
            id_list[idx - 1], id_list[idx] = id_list[idx], id_list[idx - 1]
        else:
            if idx == len(id_list) - 1:
                return {'message': '当前菜单已在最后', 'changed': False}
            id_list[idx + 1], id_list[idx] = id_list[idx], id_list[idx + 1]

        menu_map = {item.id: item for item in siblings}
        for order_idx, menu_id in enumerate(id_list, start=1):
            menu_map[menu_id].sort_order = order_idx * 10

        try:
            self.crud.commit()
            return {'message': '排序成功', 'changed': True}
        except Exception as e:
            self.crud.rollback()
            raise MenuServiceError(str(e), 500) from e

    def get_my_menus(self, user):
        if not user:
            return []

        menu_ids = set()
        for role in user.roles:
            for menu in role.menus:
                if menu.is_active and menu.is_visible:
                    menu_ids.add(menu.id)
                    current = menu.parent
                    while current:
                        menu_ids.add(current.id)
                        current = current.parent

        if not menu_ids:
            return []

        menus = self.crud.list_by_ids(menu_ids).order_by(self.Menu.sort_order.asc(), self.Menu.id.asc()).all()

        menu_dict = {m.id: m.to_dict(include_children=False) for m in menus}
        for menu in menus:
            if menu.parent_id and menu.parent_id in menu_dict:
                if 'children' not in menu_dict[menu.parent_id]:
                    menu_dict[menu.parent_id]['children'] = []
                menu_dict[menu.parent_id]['children'].append(menu_dict[menu.id])

        return [menu_dict[m.id] for m in menus if not m.parent_id]

    def export_menus(self, data):
        ids = data.get('ids') or []
        fields = data.get('fields') or []
        export_mode = (data.get('export_mode') or 'selected').strip()
        filters = data.get('filters') or {}
        file_type = normalize_table_file_type(data.get('file_type'), default='csv')

        valid_fields = [field for field in fields if field in EXPORT_FIELD_MAP]
        if not valid_fields:
            valid_fields = list(EXPORT_FIELD_MAP.keys())

        if export_mode == 'filtered':
            query = self.crud.query()
            search = str(filters.get('search') or '').strip()
            if search:
                query = query.filter(self.db.or_(
                    self.Menu.name.ilike(f'%{search}%'),
                    self.Menu.code.ilike(f'%{search}%')
                ))
            items = query.order_by(self.Menu.sort_order.asc(), self.Menu.id.asc()).all()
        else:
            if not isinstance(ids, list) or not ids:
                raise MenuServiceError('请先勾选要导出的菜单数据', 400)
            items = self.crud.list_by_ids(ids).order_by(self.Menu.sort_order.asc(), self.Menu.id.asc()).all()

        headers = [EXPORT_FIELD_MAP[field][0] for field in valid_fields]
        rows = [[EXPORT_FIELD_MAP[field][1](item) for field in valid_fields] for item in items]

        try:
            return build_table_response(headers, rows, 'menus_export', file_type=file_type)
        except RuntimeError as e:
            raise MenuServiceError(str(e), 500) from e

    def download_template(self, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='csv')
        headers = ['菜单名称', '菜单编码', '类型', '路径', '组件', '图标', '父级编码', '排序', '是否显示', '是否启用', '描述']
        rows = [['示例菜单', 'demo_menu', 'menu', '/demo/menu', 'DemoMenu', 'IconApps', '', 99, '是', '是', '示例描述']]
        try:
            return build_table_response(headers, rows, 'menus_import_template', file_type=file_type)
        except RuntimeError as e:
            raise MenuServiceError(str(e), 500) from e

    def import_menus(self, file_storage):
        if not file_storage:
            raise MenuServiceError('请上传导入文件', 400)

        try:
            fieldnames, rows_with_line, _ = read_table_file(file_storage)
        except ValueError as e:
            raise MenuServiceError(str(e), 400) from e
        except RuntimeError as e:
            raise MenuServiceError(str(e), 500) from e

        if not fieldnames:
            raise MenuServiceError('导入内容为空', 400)

        row_header_map = map_import_headers(fieldnames)
        if 'name' not in row_header_map.values() or 'code' not in row_header_map.values():
            raise MenuServiceError('导入文件缺少“菜单名称/菜单编码”列', 400)

        created = 0
        updated = 0
        errors = []
        pending_parent = []
        menu_cache = {menu.code: menu for menu in self.crud.list_all()}

        try:
            for line, row in rows_with_line:
                mapped = {}
                for key, value in row.items():
                    field = row_header_map.get(key)
                    if field:
                        mapped[field] = value

                parsed = parse_import_row(mapped)
                if not parsed['name'] or not parsed['code']:
                    errors.append(build_error_row(line, '菜单名称和编码不能为空', row))
                    continue
                if parsed['menu_type'] not in MENU_TYPES:
                    errors.append(build_error_row(line, f"类型无效: {parsed['menu_type']}", row))
                    continue

                item = menu_cache.get(parsed['code'])
                if item:
                    updated += 1
                else:
                    item = self.Menu(code=parsed['code'])
                    self.crud.add(item)
                    menu_cache[parsed['code']] = item
                    created += 1

                item.name = parsed['name']
                item.menu_type = parsed['menu_type']
                item.path = parsed['path']
                item.component = parsed['component']
                item.icon = parsed['icon']
                item.sort_order = parse_int(parsed['sort_order'], default=item.sort_order or 0)
                item.is_visible = parse_bool(parsed['is_visible'], default=item.is_visible if item.is_visible is not None else True)
                item.is_active = parse_bool(parsed['is_active'], default=item.is_active if item.is_active is not None else True)
                item.description = parsed['description']

                pending_parent.append((item, parsed['parent_code'], line, row))

            self.crud.flush()

            for item, parent_code, source_line, source_row in pending_parent:
                if not parent_code:
                    item.parent_id = None
                    continue
                parent = menu_cache.get(parent_code)
                if not parent:
                    errors.append(build_error_row(source_line, f'父级编码不存在: {parent_code}', source_row))
                    continue
                if parent.code == item.code:
                    errors.append(build_error_row(source_line, '父级编码不能等于自身编码', source_row))
                    continue
                item.parent_id = parent.id

            if errors:
                self.crud.rollback()
                raise MenuServiceError(
                    '导入失败，存在错误数据',
                    400,
                    payload={'error_rows': errors[:500], 'error_count': len(errors)}
                )

            self.crud.commit()
            return {'message': '导入成功', 'created': created, 'updated': updated}
        except MenuServiceError:
            raise
        except Exception as e:
            self.crud.rollback()
            raise MenuServiceError(str(e), 500) from e
