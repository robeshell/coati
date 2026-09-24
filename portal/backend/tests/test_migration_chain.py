# -*- coding: utf-8 -*-
"""迁移链完整性检查验证（多 head 分叉拦截）"""

import pathlib
import sys

from backend.scripts import verify_feature


def _write_chain(root, specs):
    """specs: [(filename, revision, down_revision), ...]"""
    vdir = root / 'backend' / 'migrations' / 'versions'
    vdir.mkdir(parents=True, exist_ok=True)
    for fname, rev, down in specs:
        (vdir / fname).write_text(
            f"revision = '{rev}'\ndown_revision = {'None' if down is None else repr(down)}\n",
            encoding='utf-8',
        )


def test_linear_chain_passes(tmp_path):
    _write_chain(tmp_path, [
        ('a.py', 'a1', None),
        ('b.py', 'b1', 'a1'),
        ('c.py', 'c1', 'b1'),
    ])
    verify_feature.ROOT = tmp_path
    res = verify_feature.check_migration_chain()
    assert res['passed'] is True
    assert res['head'] == 'c1'


def test_forked_chain_fails(tmp_path):
    _write_chain(tmp_path, [
        ('a.py', 'a1', None),
        ('b.py', 'b1', 'a1'),
        ('c.py', 'c1', 'a1'),  # 分叉
    ])
    verify_feature.ROOT = tmp_path
    res = verify_feature.check_migration_chain()
    assert res['passed'] is False
    assert '多个 head' in res['error']


def test_orphan_down_revision_fails(tmp_path):
    _write_chain(tmp_path, [
        ('a.py', 'a1', None),
        ('b.py', 'b1', 'ghost'),  # 祖先不存在
    ])
    verify_feature.ROOT = tmp_path
    res = verify_feature.check_migration_chain()
    assert res['passed'] is False
    assert '未定义祖先' in res['error']
