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


def test_generated_client_key_is_returned_only_by_create(admin_app) -> None:
    app, _database = admin_app
    client = app.test_client()

    created = client.post("/api/keys", json={"name": "自动生成"})
    assert created.status_code == 201
    full_key = created.get_json()["key_value"]
    assert full_key.startswith("heimdall-")

    listed = client.get("/api/keys")
    assert listed.status_code == 200
    assert full_key not in listed.get_data(as_text=True)
    assert "key_value" not in listed.get_json()["keys"][0]


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
