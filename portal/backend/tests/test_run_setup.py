"""容器初始化脚本的安全启动模式测试。"""

from backend.scripts import run_setup_once


def test_container_setup_runs_rbac_in_incremental_mode(monkeypatch):
    calls = []

    class FakeRbac:
        @staticmethod
        def main(argv=None):
            calls.append(argv)

    monkeypatch.setattr(
        run_setup_once.importlib,
        'import_module',
        lambda name: FakeRbac if name == 'backend.scripts.init_rbac_data' else None,
    )

    run_setup_once._sync_rbac_incrementally()

    assert calls == [['--incremental']]
