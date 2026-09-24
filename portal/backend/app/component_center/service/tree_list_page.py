# -*- coding: utf-8 -*-
"""树形列表页 service 层"""

from backend.app.component_center.crud.tree_list_page import TreeListPageCRUD
from backend.app.component_center.schema.tree_list_page import (
    EXPORT_FIELD_MAP,
    IMPORT_HEADER_MAP,
    build_error_row,
    parse_bool,
    parse_int,
)
from backend.common.tabular import build_table_response, normalize_table_file_type, read_table_file
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete

STATUS_VALUES = {'active', 'inactive', 'archived'}
NODE_TYPE_VALUES = {'category', 'item', 'group'}


class TreeListPageServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class TreeListPageService:
    def __init__(self, db, tree_node_model):
        self.db = db
        self.TreeNode = tree_node_model
        self.crud = TreeListPageCRUD(db, tree_node_model)

    @staticmethod
    def normalize_status(value, default='active'):
        if value is None:
            return default
        raw = str(value).strip().lower()
        if not raw:
            return default
        if raw not in STATUS_VALUES:
            raise TreeListPageServiceError('状态仅支持 active/inactive/archived', 400)
        return raw

    def _build_flat_query(self, search='', node_type='', status='', owner='', is_active=None):
        query = self.crud.query()
        if search:
            query = query.filter(self.db.or_(
                self.TreeNode.name.ilike(f'%{search}%'),
                self.TreeNode.node_code.ilike(f'%{search}%'),
                self.TreeNode.owner.ilike(f'%{search}%'),
            ))
        if node_type:
            query = query.filter(self.TreeNode.node_type == node_type)
        if status:
            query = query.filter(self.TreeNode.status == status)
        if owner:
            query = query.filter(self.TreeNode.owner.ilike(f'%{owner}%'))
        if is_active is not None:
            query = query.filter(self.TreeNode.is_active == is_active)
        return query

    def _build_tree(self, nodes):
        """将 flat 节点列表构建为嵌套树结构（用于 Tree 组件）"""
        node_map = {n.id: {**n.to_dict(), 'children': [], 'children_count': 0} for n in nodes}
        roots = []
        for node in nodes:
            d = node_map[node.id]
            if node.parent_id and node.parent_id in node_map:
                parent = node_map[node.parent_id]
                parent['children'].append(d)
                parent['children_count'] += 1
            else:
                roots.append(d)
        return sorted(roots, key=lambda x: (x.get('sort_order') or 0, x.get('id') or 0))

    def get_tree(self, search='', node_type='', status='', owner='', is_active=None):
        """获取完整树形结构（用于左侧 Tree 组件）"""
        query = self._build_flat_query(search=search, node_type=node_type, status=status, owner=owner, is_active=is_active)
        nodes = query.order_by(
            self.TreeNode.sort_order.asc(),
            self.TreeNode.id.asc(),
        ).all()
        return self._build_tree(nodes)

    def list_items(self, page=1, per_page=20, search='', node_type='', status='', owner='', is_active=None, parent_id=None):
        """平铺列表（含分页），用于右侧表格"""
        query = self._build_flat_query(search=search, node_type=node_type, status=status, owner=owner, is_active=is_active)
        if parent_id == 'root':
            query = query.filter(self.TreeNode.parent_id.is_(None))
        elif parent_id is not None:
            query = query.filter(self.TreeNode.parent_id == parent_id)
        pagination = query.order_by(
            self.TreeNode.sort_order.asc(),
            self.TreeNode.id.asc(),
        ).paginate(page=page, per_page=per_page, error_out=False)
        return {
            'items': [item.to_dict() for item in pagination.items],
            'total': pagination.total,
            'page': page,
            'per_page': per_page,
        }

    def create_item(self, data):
        name = str(data.get('name') or '').strip()
        node_code = str(data.get('node_code') or '').strip()
        if not name:
            raise TreeListPageServiceError('节点名称不能为空', 400)
        if not node_code:
            raise TreeListPageServiceError('节点编码不能为空', 400)
        if self.crud.get_by_code(node_code):
            raise TreeListPageServiceError('节点编码已存在', 400)

        parent_id = data.get('parent_id')
        if parent_id is not None:
            try:
                parent_id = int(parent_id)
            except (ValueError, TypeError):
                parent_id = None
        if parent_id:
            if not self.crud.query().filter(self.TreeNode.id == parent_id).first():
                raise TreeListPageServiceError('父节点不存在', 400)

        status = self.normalize_status(data.get('status'), default='active')
        item = self.TreeNode(
            name=name,
            node_code=node_code,
            parent_id=parent_id,
            node_type=str(data.get('node_type') or 'category').strip() or 'category',
            icon=str(data.get('icon') or '').strip() or None,
            description=str(data.get('description') or '').strip() or None,
            sort_order=parse_int(data.get('sort_order'), default=0),
            is_active=parse_bool(data.get('is_active'), default=True),
            status=status,
            owner=str(data.get('owner') or '').strip() or None,
        )
        try:
            self.crud.add(item)
            self.crud.commit()
            return item.to_dict(), 201
        except TreeListPageServiceError:
            self.crud.rollback()
            raise
        except Exception as e:
            self.crud.rollback()
            raise TreeListPageServiceError(str(e), 500) from e

    def update_item(self, item, data):
        if 'name' in data and not str(data.get('name') or '').strip():
            raise TreeListPageServiceError('节点名称不能为空', 400)
        if 'node_code' in data:
            next_code = str(data.get('node_code') or '').strip()
            if not next_code:
                raise TreeListPageServiceError('节点编码不能为空', 400)
            duplicate = self.crud.query().filter(
                self.TreeNode.node_code == next_code,
                self.TreeNode.id != item.id,
            ).first()
            if duplicate:
                raise TreeListPageServiceError('节点编码已存在', 400)

        update_map = {
            'name': lambda val: str(val or '').strip(),
            'icon': lambda val: str(val or '').strip() or None,
            'description': lambda val: str(val or '').strip() or None,
            'owner': lambda val: str(val or '').strip() or None,
            'node_type': lambda val: str(val or '').strip() or 'category',
            'sort_order': lambda val: parse_int(val, default=item.sort_order or 0),
            'is_active': lambda val: parse_bool(val, default=item.is_active),
        }
        for field, converter in update_map.items():
            if field in data:
                setattr(item, field, converter(data.get(field)))

        if 'parent_id' in data:
            pid = data.get('parent_id')
            if pid is None or pid == '' or pid == 0:
                item.parent_id = None
            else:
                try:
                    new_pid = int(pid)
                    if new_pid != item.id:
                        if not self.crud.query().filter(self.TreeNode.id == new_pid).first():
                            raise TreeListPageServiceError('父节点不存在', 400)
                        item.parent_id = new_pid
                except (ValueError, TypeError):
                    pass

        if 'status' in data:
            item.status = self.normalize_status(data.get('status'), default=item.status or 'active')

        try:
            self.crud.commit()
            return item.to_dict()
        except TreeListPageServiceError:
            self.crud.rollback()
            raise
        except Exception as e:
            self.crud.rollback()
            raise TreeListPageServiceError(str(e), 500) from e

    def delete_item(self, item):
        if is_enabled_for_delete(item):
            raise TreeListPageServiceError(enabled_delete_message('节点'), 409)
        # 将子节点的 parent_id 置为 None（已由 ON DELETE SET NULL 数据库约束处理）
        try:
            self.crud.delete(item)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise TreeListPageServiceError(str(e), 500) from e

    def export_items(self, data, request_method='POST'):
        if request_method == 'GET':
            ids = []
            fields_raw = str(data.get('fields') or '').strip()
            fields = [f.strip() for f in fields_raw.split(',') if f.strip()] if fields_raw else []
            export_mode = 'filtered'
            filters = {
                'search': data.get('search'),
                'node_type': data.get('node_type'),
                'status': data.get('status'),
                'owner': data.get('owner'),
                'is_active': data.get('is_active'),
            }
            file_type = normalize_table_file_type(data.get('file_type'), default='csv')
        else:
            ids = data.get('ids') or []
            fields = data.get('fields') or []
            export_mode = str(data.get('export_mode') or 'selected').strip()
            filters = data.get('filters') or {}
            file_type = normalize_table_file_type(data.get('file_type'), default='csv')

        valid_fields = [f for f in fields if f in EXPORT_FIELD_MAP]
        if not valid_fields:
            valid_fields = list(EXPORT_FIELD_MAP.keys())

        if export_mode == 'filtered':
            query = self._build_flat_query(
                search=str(filters.get('search') or '').strip(),
                node_type=str(filters.get('node_type') or '').strip(),
                status=str(filters.get('status') or '').strip(),
                owner=str(filters.get('owner') or '').strip(),
                is_active=parse_bool(filters.get('is_active')),
            )
            items = query.order_by(self.TreeNode.id.asc()).all()
        else:
            if not isinstance(ids, list) or not ids:
                raise TreeListPageServiceError('请先勾选要导出的数据', 400)
            items = self.crud.list_by_ids(ids).order_by(self.TreeNode.id.asc()).all()

        headers = [EXPORT_FIELD_MAP[f][0] for f in valid_fields]
        rows = [[EXPORT_FIELD_MAP[f][1](item) for f in valid_fields] for item in items]
        try:
            return build_table_response(headers, rows, 'tree_list_page_export', file_type=file_type)
        except RuntimeError as e:
            raise TreeListPageServiceError(str(e), 500) from e

    def download_template(self, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='csv')
        headers = ['节点名称', '节点编码', '父节点ID', '节点类型', '图标', '状态', '负责人', '排序', '启用', '描述']
        rows = [['根节点示例', 'root_001', '', 'category', '', 'active', 'admin', 0, '启用', '示例描述']]
        try:
            return build_table_response(headers, rows, 'tree_list_page_import_template', file_type=file_type)
        except RuntimeError as e:
            raise TreeListPageServiceError(str(e), 500) from e

    def import_items(self, file_storage):
        if not file_storage:
            raise TreeListPageServiceError('请上传导入文件', 400)

        try:
            fieldnames, rows_with_line, _ = read_table_file(file_storage)
        except ValueError as e:
            raise TreeListPageServiceError(str(e), 400) from e
        except RuntimeError as e:
            raise TreeListPageServiceError(str(e), 500) from e

        if not fieldnames:
            raise TreeListPageServiceError('导入内容为空', 400)

        row_header_map = {}
        for header in fieldnames:
            key = (header or '').strip()
            if key in IMPORT_HEADER_MAP:
                row_header_map[header] = IMPORT_HEADER_MAP[key]

        if 'name' not in row_header_map.values() or 'node_code' not in row_header_map.values():
            raise TreeListPageServiceError('导入文件缺少"节点名称/节点编码"列', 400)

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
                node_code = str(mapped.get('node_code') or '').strip()
                if not name or not node_code:
                    errors.append(build_error_row(line, '节点名称和编码不能为空', row))
                    continue

                parent_id_raw = mapped.get('parent_id')
                parent_id = None
                if parent_id_raw:
                    try:
                        parent_id = int(parent_id_raw)
                    except (ValueError, TypeError):
                        parent_id = None

                node_type = str(mapped.get('node_type') or 'category').strip() or 'category'
                status = self.normalize_status(mapped.get('status'), default='active')
                icon = str(mapped.get('icon') or '').strip() or None
                owner = str(mapped.get('owner') or '').strip() or None
                sort_order = parse_int(mapped.get('sort_order'), default=0)
                is_active = parse_bool(mapped.get('is_active'), default=True)
                description = str(mapped.get('description') or '').strip() or None

                item = self.crud.get_by_code(node_code)
                if item:
                    item.name = name
                    item.parent_id = parent_id
                    item.node_type = node_type
                    item.icon = icon
                    item.status = status
                    item.owner = owner
                    item.sort_order = sort_order
                    item.is_active = is_active
                    item.description = description
                    updated += 1
                else:
                    item = self.TreeNode(
                        name=name,
                        node_code=node_code,
                        parent_id=parent_id,
                        node_type=node_type,
                        icon=icon,
                        status=status,
                        owner=owner,
                        sort_order=sort_order,
                        is_active=is_active,
                        description=description,
                    )
                    self.crud.add(item)
                    created += 1

            if errors:
                self.crud.rollback()
                raise TreeListPageServiceError('导入失败，存在错误数据', 400, {
                    'error_rows': errors[:500],
                    'error_count': len(errors),
                })

            self.crud.commit()
            return {'message': '导入成功', 'created': created, 'updated': updated}
        except TreeListPageServiceError:
            raise
        except Exception as e:
            self.crud.rollback()
            raise TreeListPageServiceError(str(e), 500) from e
