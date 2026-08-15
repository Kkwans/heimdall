import sqlite3
from pathlib import Path

import pytest
from flask import Flask

import auth
import config
import crypto
import db
import router
from admin_api import admin_bp


def _close_thread_connection() -> None:
    connection = getattr(db._local, "conn", None)
    if connection is not None:
        connection.close()
    db._local.conn = None


@pytest.fixture
def admin_app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _close_thread_connection()
    database = tmp_path / "heimdall.db"
    key_file = tmp_path / ".encryption_key"
    monkeypatch.setattr(config, "DB_PATH", str(database))
    monkeypatch.setattr(crypto, "_KEY_FILE", str(key_file))
    monkeypatch.setattr(crypto, "_fernet", None)

    db.init_db()
    router.init_routing_tables()
    auth.init_auth_tables()

    app = Flask(__name__)
    app.register_blueprint(admin_bp)
    app.config.update(TESTING=True)
    yield app, database

    _close_thread_connection()
    crypto._fernet = None


def _provider_payload(name: str = "phase2-provider") -> dict:
    return {
        "name": name,
        "display_name": "Phase 2 Provider",
        "openai_url": "https://provider.example/v1",
        "anthropic_url": "",
        "api_key": "provider-secret-value-1234",
    }


def test_provider_creation_is_atomic_and_creates_first_key(admin_app) -> None:
    app, database = admin_app
    client = app.test_client()

    response = client.post("/api/providers", json=_provider_payload())

    assert response.status_code == 201
    provider_id = response.get_json()["id"]
    with sqlite3.connect(database) as connection:
        provider = connection.execute(
            "SELECT api_key FROM providers WHERE id = ?", (provider_id,)
        ).fetchone()
        provider_key = connection.execute(
            "SELECT api_key FROM provider_api_keys WHERE provider_id = ?", (provider_id,)
        ).fetchone()
    assert provider is not None
    assert provider_key is not None
    assert provider[0] == provider_key[0]
    assert provider[0] != _provider_payload()["api_key"]


def test_provider_api_key_update_keeps_runtime_key_in_sync(admin_app) -> None:
    app, database = admin_app
    client = app.test_client()
    provider_id = client.post("/api/providers", json=_provider_payload()).get_json()["id"]

    with sqlite3.connect(database) as connection:
        key_id = connection.execute(
            "SELECT id FROM provider_api_keys WHERE provider_id = ?",
            (provider_id,),
        ).fetchone()[0]
        connection.execute(
            "UPDATE provider_api_keys SET error_count = 3, "
            "cooldown_until = datetime('now', '+5 minutes') WHERE id = ?",
            (key_id,),
        )
        connection.commit()

    replacement = "provider-secret-replacement-5678"
    response = client.put(
        f"/api/providers/{provider_id}",
        json={"api_key": replacement},
    )

    assert response.status_code == 200
    with sqlite3.connect(database) as connection:
        legacy, runtime = connection.execute(
            "SELECT p.api_key, k.api_key FROM providers p "
            "JOIN provider_api_keys k ON k.provider_id = p.id WHERE p.id = ?",
            (provider_id,),
        ).fetchone()
        health = connection.execute(
            "SELECT error_count, cooldown_until, last_error_summary "
            "FROM provider_api_keys WHERE id = ?",
            (key_id,),
        ).fetchone()
    assert crypto.decrypt(legacy) == replacement
    assert crypto.decrypt(runtime) == replacement
    assert health == (0, None, None)


def test_provider_api_key_update_rejects_empty_secret(admin_app) -> None:
    app, database = admin_app
    client = app.test_client()
    provider_id = client.post("/api/providers", json=_provider_payload()).get_json()["id"]
    with sqlite3.connect(database) as connection:
        key_id = connection.execute(
            "SELECT id FROM provider_api_keys WHERE provider_id = ?",
            (provider_id,),
        ).fetchone()[0]

    response = client.put(
        f"/api/provider-api-keys/{key_id}",
        json={"api_key": "   "},
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "api_key must be a non-empty string"

    provider_response = client.put(
        f"/api/providers/{provider_id}",
        json={"api_key": ""},
    )
    assert provider_response.status_code == 400
    assert provider_response.get_json()["error"] == "api_key must be a non-empty string"


def test_provider_api_key_create_rejects_empty_secret(admin_app) -> None:
    app, _database = admin_app
    client = app.test_client()
    provider_id = client.post("/api/providers", json=_provider_payload()).get_json()["id"]

    response = client.post(
        f"/api/providers/{provider_id}/api-keys",
        json={"api_key": "   "},
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "api_key must be a non-empty string"


def test_provider_creation_rolls_back_when_first_key_fails(admin_app) -> None:
    app, database = admin_app
    with sqlite3.connect(database) as connection:
        connection.execute(
            """
            CREATE TRIGGER reject_provider_key
            BEFORE INSERT ON provider_api_keys
            BEGIN
                SELECT RAISE(ABORT, 'injected provider key failure');
            END
            """
        )

    response = app.test_client().post(
        "/api/providers", json=_provider_payload("rollback-provider")
    )

    assert response.status_code == 500
    with sqlite3.connect(database) as connection:
        provider_count = connection.execute(
            "SELECT COUNT(*) FROM providers WHERE name = 'rollback-provider'"
        ).fetchone()[0]
    assert provider_count == 0


def test_all_secret_list_responses_are_masked(admin_app) -> None:
    app, _database = admin_app
    client = app.test_client()
    provider_secret = _provider_payload()["api_key"]
    provider_id = client.post("/api/providers", json=_provider_payload()).get_json()["id"]
    second_provider_secret = "second-provider-secret-9876"
    assert client.post(
        f"/api/providers/{provider_id}/api-keys",
        json={"api_key": second_provider_secret, "priority": 10},
    ).status_code == 201

    created_client_key = client.post(
        "/api/keys", json={"name": "一次性密钥"}
    ).get_json()["key_value"]

    responses = [
        client.get("/api/providers"),
        client.get(f"/api/providers/{provider_id}"),
        client.get(f"/api/providers/{provider_id}/api-keys"),
        client.get("/api/keys"),
    ]
    serialized = "\n".join(response.get_data(as_text=True) for response in responses)

    assert all(response.status_code == 200 for response in responses)
    assert provider_secret not in serialized
    assert second_provider_secret not in serialized
    assert created_client_key not in serialized
    assert '"api_key"' not in responses[0].get_data(as_text=True)
    assert '"api_key"' not in responses[2].get_data(as_text=True)
    assert '"key_value"' not in responses[3].get_data(as_text=True)
    assert responses[2].get_json()["keys"][0]["api_key_preview"]
    assert responses[3].get_json()["keys"][0]["key_preview"]


def test_generated_client_key_is_not_returned_by_list(admin_app) -> None:
    app, _database = admin_app
    client = app.test_client()

    created = client.post("/api/keys", json={"name": "自动生成"})
    assert created.status_code == 201
    assert created.headers["Cache-Control"] == "no-store"
    full_key = created.get_json()["key_value"]
    assert full_key.startswith("heimdall-")

    listed = client.get("/api/keys")
    assert listed.status_code == 200
    assert full_key not in listed.get_data(as_text=True)
    assert "key_value" not in listed.get_json()["keys"][0]


def test_client_key_copy_requires_an_explicit_single_key_action(admin_app) -> None:
    app, _database = admin_app
    client = app.test_client()
    created = client.post("/api/keys", json={"name": "显式复制"}).get_json()

    copied = client.post(f"/api/keys/{created['id']}/copy")
    missing = client.post("/api/keys/999999/copy")

    assert copied.status_code == 200
    assert copied.headers["Cache-Control"] == "no-store"
    assert copied.get_json()["key_value"] == created["key_value"]
    assert missing.status_code == 404
    assert created["key_value"] not in client.get("/api/keys").get_data(as_text=True)


def test_client_key_reset_returns_new_secret_only_after_update(admin_app) -> None:
    app, _database = admin_app
    client = app.test_client()
    created = client.post("/api/keys", json={"name": "待重置"}).get_json()

    unchanged = client.post(f"/api/keys/{created['id']}/copy").get_json()["key_value"]
    updated = client.put(
        f"/api/keys/{created['id']}",
        json={"name": "已重置", "reset_key": True},
    )
    copied_after = client.post(f"/api/keys/{created['id']}/copy").get_json()["key_value"]

    assert unchanged == created["key_value"]
    assert updated.status_code == 200
    assert updated.headers["Cache-Control"] == "no-store"
    assert updated.get_json()["key_value"].startswith("heimdall-")
    assert copied_after == updated.get_json()["key_value"]
    assert copied_after != unchanged
    assert copied_after not in client.get("/api/keys").get_data(as_text=True)


def test_deleting_client_key_preserves_request_name_snapshot(admin_app) -> None:
    app, database = admin_app
    client = app.test_client()
    created = client.post("/api/keys", json={"name": "即将删除的客户端"})
    key_id = created.get_json()["id"]
    with sqlite3.connect(database) as connection:
        connection.execute(
            """
            INSERT INTO requests (
                date, model, api_key_id, client_api_key_id,
                client_api_key_name, stat_eligible
            ) VALUES (date('now'), 'fixture-model', ?, ?, NULL, 1)
            """,
            (key_id, key_id),
        )
        connection.commit()

    deleted = client.delete(f"/api/keys/{key_id}")

    assert deleted.status_code == 200
    with sqlite3.connect(database) as connection:
        key_count = connection.execute(
            "SELECT COUNT(*) FROM api_keys WHERE id = ?", (key_id,)
        ).fetchone()[0]
        snapshot = connection.execute(
            "SELECT client_api_key_name FROM requests WHERE client_api_key_id = ?",
            (key_id,),
        ).fetchone()[0]
    assert key_count == 0
    assert snapshot == "即将删除的客户端"


def test_model_context_and_free_price_are_distinct_from_unknown(admin_app) -> None:
    app, _database = admin_app
    client = app.test_client()
    provider_id = client.post("/api/providers", json=_provider_payload()).get_json()["id"]

    created = client.post(
        f"/api/providers/{provider_id}/models",
        json={
            "model_name": "phase2-model",
            "upstream_model": "upstream-phase2-model",
            "context_window": 128000,
            "pricing_configured": False,
        },
    )
    assert created.status_code == 201
    model_id = created.get_json()["id"]

    unknown = client.get(f"/api/providers/{provider_id}/models").get_json()["models"][0]
    assert unknown["context_window"] == 128000
    assert unknown["pricing_configured"] is False

    updated = client.put(
        f"/api/models/{model_id}",
        json={
            "pricing_configured": True,
            "price_input": 0,
            "price_output": 0,
            "price_cache_read": 0,
            "price_cache_write": 0,
        },
    )
    assert updated.status_code == 200
    free = client.get(f"/api/providers/{provider_id}/models").get_json()["models"][0]
    assert free["pricing_configured"] is True
    assert free["price_input"] == 0


@pytest.mark.parametrize(
    ("payload", "error"),
    [
        ({"name": "", "api_key": "secret", "openai_url": "https://example.com"}, "请输入厂商标识"),
        ({"name": "missing-key", "api_key": "", "openai_url": "https://example.com"}, "请输入首个 Provider API Key"),
    ],
)
def test_provider_required_fields_return_actionable_errors(admin_app, payload, error) -> None:
    app, _database = admin_app
    response = app.test_client().post("/api/providers", json=payload)
    assert response.status_code == 400
    assert response.get_json()["error"] == error
