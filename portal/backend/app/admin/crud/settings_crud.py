# -*- coding: utf-8 -*-
"""系统设置 CRUD 层"""


class SettingsCRUD:
    def __init__(self, db, app_setting_model):
        self.db = db
        self.AppSetting = app_setting_model

    def get_by_key(self, key):
        return self.AppSetting.query.filter_by(key=key).first()

    def list_all(self):
        return self.AppSetting.query.all()

    def upsert(self, key, value, description=None):
        row = self.get_by_key(key)
        if row is None:
            row = self.AppSetting(key=key, value=value, description=description)
            self.db.session.add(row)
        else:
            row.value = value
            if description is not None:
                row.description = description
        self.db.session.flush()
        return row
