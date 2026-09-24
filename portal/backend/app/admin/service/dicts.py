# -*- coding: utf-8 -*-
"""数据字典 service 层"""

from backend.common.tabular import build_table_response, normalize_table_file_type, read_table_file
from backend.common.delete_policy import enabled_delete_message, is_enabled_for_delete

from backend.app.admin.crud.dicts import DictsCRUD
from backend.app.admin.schema.dicts import (
    CSV_HEADER_TO_FIELD,
    LEGACY_CSV_HEADER_TO_FIELD,
    normalize_string,
    parse_bool,
    parse_int,
)


class DictsServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class DictsService:
    def __init__(self, db, dict_type_model, dict_item_model):
        self.db = db
        self.DictType = dict_type_model
        self.DictItem = dict_item_model
        self.crud = DictsCRUD(db, dict_type_model, dict_item_model)

    def get_dict_options(self, raw_codes):
        if not raw_codes:
            raise DictsServiceError('codes 参数不能为空', 400)

        codes = []
        seen = set()
        for code in [c.strip() for c in raw_codes.split(',') if c.strip()]:
            if code in seen:
                continue
            seen.add(code)
            codes.append(code)

        dict_types = self.crud.list_active_dict_types_by_codes(codes)
        type_map = {item.code: item for item in dict_types}

        result = {}
        for code in codes:
            dict_type = type_map.get(code)
            if not dict_type:
                result[code] = []
                continue

            items = self.crud.list_items_by_type_id(dict_type.id).filter(
                self.DictItem.is_active.is_(True)
            ).order_by(self.DictItem.sort_order.asc(), self.DictItem.id.asc()).all()

            result[code] = [{
                'label': item.label,
                'value': item.value,
                'color': item.color,
                'is_default': item.is_default,
            } for item in items]

        return result

    def list_dict_types(self, page=1, per_page=20, search='', is_active=None):
        query = self.crud.query_dict_types()
        if search:
            query = query.filter(self.db.or_(
                self.DictType.name.ilike(f'%{search}%'),
                self.DictType.code.ilike(f'%{search}%'),
            ))
        if is_active is not None:
            query = query.filter(self.DictType.is_active == is_active)

        pagination = query.order_by(
            self.DictType.sort_order.asc(),
            self.DictType.id.asc(),
        ).paginate(page=page, per_page=per_page, error_out=False)

        return {
            'items': [item.to_dict() for item in pagination.items],
            'total': pagination.total,
            'page': page,
            'per_page': per_page,
        }

    def create_dict_type(self, data):
        name = normalize_string(data.get('name'))
        code = normalize_string(data.get('code'))

        if not name:
            raise DictsServiceError('字典名称不能为空', 400)
        if not code:
            raise DictsServiceError('字典编码不能为空', 400)
        if self.crud.get_dict_type_by_code(code):
            raise DictsServiceError('字典编码已存在', 400)

        item = self.DictType(
            name=name,
            code=code,
            description=data.get('description'),
            sort_order=data.get('sort_order', 0),
            is_active=data.get('is_active', True),
        )
        try:
            self.crud.add(item)
            self.crud.commit()
            return item.to_dict(), 201
        except Exception as e:
            self.crud.rollback()
            raise DictsServiceError(str(e), 500) from e

    def get_dict_type(self, item, include_items=False):
        return item.to_dict(include_items=include_items)

    def update_dict_type(self, item, data):
        if 'name' in data and not normalize_string(data.get('name')):
            raise DictsServiceError('字典名称不能为空', 400)

        if 'code' in data:
            new_code = normalize_string(data.get('code'))
            if not new_code:
                raise DictsServiceError('字典编码不能为空', 400)
            duplicate = self.crud.query_dict_types().filter(
                self.DictType.code == new_code,
                self.DictType.id != item.id,
            ).first()
            if duplicate:
                raise DictsServiceError('字典编码已存在', 400)

        for field in ['name', 'code', 'description', 'sort_order', 'is_active']:
            if field in data:
                setattr(item, field, data[field])

        try:
            self.crud.commit()
            return item.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise DictsServiceError(str(e), 500) from e

    def delete_dict_type(self, item):
        if is_enabled_for_delete(item):
            raise DictsServiceError(enabled_delete_message('字典类型'), 409)
        if item.items.count() > 0:
            raise DictsServiceError('该字典下仍有字典项，请先清空后再删除', 400)
        try:
            self.crud.delete(item)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise DictsServiceError(str(e), 500) from e

    def list_dict_items(self, dict_type, search='', is_active=None):
        query = self.crud.list_items_by_type_id(dict_type.id)

        if search:
            query = query.filter(self.db.or_(
                self.DictItem.label.ilike(f'%{search}%'),
                self.DictItem.value.ilike(f'%{search}%'),
            ))
        if is_active is not None:
            query = query.filter(self.DictItem.is_active == is_active)

        items = query.order_by(self.DictItem.sort_order.asc(), self.DictItem.id.asc()).all()
        return {
            'items': [item.to_dict() for item in items],
            'total': len(items),
            'dict_type': dict_type.to_dict(include_items=False),
        }

    def create_dict_item(self, dict_type, data):
        label = normalize_string(data.get('label'))
        value = normalize_string(data.get('value'))

        if not label:
            raise DictsServiceError('字典标签不能为空', 400)
        if not value:
            raise DictsServiceError('字典值不能为空', 400)

        if self.crud.get_dict_item_by_type_value(dict_type.id, value):
            raise DictsServiceError('同一字典下字典值不能重复', 400)

        if data.get('is_default'):
            self.crud.clear_default_by_type_and_exclude_id(dict_type.id, exclude_id=-1)

        item = self.DictItem(
            dict_type_id=dict_type.id,
            label=label,
            value=value,
            color=data.get('color'),
            sort_order=data.get('sort_order', 0),
            is_default=data.get('is_default', False),
            is_active=data.get('is_active', True),
            description=data.get('description'),
        )
        try:
            self.crud.add(item)
            self.crud.commit()
            return item.to_dict(), 201
        except Exception as e:
            self.crud.rollback()
            raise DictsServiceError(str(e), 500) from e

    def export_dict_items(self, dict_type, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='csv')
        items = self.crud.list_items_by_type_id(dict_type.id).order_by(
            self.DictItem.sort_order.asc(),
            self.DictItem.id.asc(),
        ).all()

        headers = ['字典标签', '字典值', '标签颜色', '排序', '是否默认', '是否启用', '备注']
        rows = [[
            item.label,
            item.value,
            item.color or '',
            item.sort_order if item.sort_order is not None else 0,
            '是' if item.is_default else '否',
            '是' if item.is_active else '否',
            item.description or '',
        ] for item in items]

        try:
            return build_table_response(headers, rows, f'dict_{dict_type.code}_items', file_type=file_type)
        except RuntimeError as e:
            raise DictsServiceError(str(e), 500) from e

    def download_dict_items_template(self, dict_type, file_type_raw):
        file_type = normalize_table_file_type(file_type_raw, default='csv')
        headers = ['字典标签', '字典值', '标签颜色', '排序', '是否默认', '是否启用', '备注']
        rows = [['示例标签', 'sample_value', '#1677ff', 0, '否', '是', '可选']]
        try:
            return build_table_response(headers, rows, f'dict_{dict_type.code}_import_template', file_type=file_type)
        except RuntimeError as e:
            raise DictsServiceError(str(e), 500) from e

    def import_dict_items(self, dict_type, file_storage):
        if not file_storage:
            raise DictsServiceError('请上传导入文件', 400)

        try:
            fieldnames, rows_with_line, _ = read_table_file(file_storage)
        except ValueError as e:
            raise DictsServiceError(str(e), 400) from e
        except RuntimeError as e:
            raise DictsServiceError(str(e), 500) from e

        if not fieldnames:
            raise DictsServiceError('导入内容为空', 400)

        header_map = {}
        for header in fieldnames:
            normalized = normalize_string(header)
            if normalized in CSV_HEADER_TO_FIELD:
                header_map[header] = CSV_HEADER_TO_FIELD[normalized]
            elif normalized in LEGACY_CSV_HEADER_TO_FIELD:
                header_map[header] = LEGACY_CSV_HEADER_TO_FIELD[normalized]

        if 'label' not in header_map.values() or 'value' not in header_map.values():
            raise DictsServiceError('导入文件缺少必填列：字典标签、字典值', 400)

        created = 0
        updated = 0

        try:
            for line_number, row in rows_with_line:
                mapped_row = {}
                for key, val in row.items():
                    field = header_map.get(key)
                    if field:
                        mapped_row[field] = val

                label = normalize_string(mapped_row.get('label'))
                value = normalize_string(mapped_row.get('value'))
                if not label or not value:
                    raise DictsServiceError(f'第 {line_number} 行“字典标签/字典值”不能为空', 400)

                is_default = parse_bool(mapped_row.get('is_default'))
                is_active = parse_bool(mapped_row.get('is_active'))
                item = self.crud.get_dict_item_by_type_value(dict_type.id, value)

                if item:
                    item.label = label
                    item.color = normalize_string(mapped_row.get('color')) or None
                    item.sort_order = parse_int(mapped_row.get('sort_order'), default=item.sort_order or 0)
                    item.description = normalize_string(mapped_row.get('description')) or None
                    if is_default is not None:
                        item.is_default = is_default
                    if is_active is not None:
                        item.is_active = is_active
                    updated += 1
                else:
                    item = self.DictItem(
                        dict_type_id=dict_type.id,
                        label=label,
                        value=value,
                        color=normalize_string(mapped_row.get('color')) or None,
                        sort_order=parse_int(mapped_row.get('sort_order'), default=0),
                        is_default=is_default is True,
                        is_active=True if is_active is None else is_active,
                        description=normalize_string(mapped_row.get('description')) or None,
                    )
                    self.crud.add(item)
                    created += 1

                if item.is_default:
                    self.crud.clear_default_by_type_and_keep_value(dict_type.id, keep_value=item.value)

            self.crud.commit()
            return {
                'message': '导入成功',
                'created': created,
                'updated': updated,
            }
        except DictsServiceError:
            self.crud.rollback()
            raise
        except Exception as e:
            self.crud.rollback()
            raise DictsServiceError(str(e), 500) from e

    def get_dict_item(self, item):
        return item.to_dict()

    def update_dict_item(self, item, data):
        target_type_id = data.get('dict_type_id', item.dict_type_id)
        target_type = self.crud.get_dict_type(target_type_id)
        if not target_type:
            raise DictsServiceError('字典类型不存在', 404)

        target_value = normalize_string(data.get('value', item.value))
        if not target_value:
            raise DictsServiceError('字典值不能为空', 400)

        duplicate = self.crud.get_item_duplicate(target_type_id, target_value, item.id)
        if duplicate:
            raise DictsServiceError('同一字典下字典值不能重复', 400)

        if 'label' in data and not normalize_string(data.get('label')):
            raise DictsServiceError('字典标签不能为空', 400)

        if data.get('is_default'):
            self.crud.clear_default_by_type_and_exclude_id(target_type_id, exclude_id=item.id)

        for field in ['dict_type_id', 'label', 'value', 'color', 'sort_order', 'is_default', 'is_active', 'description']:
            if field in data:
                setattr(item, field, data[field])

        try:
            self.crud.commit()
            return item.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise DictsServiceError(str(e), 500) from e

    def delete_dict_item(self, item):
        if is_enabled_for_delete(item):
            raise DictsServiceError(enabled_delete_message('字典项'), 409)
        try:
            self.crud.delete(item)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise DictsServiceError(str(e), 500) from e
