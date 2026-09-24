"""PAT 编辑业务规则测试。"""

from datetime import datetime, timedelta

import pytest

from backend.app.agent.service.auth_service import AgentAuthError, AgentAuthService


class FakePat:
    def __init__(self, *, token_type='personal', expires_at=None, revoked_at=None):
        self.token_type = token_type
        self.expires_at = expires_at
        self.revoked_at = revoked_at
        self.name = 'old-name'

    def to_dict(self):
        return {
            'name': self.name,
            'expires_at': self.expires_at,
            'token_type': self.token_type,
        }


class FakeCrud:
    def __init__(self, row):
        self.row = row
        self.db = None
        self.models = {}
        self.commits = 0

    def get_pat_for_user(self, pat_id, user_id):
        return self.row if pat_id == 1 and user_id == 2 else None

    def commit(self):
        self.commits += 1


def make_service(row):
    service = AgentAuthService.__new__(AgentAuthService)
    service.crud = FakeCrud(row)
    return service


def test_update_pat_changes_name_and_recomputes_expiry_without_touching_secret():
    row = FakePat(expires_at=datetime.utcnow() + timedelta(days=90))
    service = make_service(row)

    result = service.update_pat(2, 1, name='Cursor', expires_days=30)

    assert result['name'] == 'Cursor'
    assert row.name == 'Cursor'
    assert timedelta(days=29) < row.expires_at - datetime.utcnow() <= timedelta(days=30)
    assert service.crud.commits == 1


@pytest.mark.parametrize('row', [
    FakePat(token_type='device'),
    FakePat(expires_at=datetime.utcnow() - timedelta(seconds=1)),
    FakePat(revoked_at=datetime.utcnow()),
])
def test_update_pat_does_not_reactivate_non_editable_tokens(row):
    service = make_service(row)

    with pytest.raises(AgentAuthError, match='只能编辑'):
        service.update_pat(2, 1, name='Cursor', expires_days=None)

    assert row.name == 'old-name'
    assert service.crud.commits == 0
