# -*- coding: utf-8 -*-
"""Agent 网关、配额与设备登录关键安全边界回归测试。"""

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from flask import Flask
from flask_sqlalchemy import SQLAlchemy

from backend.app.agent.crud.auth import AgentAuthCRUD
from backend.app.agent.model import build_agent_models
from backend.app.agent.service.credential_service import AgentCredentialError, AgentCredentialService
from backend.app.agent.service.gateway_service import AgentGatewayService
from backend.app.agent.service.route_service import AgentRouteError, AgentRouteService
from backend.app.agent.service.usage_service import AgentUsageError, AgentUsageService


@pytest.fixture()
def agent_db():
    app = Flask(__name__)
    app.config.update(
        SQLALCHEMY_DATABASE_URI='sqlite://',
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        AGENT_DAILY_TOKEN_QUOTA=100,
        AGENT_TIMEZONE='Asia/Shanghai',
        AGENT_CREDENTIAL_ENCRYPTION_KEY='test-only-encryption-key',
    )
    db = SQLAlchemy(app)

    class Admin(db.Model):
        __tablename__ = 'admin_users'
        id = db.Column(db.Integer, primary_key=True)
        username = db.Column(db.String(100), nullable=False)

        def to_dict(self):
            return {'id': self.id, 'username': self.username}

    models = {'Admin': Admin, **build_agent_models(db)}
    with app.app_context():
        db.create_all()
        db.session.add(Admin(id=1, username='tester'))
        db.session.commit()
        yield app, db, models
        db.session.remove()


def _credential(credential_id, provider, base_url, model):
    return SimpleNamespace(
        id=credential_id,
        provider=provider,
        base_url=base_url,
        default_model=model,
        request_timeout_seconds=30,
    )


def test_route_fallback_keeps_each_credential_origin_and_effective_model():
    app = Flask(__name__)
    app.config['AGENT_GATEWAY_MAX_ATTEMPTS'] = 3
    primary = _credential(1, 'deepseek', 'https://api.deepseek.com', 'deepseek-v4-pro')
    fallback = _credential(2, 'deepseek', 'https://backup.deepseek.example', 'deepseek-v4-pro')
    route = SimpleNamespace(
        id=9, credential_id=1, fallback_enabled=True,
        upstream_model='deepseek-v4-pro', upstream_base='https://api.deepseek.com/v1',
    )
    calls = []

    class Credentials:
        def candidates(self, **kwargs):
            calls.append(kwargs)
            return [primary] if kwargs.get('credential_id') else [primary, fallback]

        @staticmethod
        def secret(row):
            return f'key-{row.id}'

    service = AgentGatewayService.__new__(AgentGatewayService)
    service.route_crud = SimpleNamespace(get_enabled_by_model=lambda _: route)
    service.credential_crud = SimpleNamespace(get=lambda _: primary)
    service.credentials = Credentials()
    with app.app_context():
        resolved = service.resolve_routes('coati-coding')

    assert resolved[0]['base'] == 'https://api.deepseek.com/v1'
    assert resolved[1]['base'] == 'https://backup.deepseek.example'
    assert all(item['model'] == 'deepseek-v4-pro' for item in resolved)
    assert calls[1]['preferred_model'] == 'deepseek-v4-pro'
    # 故障转移不再按厂商标签锁池；接口兼容性由 upstream_protocol 单独过滤。
    assert 'provider' not in calls[1]
    assert calls[1]['require_model_match'] is True


def test_saved_key_probe_rejects_target_override():
    row = SimpleNamespace(
        id=1, base_url='https://api.deepseek.com', provider='deepseek',
        request_timeout_seconds=30,
    )
    service = AgentCredentialService.__new__(AgentCredentialService)
    service.crud = SimpleNamespace(get=lambda _: row)
    with pytest.raises(AgentCredentialError, match='不能覆盖 Base URL'):
        service.discover_models({
            'credential_id': 1,
            'base_url': 'https://attacker.example',
        })


def test_create_automatically_probes_new_platform_credential(agent_db, monkeypatch):
    app, db, models = agent_db
    with app.app_context():
        service = AgentCredentialService(db, models)
        calls = []

        def fake_check(credential_id, *, allow_personal=False):
            calls.append((credential_id, allow_personal))
            return {
                'ok': True, 'verified': True, 'health_status': 'healthy',
                'latency_ms': 12, 'model_count': 1,
            }

        monkeypatch.setattr(service, 'check', fake_check)
        result = service.create({
            'name': 'auto-probed',
            'base_url': 'https://api.deepseek.com',
            'api_key': 'sk-auto-probe',
            'supported_models': ['deepseek-v4-flash'],
            'default_model': 'deepseek-v4-flash',
        })

        row = db.session.get(models['AgentLlmCredential'], result['id'])

    assert calls == [(result['id'], False)]
    assert result['health_probe']['attempted'] is True
    assert result['health_probe']['ok'] is True
    assert row is not None


def test_create_personal_keeps_credential_when_automatic_probe_fails(agent_db, monkeypatch):
    app, db, models = agent_db
    with app.app_context():
        service = AgentCredentialService(db, models)
        calls = []

        def fake_check(credential_id, *, allow_personal=False):
            calls.append((credential_id, allow_personal))
            raise AgentCredentialError('上游连接失败', 502)

        monkeypatch.setattr(service, 'check', fake_check)
        result = service.create_personal(1, {
            'name': 'my-auto-probed',
            'base_url': 'https://api.deepseek.com',
            'api_key': 'sk-auto-probe-personal',
            'model_prefix': 'mine',
            'supported_models': ['deepseek-v4-flash'],
            'default_model': 'deepseek-v4-flash',
        })

        row = db.session.get(models['AgentLlmCredential'], result['id'])

    assert calls == [(result['id'], True)]
    assert result['health_probe']['attempted'] is True
    assert result['health_probe']['ok'] is False
    assert result['health_probe']['message'] == '上游连接失败'
    assert row is not None
    assert row.scope == 'personal'


def test_check_does_not_replace_saved_models(monkeypatch):
    captured = {}
    row = SimpleNamespace(
        id=7, base_url='https://openrouter.ai/api/v1', provider='openai-compatible',
        request_timeout_seconds=30, models_json='["anthropic/claude-sonnet-4"]',
    )
    service = AgentCredentialService.__new__(AgentCredentialService)
    service.crud = SimpleNamespace(
        get=lambda _: row,
        mark_success=lambda *args, **kwargs: captured.setdefault('marked', True),
    )
    monkeypatch.setattr(AgentCredentialService, 'secret', staticmethod(lambda _row: 'sk-test'))
    monkeypatch.setattr(
        'backend.app.agent.service.credential_service.get_provider_adapter',
        lambda _code: SimpleNamespace(
            assert_available=lambda: None,
            discover_models=lambda **_kwargs: [f'model-{i}' for i in range(419)],
        ),
    )
    result = service.check(7)
    assert result['model_count'] == 419
    assert result['ok'] is True
    assert 'models' not in result
    assert row.models_json == '["anthropic/claude-sonnet-4"]'
    assert captured.get('marked') is True


def test_discover_models_returns_catalog_without_writing_row(monkeypatch):
    row = SimpleNamespace(
        id=7, base_url='https://openrouter.ai/api/v1', provider='openai-compatible',
        request_timeout_seconds=30, models_json='["keep-me"]',
    )
    service = AgentCredentialService.__new__(AgentCredentialService)
    service.crud = SimpleNamespace(
        get=lambda _: row,
        mark_success=lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('不应更新健康状态')),
    )
    monkeypatch.setattr(AgentCredentialService, 'secret', staticmethod(lambda _row: 'sk-test'))
    catalog = [f'model-{i}' for i in range(419)]
    monkeypatch.setattr(
        'backend.app.agent.service.credential_service.get_provider_adapter',
        lambda _code: SimpleNamespace(
            assert_available=lambda: None,
            discover_models=lambda **_kwargs: catalog,
        ),
    )
    result = service.discover_models({'credential_id': 7})
    assert result['model_count'] == 419
    assert result['models'] == catalog
    assert row.models_json == '["keep-me"]'


def test_saved_key_discovery_uses_current_form_headers(monkeypatch):
    captured = {}
    row = SimpleNamespace(
        id=7, base_url='https://relay.example/v1', provider='openai-compatible',
        request_timeout_seconds=30, models_json='["keep-me"]',
        extra_headers=lambda: {'X-Old': 'old'},
    )
    service = AgentCredentialService.__new__(AgentCredentialService)
    service.crud = SimpleNamespace(get=lambda _: row)
    monkeypatch.setattr(AgentCredentialService, 'secret', staticmethod(lambda _row: 'sk-test'))
    monkeypatch.setattr(
        'backend.app.agent.service.credential_service.get_provider_adapter',
        lambda _code: SimpleNamespace(
            assert_available=lambda: None,
            discover_models=lambda **kwargs: captured.update(kwargs) or ['model-a'],
        ),
    )

    result = service.discover_models({
        'credential_id': 7,
        'extra_headers': {'User-Agent': 'claude-cli/2.1.161', 'X-Provider': 'cc-switch'},
    })

    assert result['models'] == ['model-a']
    assert captured['extra_headers'] == {
        'User-Agent': 'claude-cli/2.1.161', 'X-Provider': 'cc-switch',
    }


def test_strict_model_match_never_falls_back_to_another_provider():
    deepseek = SimpleNamespace(
        id=1, provider='deepseek', cooldown_until=None, priority=100, weight=100,
        supported_models=lambda: ['deepseek-v4-pro'],
    )
    service = AgentCredentialService.__new__(AgentCredentialService)
    service.crud = SimpleNamespace(enabled_items=lambda: [deepseek])
    service._env_fallback = lambda: None
    with pytest.raises(AgentCredentialError, match='没有支持模型 gpt-5'):
        service.candidates(preferred_model='gpt-5', require_model_match=True)


def test_route_override_cannot_change_credential_origin():
    credential = SimpleNamespace(base_url='https://api.deepseek.com/v1')
    with pytest.raises(AgentRouteError, match='切换域名请修改 Key 配置'):
        AgentRouteService._validate_overrides(
            {'credential_id': 1, 'upstream_base': 'https://attacker.example/v1'},
            credential=credential,
        )
    AgentRouteService._validate_overrides(
        {'credential_id': 1, 'upstream_base': 'https://api.deepseek.com/proxy/v1'},
        credential=credential,
    )


def test_quota_reservation_is_settled_into_same_usage_event(agent_db):
    app, _db, models = agent_db
    with app.app_context():
        service = AgentUsageService(_db, models)
        first = service.reserve_quota(
            1, 'req_first',
            {'messages': [{'role': 'user', 'content': 'hello'}], 'max_tokens': 90},
            'coati-coding',
        )
        assert first['reserved'] <= 100
        with pytest.raises(AgentUsageError, match='剩余配额'):
            service.reserve_quota(
                1, 'req_second',
                {'messages': [{'role': 'user', 'content': 'hello'}], 'max_tokens': 10},
                'coati-coding',
            )

        service.record(
            1, request_id='req_first', model='coati-coding',
            prompt_tokens=5, completion_tokens=10, status='ok', source='gateway',
        )
        row = models['AgentUsageEvent'].query.filter_by(request_id='req_first').one()
        assert row.status == 'ok'
        assert row.total_tokens == 15
        assert models['AgentUsageEvent'].query.count() == 1
        assert service.tokens_today(1) == 15


def test_device_code_can_issue_only_one_pat(agent_db):
    app, db, models = agent_db
    with app.app_context():
        now = datetime.utcnow()
        device = models['AgentDeviceCode'](
            device_code='device-one', user_code='ABCD-EFGH', user_id=1,
            status='confirmed', expires_at=now + timedelta(minutes=5), interval_seconds=5,
        )
        db.session.add(device)
        db.session.commit()
        crud = AgentAuthCRUD(db, models)

        def pat(suffix):
            return models['AgentPat'](
                user_id=1, name=f'device-{suffix}', token_type='device', scopes_json='["chat"]',
                token_prefix=f'coati_{suffix}', token_hash=f'hash-{suffix}',
            )

        assert crud.issue_device_pat(pat('one'), device, now=now, digest='hash-one', prefix='coati_one') is True
        assert crud.issue_device_pat(pat('two'), device, now=now, digest='hash-two', prefix='coati_two') is False
        assert models['AgentPat'].query.count() == 1


def test_device_code_can_be_confirmed_by_only_one_user(agent_db):
    app, db, models = agent_db
    with app.app_context():
        now = datetime.utcnow()
        device = models['AgentDeviceCode'](
            device_code='confirm-once', user_code='CONF-ONCE', status='pending',
            expires_at=now + timedelta(minutes=5), interval_seconds=5,
        )
        db.session.add(device)
        db.session.commit()
        crud = AgentAuthCRUD(db, models)
        assert crud.confirm_device(device, user_id=1, now=now) is True
        assert crud.confirm_device(device, user_id=999, now=now) is False
        assert device.user_id == 1


def test_credential_failure_count_is_atomic_and_old_success_cannot_clear_it(agent_db):
    app, db, models = agent_db
    with app.app_context():
        row = models['AgentLlmCredential'](
            name='DeepSeek', provider='deepseek', base_url='https://api.deepseek.com',
            api_key='encrypted', api_key_hint='sk…test', key_fingerprint='fingerprint',
            models_json='["deepseek-v4-pro"]', tags_json='[]',
            default_model='deepseek-v4-pro', priority=100, weight=100,
            request_timeout_seconds=30, enabled=True,
        )
        db.session.add(row)
        db.session.commit()
        service = AgentCredentialService(db, models)
        observed_at = datetime.utcnow()
        service.mark_failure(row, 'first', observed_at=observed_at)
        service.mark_failure(row, 'second', observed_at=observed_at)
        assert row.consecutive_failures == 2
        service.mark_success(row, observed_at=observed_at - timedelta(seconds=1))
        assert row.consecutive_failures == 2
        assert row.health_status == 'unhealthy'


def test_device_start_has_database_backed_rate_limit(agent_db):
    app, db, models = agent_db
    with app.app_context():
        crud = AgentAuthCRUD(db, models)
        now = datetime.utcnow()

        def code(suffix):
            return models['AgentDeviceCode'](
                device_code=f'device-{suffix}', user_code=f'CODE-{suffix}', status='pending',
                expires_at=now + timedelta(minutes=5), interval_seconds=5,
            )

        assert crud.create_device_code(
            code('one'), now=now, per_minute=1, max_active=10, retention_hours=24,
        ) == 'created'
        assert crud.create_device_code(
            code('two'), now=now, per_minute=1, max_active=10, retention_hours=24,
        ) == 'rate_limited'
        assert models['AgentDeviceCode'].query.count() == 1


def test_list_mine_and_export_only_include_current_user(agent_db):
    app, db, models = agent_db
    with app.app_context():
        db.session.add(models['Admin'](id=2, username='other'))
        credential = models['AgentLlmCredential'](
            name='company-secret-account', provider='deepseek',
            base_url='https://api.example.com', api_key='encrypted',
            api_key_hint='sk…test', key_fingerprint='test-fingerprint',
            models_json='["deepseek-chat"]', tags_json='[]',
            default_model='deepseek-chat',
        )
        db.session.add(credential)
        db.session.commit()
        route = models['AgentRouteConfig'](
            model_name='coati-auto', upstream_model='deepseek-chat',
            credential_id=credential.id,
        )
        db.session.add(route)
        db.session.commit()
        service = AgentUsageService(db, models)
        service.record(
            1, request_id='req-mine', model='coati-auto', upstream_model='deepseek-chat',
            route_id=route.id, credential_id=credential.id,
            client_request_id='sess-123:compaction:2:3:0',
            prompt_tokens=3, completion_tokens=5, status='ok',
        )
        service.record(2, request_id='req-other', model='coati-auto', prompt_tokens=9, completion_tokens=11, status='ok')
        mine = service.list_mine(1)
        assert [item['request_id'] for item in mine['items']] == ['req-mine']
        assert mine['total'] == 1
        assert not {
            'user_id', 'upstream_model', 'route_id', 'credential_id', 'pat_id',
            'credential_name', 'provider', 'route_name',
        }.intersection(mine['items'][0])
        admin_items = service.list_admin(1)['items']
        admin_item = next(item for item in admin_items if item['request_id'] == 'req-mine')
        assert admin_item['credential_name'] == 'company-secret-account'
        assert admin_item['request_purpose'] == {'code': 'compaction', 'label': '上下文压缩'}
        assert mine['items'][0]['request_purpose'] == {'code': 'compaction', 'label': '上下文压缩'}
        response = service.export_mine(1, {
            'fields': ['request_id', 'upstream_model'],
            'file_type': 'csv',
            'export_mode': 'filtered',
            'filters': {'days': 7},
        })
        body = response.get_data(as_text=True)
        assert 'req-mine' in body
        assert 'req-other' not in body
        assert '实际上游模型' not in body


def test_list_mine_can_filter_by_own_pat(agent_db):
    from backend.app.agent.service.bearer import hash_token

    app, db, models = agent_db
    with app.app_context():
        cursor = models['AgentPat'](
            user_id=1, name='cursor', token_type='personal',
            token_prefix='coati_cur', token_hash=hash_token('cursor-key'),
        )
        cli = models['AgentPat'](
            user_id=1, name='cli', token_type='device',
            token_prefix='coati_cli', token_hash=hash_token('cli-key'),
        )
        db.session.add_all([cursor, cli])
        db.session.commit()
        service = AgentUsageService(db, models)
        service.record(
            1, request_id='req-cursor', model='coati-auto',
            prompt_tokens=1, completion_tokens=1, status='ok', pat_id=cursor.id,
        )
        service.record(
            1, request_id='req-cli', model='coati-auto',
            prompt_tokens=2, completion_tokens=2, status='ok', pat_id=cli.id,
        )
        listed = service.list_mine(1, pat_id=cursor.id)
        assert [item['request_id'] for item in listed['items']] == ['req-cursor']
        assert listed['items'][0]['pat_name'] == 'cursor'
        analytics = service.analytics_mine(1, pat_id=cursor.id)
        assert analytics['summary']['requests'] == 1
        labels = {item['value']: item['label'] for item in analytics['filter_options']['pats']}
        assert labels[cursor.id] == 'cursor'
        assert labels[cli.id] == 'cli · 设备'
        body = service.export_mine(1, {
            'fields': ['request_id'],
            'file_type': 'csv',
            'export_mode': 'filtered',
            'filters': {'days': 7, 'pat_id': cursor.id},
        }).get_data(as_text=True)
        assert 'req-cursor' in body
        assert 'req-cli' not in body


def test_summary_tokens_exclude_non_billable_status(agent_db):
    app, db, models = agent_db
    with app.app_context():
        service = AgentUsageService(db, models)
        service.record(
            1, request_id='req-ok', model='coati-auto',
            prompt_tokens=10, completion_tokens=5, status='ok',
        )
        service.record(
            1, request_id='req-quota', model='coati-auto',
            prompt_tokens=100, completion_tokens=50, status='quota_exceeded',
        )
        summary = service.analytics_mine(1, days=7)['summary']
        assert summary['requests'] == 2
        assert summary['tokens'] == 15


def test_top_users_tokens_exclude_non_billable_status(agent_db):
    app, db, models = agent_db
    with app.app_context():
        db.session.add(models['Admin'](id=2, username='other'))
        db.session.commit()
        service = AgentUsageService(db, models)
        service.record(
            1, request_id='req-u1-ok', model='coati-auto',
            prompt_tokens=10, completion_tokens=5, status='ok',
        )
        service.record(
            1, request_id='req-u1-quota', model='coati-auto',
            prompt_tokens=100, completion_tokens=50, status='quota_exceeded',
        )
        service.record(
            2, request_id='req-u2-ok', model='coati-auto',
            prompt_tokens=3, completion_tokens=2, status='ok',
        )
        users = service.analytics(days=7)['users']
        assert users[0]['username'] == 'tester'
        assert users[0]['tokens'] == 15
        assert users[0]['requests'] == 2


def test_model_breakdown_counts_requests_and_billable_tokens(agent_db):
    app, db, models = agent_db
    with app.app_context():
        service = AgentUsageService(db, models)
        service.record(
            1, request_id='req-m1-ok', model='coati-large',
            prompt_tokens=10, completion_tokens=5, status='ok',
        )
        service.record(
            1, request_id='req-m1-quota', model='coati-large',
            prompt_tokens=100, completion_tokens=50, status='quota_exceeded',
        )
        service.record(
            1, request_id='req-m2-ok', model='coati-small',
            prompt_tokens=3, completion_tokens=2, status='ok',
        )

        breakdown = service.analytics(days=7)['models']
        # 占比分母是全部模型的计费 Token 合计，非计费状态只进请求数。
        assert breakdown['tokens'] == 20
        assert [item['model'] for item in breakdown['items']] == ['coati-large', 'coati-small']
        assert breakdown['items'][0]['requests'] == 2
        assert breakdown['items'][0]['tokens'] == 15
        assert breakdown['items'][0]['share_percent'] == 75.0
        assert breakdown['items'][1]['share_percent'] == 25.0


def test_model_filter_narrows_stats_but_keeps_breakdown_selectable(agent_db):
    app, db, models = agent_db
    with app.app_context():
        service = AgentUsageService(db, models)
        service.record(
            1, request_id='req-scope-large', model='coati-large',
            prompt_tokens=10, completion_tokens=5, status='ok',
        )
        service.record(
            1, request_id='req-scope-small', model='coati-small',
            prompt_tokens=3, completion_tokens=2, status='ok',
        )

        scoped = service.analytics(days=7, model='coati-small')
        assert scoped['summary']['requests'] == 1
        assert scoped['summary']['tokens'] == 5
        # 模型分布作为下钻入口，必须仍能看到全量模型，否则无法横向切换。
        assert [item['model'] for item in scoped['models']['items']] == ['coati-large', 'coati-small']
        assert {item['value'] for item in scoped['filter_options']['models']} == {'coati-large', 'coati-small'}


def test_personal_model_breakdown_stays_within_own_requests(agent_db):
    app, db, models = agent_db
    with app.app_context():
        db.session.add(models['Admin'](id=2, username='other'))
        db.session.commit()
        service = AgentUsageService(db, models)
        service.record(
            1, request_id='req-mine-a', model='mine-model-a',
            prompt_tokens=10, completion_tokens=5, status='ok',
        )
        service.record(
            1, request_id='req-mine-b', model='mine-model-b',
            prompt_tokens=1, completion_tokens=1, status='ok',
        )
        service.record(
            2, request_id='req-other', model='other-model',
            prompt_tokens=100, completion_tokens=50, status='ok',
        )

        mine = service.analytics_mine(1, days=7)
        assert [item['model'] for item in mine['models']['items']] == ['mine-model-a', 'mine-model-b']
        assert mine['models']['tokens'] == 17
        # 个人视角的可选模型也只能是自己用过的，避免泄露他人的模型名。
        assert {item['value'] for item in mine['filter_options']['models']} == {'mine-model-a', 'mine-model-b'}
        assert service.list_mine(1, model='mine-model-a')['total'] == 1


def test_route_usage_stats_tokens_exclude_non_billable_status(agent_db):
    app, db, models = agent_db
    with app.app_context():
        from backend.app.agent.crud.route import AgentRouteCRUD
        from backend.app.agent.service.usage_service import AgentUsageService

        route = models['AgentRouteConfig'](
            model_name='coati-test-route',
            upstream_model='deepseek-chat',
            credential_id=None,
            enabled=True,
        )
        db.session.add(route)
        db.session.commit()

        service = AgentUsageService(db, models)
        service.record(
            1, request_id='req-route-ok', model='coati-test-route',
            prompt_tokens=8, completion_tokens=4, status='ok',
        )
        service.record(
            1, request_id='req-route-fail', model='coati-test-route',
            prompt_tokens=50, completion_tokens=25, status='upstream_error',
        )

        stats = AgentRouteCRUD(db, models).usage_stats([route], days=7)
        usage = stats['coati-test-route']
        assert usage['requests'] == 2
        assert usage['tokens'] == 12
