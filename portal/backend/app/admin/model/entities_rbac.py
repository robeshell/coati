# -*- coding: utf-8 -*-
"""RBAC 模型定义"""

from datetime import datetime
from werkzeug.security import check_password_hash, generate_password_hash

from backend.common.rbac import collect_menu_codes


def build_rbac_models(db):
    user_roles = db.Table(
        'user_roles',
        db.Column('user_id', db.Integer, db.ForeignKey('admin_users.id', ondelete='CASCADE'), primary_key=True),
        db.Column('role_id', db.Integer, db.ForeignKey('roles.id', ondelete='CASCADE'), primary_key=True),
    )

    role_menus = db.Table(
        'role_menus',
        db.Column('role_id', db.Integer, db.ForeignKey('roles.id', ondelete='CASCADE'), primary_key=True),
        db.Column('menu_id', db.Integer, db.ForeignKey('menus.id', ondelete='CASCADE'), primary_key=True),
    )

    class Role(db.Model):
        __tablename__ = 'roles'

        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(100), nullable=False)
        code = db.Column(db.String(50), nullable=False, unique=True)
        description = db.Column(db.Text)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

        menus = db.relationship('Menu', secondary='role_menus', backref=db.backref('roles', lazy='dynamic'))

        def to_dict(self, include_menus=False):
            result = {
                'id': self.id,
                'name': self.name,
                'code': self.code,
                'description': self.description,
                'created_at': self.created_at.isoformat() if self.created_at else None,
            }
            if include_menus:
                sorted_menus = sorted(self.menus, key=lambda m: (m.sort_order or 0, m.id))
                result['menu_ids'] = [m.id for m in sorted_menus]
                result['menus'] = [{
                    'id': m.id,
                    'name': m.name,
                    'code': m.code,
                    'parent_id': m.parent_id,
                    'menu_type': m.menu_type,
                } for m in sorted_menus]
            return result

    class Admin(db.Model):
        __tablename__ = 'admin_users'

        id = db.Column(db.Integer, primary_key=True)
        username = db.Column(db.String(50), unique=True, nullable=False)
        password_hash = db.Column(db.String(200), nullable=False)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

        roles = db.relationship('Role', secondary=user_roles, backref=db.backref('users', lazy='dynamic'))

        def set_password(self, password):
            self.password_hash = generate_password_hash(password, method='pbkdf2:sha256')

        def check_password(self, password):
            return check_password_hash(self.password_hash, password)

        def to_dict(self):
            return {
                'id': self.id,
                'username': self.username,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'roles': [r.to_dict() for r in self.roles],
                'menu_codes': collect_menu_codes(self),
            }

    class Menu(db.Model):
        __tablename__ = 'menus'

        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(100), nullable=False)
        code = db.Column(db.String(50), nullable=False, unique=True)
        icon = db.Column(db.String(100))
        path = db.Column(db.String(200))
        component = db.Column(db.String(200))
        parent_id = db.Column(db.Integer, db.ForeignKey('menus.id', ondelete='CASCADE'))
        sort_order = db.Column(db.Integer, default=0)
        is_visible = db.Column(db.Boolean, default=True)
        is_active = db.Column(db.Boolean, default=True)
        menu_type = db.Column(db.String(20), default='menu')
        description = db.Column(db.Text)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

        children = db.relationship(
            'Menu',
            backref=db.backref('parent', remote_side=[id]),
            cascade='all, delete-orphan',
            lazy='dynamic',
        )

        def to_dict(self, include_children=False):
            data = {
                'id': self.id,
                'name': self.name,
                'code': self.code,
                'icon': self.icon,
                'path': self.path,
                'component': self.component,
                'parent_id': self.parent_id,
                'sort_order': self.sort_order,
                'is_visible': self.is_visible,
                'is_active': self.is_active,
                'menu_type': self.menu_type,
                'description': self.description,
                'created_at': self.created_at.isoformat() if self.created_at else None,
                'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            }
            if include_children:
                data['children'] = [child.to_dict(True) for child in self.children.order_by('sort_order')]
            return data

    return {
        'Admin': Admin,
        'Role': Role,
        'Menu': Menu,
        'user_roles': user_roles,
        'role_menus': role_menus,
    }
