# -*- coding: utf-8 -*-
"""
TODO: 替换 <Resource> 为模型类名
TODO: 替换 <resource> 为资源名（下划线）
"""

from backend.app.<domain>.crud.<resource> import <Resource>CRUD

# TODO: 按实际字段调整（用于导出列头 & 导入列头映射）
EXPORT_FIELD_MAP = {
    'id': 'ID',
    'name': '名称',
    # TODO: 补充其他字段，如 'status': '状态'
    'created_at': '创建时间',
}

IMPORT_HEADER_MAP = {
    '名称': 'name',
    # TODO: 补充其他可导入字段
}


class <Resource>ServiceError(Exception):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class <Resource>Service:
    def __init__(self, db, model):
        self.db = db
        self.crud = <Resource>CRUD(db, model)

    # ── 列表 ──────────────────────────────────────────────────────────────────

    def list_items(self, page=1, per_page=20, search=''):
        query = self.crud.query_all()
        if search:
            query = query.filter(self.crud.<Resource>.name.ilike(f'%{search}%'))
        pagination = query.order_by(self.crud.<Resource>.id.desc()).paginate(
            page=page, per_page=per_page, error_out=False
        )
        return {
            'items': [item.to_dict() for item in pagination.items],
            'total': pagination.total,
        }

    # ── 新增 ──────────────────────────────────────────────────────────────────

    def create_item(self, data):
        if not data.get('name'):
            raise <Resource>ServiceError('名称不能为空', 400)
        # TODO: 补充唯一性校验（如需要）
        item = self.crud.<Resource>(
            name=data['name'],
            # TODO: 补充其他字段
        )
        try:
            self.crud.add(item)
            self.crud.commit()
            return item.to_dict(), 201
        except Exception as e:
            self.crud.rollback()
            raise <Resource>ServiceError(str(e), 500) from e

    # ── 编辑 ──────────────────────────────────────────────────────────────────

    def update_item(self, item, data):
        # TODO: 补充可更新字段
        if 'name' in data:
            item.name = data['name']
        try:
            self.crud.commit()
            return item.to_dict()
        except Exception as e:
            self.crud.rollback()
            raise <Resource>ServiceError(str(e), 500) from e

    # ── 删除 ──────────────────────────────────────────────────────────────────

    def delete_item(self, item):
        try:
            self.crud.delete(item)
            self.crud.commit()
            return {'message': '删除成功'}
        except Exception as e:
            self.crud.rollback()
            raise <Resource>ServiceError(str(e), 500) from e

    # ── 导出 ──────────────────────────────────────────────────────────────────

    def export_items(self, data):
        from backend.common.tabular import build_table_response, normalize_table_file_type
        file_type = normalize_table_file_type(data.get('file_type'), default='xlsx')
        fields = data.get('fields') or list(EXPORT_FIELD_MAP.keys())
        ids = data.get('ids')

        query = self.crud.query_all()
        if ids:
            query = query.filter(self.crud.<Resource>.id.in_(ids))
        items = query.order_by(self.crud.<Resource>.id.desc()).all()

        headers = [EXPORT_FIELD_MAP.get(f, f) for f in fields]
        rows = [[item.to_dict().get(f, '') for f in fields] for item in items]
        return build_table_response(headers, rows, '<resource>_export', file_type=file_type)

    # ── 下载导入模板 ──────────────────────────────────────────────────────────

    def download_template(self, file_type_raw='xlsx'):
        from backend.common.tabular import build_table_response, normalize_table_file_type
        file_type = normalize_table_file_type(file_type_raw, default='xlsx')
        headers = list(IMPORT_HEADER_MAP.keys())
        return build_table_response(headers, [], '<resource>_import_template', file_type=file_type)

    # ── 导入 ──────────────────────────────────────────────────────────────────

    def import_items(self, file_storage):
        from backend.common.tabular import read_table_file
        try:
            _, rows, _ = read_table_file(file_storage)
        except ValueError as e:
            raise <Resource>ServiceError(str(e), 400) from e

        created = 0
        error_rows = []
        for line, row in rows:
            try:
                name = row.get(IMPORT_HEADER_MAP.get('名称', ''), '').strip()
                if not name:
                    error_rows.append({'line': line, 'reason': '名称不能为空', 'row': row})
                    continue
                # TODO: 补充其他字段赋值
                item = self.crud.<Resource>(name=name)
                self.crud.add(item)
                created += 1
            except Exception as e:
                error_rows.append({'line': line, 'reason': str(e), 'row': row})

        if created:
            try:
                self.crud.commit()
            except Exception as e:
                self.crud.rollback()
                raise <Resource>ServiceError(str(e), 500) from e

        if error_rows:
            raise <Resource>ServiceError('部分数据导入失败', 400, {'error_rows': error_rows})
        return {'created': created, 'updated': 0}
