# -*- coding: utf-8 -*-
"""上游凭证的应用层加密。"""

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken
from flask import current_app


ENCRYPTED_PREFIX = 'enc:v1:'


class AgentCredentialCryptoError(RuntimeError):
    pass


def _fernet():
    material = str(current_app.config.get('AGENT_CREDENTIAL_ENCRYPTION_KEY') or '').strip()
    if not material:
        raise AgentCredentialCryptoError('未配置上游凭证加密密钥')
    derived = base64.urlsafe_b64encode(hashlib.sha256(material.encode('utf-8')).digest())
    return Fernet(derived)


def encrypt_secret(raw_value, empty_message='凭证不能为空'):
    raw = str(raw_value or '').strip()
    if not raw:
        raise AgentCredentialCryptoError(empty_message)
    if raw.startswith(ENCRYPTED_PREFIX):
        return raw
    token = _fernet().encrypt(raw.encode('utf-8')).decode('ascii')
    return f'{ENCRYPTED_PREFIX}{token}'


def decrypt_secret(stored_value):
    stored = str(stored_value or '')
    if not stored.startswith(ENCRYPTED_PREFIX):
        return stored
    try:
        return _fernet().decrypt(stored[len(ENCRYPTED_PREFIX):].encode('ascii')).decode('utf-8')
    except (InvalidToken, ValueError, UnicodeDecodeError) as exc:
        raise AgentCredentialCryptoError('上游凭证无法解密，请检查 AGENT_CREDENTIAL_ENCRYPTION_KEY') from exc


def encrypt_api_key(raw_value):
    return encrypt_secret(raw_value, 'API Key 不能为空')


def decrypt_api_key(stored_value):
    return decrypt_secret(stored_value)


def api_key_fingerprint(raw_value):
    return hashlib.sha256(str(raw_value or '').encode('utf-8')).hexdigest()


def api_key_hint(raw_value):
    raw = str(raw_value or '')
    if len(raw) <= 8:
        return '****'
    return f'{raw[:4]}…{raw[-4:]}'


__all__ = [
    'AgentCredentialCryptoError', 'ENCRYPTED_PREFIX', 'api_key_fingerprint',
    'api_key_hint', 'decrypt_api_key', 'decrypt_secret', 'encrypt_api_key', 'encrypt_secret',
]
