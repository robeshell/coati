# -*- coding: utf-8 -*-
"""RBAC 权限判定纯函数

参数为已预加载 roles/menus 的 Admin 实例（见 common/auth.py 的 joinedload）。
将权限判定逻辑从 model 层剥离到这里，保持 model 只放数据结构 + to_dict。
"""


def is_super_admin(user):
    return any(role.code == 'super_admin' for role in (user.roles or []))


def user_has_menu_code(user, menu_code):
    """用户（或其任一角色）是否拥有指定菜单/按钮 code 权限"""
    if is_super_admin(user):
        return True
    for role in (user.roles or []):
        for menu in (role.menus or []):
            if menu.code == menu_code:
                return True
    return False


def user_has_menu_access(user, menu_id):
    """用户是否拥有指定菜单 id 的访问权限"""
    if is_super_admin(user):
        return True
    for role in (user.roles or []):
        for menu in (role.menus or []):
            if menu.id == menu_id:
                return True
    return False


def collect_menu_ids(user):
    ids = set()
    for role in (user.roles or []):
        for menu in (role.menus or []):
            ids.add(menu.id)
    return list(ids)


def collect_menu_codes(user):
    codes = set()
    for role in (user.roles or []):
        for menu in (role.menus or []):
            codes.add(menu.code)
    return list(codes)
