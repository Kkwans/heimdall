from __future__ import annotations

import pytest

import crypto


def test_legacy_plaintext_is_explicitly_supported() -> None:
    assert crypto.decrypt("legacy-provider-key") == "legacy-provider-key"


def test_corrupted_fernet_value_fails_closed() -> None:
    with pytest.raises(crypto.SecretDecryptionError):
        crypto.decrypt("gAAAAAB-corrupted-token")


def test_encryption_failure_never_returns_plaintext(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_fernet():
        raise OSError("key unavailable")

    monkeypatch.setattr(crypto, "_get_fernet", fail_fernet)
    with pytest.raises(crypto.SecretEncryptionError):
        crypto.encrypt("must-not-be-written")
