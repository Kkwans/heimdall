import json
import os
import sqlite3
from datetime import date
from pathlib import Path

import pytest
from flask import Flask

import config
import db
import stats_api
from migrations import apply_migrations
from services.docker_service import DockerControlTimeout


def _close_thread_connection() -> None:
    connection = getattr(db._local, "conn", None)
    if connection is not None:
        connection.close()
    db._local.conn = None


class FakeDockerService:
    def __init__(self):
        self.actions = []
        self.policy = "unless-stopped"

    def get_status(self):
        return {
            "running": True,
            "ready": True,
            "status": "running",
            "health": "healthy",
            "container_name": "heimdall-refinement-proxy",
        }

    def control(self, action):
        self.actions.append(action)
        return {"action": action, "running": action != "stop", "ready": action != "stop"}

    def restart_policy(self):
        return self.policy

    def set_restart_policy(self, enabled):
        self.policy = "unless-stopped" if enabled else "no"
        return self.policy


@pytest.fixture
def runtime_app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _close_thread_connection()
    database = tmp_path / "heimdall.db"
    runtime_config = tmp_path / "runtime_config.json"
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    monkeypatch.setattr(config, "DB_PATH", str(database))
    monkeypatch.setattr(config, "RUNTIME_CONFIG_PATH", str(runtime_config))
    monkeypatch.setattr(config, "LOG_DIR", str(log_dir))
    monkeypatch.setattr(config, "PROXY_EXTERNAL_PORT", 19888)
    monkeypatch.setattr(config, "DASHBOARD_EXTERNAL_PORT", 18889)
    monkeypatch.setattr(config, "PUBLIC_BASE_URL", "")
    db.init_db()
    _close_thread_connection()
    apply_migrations(database)
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO requests (date, model, request_body, response_body) "
            "VALUES ('2020-01-01', 'legacy', '{}', '{}')"
        )
        connection.execute(
            "INSERT INTO daily_stats (date, total_requests) VALUES ('2020-01-01', 1)"
        )
        connection.commit()

    fake_docker = FakeDockerService()
    monkeypatch.setattr(stats_api, "get_docker_service", lambda: fake_docker)
    stats_api._retention_service = None
    stats_api._retention_service_path = ""

    app = Flask(__name__)
    app.register_blueprint(stats_api.stats_bp)
    app.config.update(TESTING=True)
    yield app, database, runtime_config, fake_docker

    stats_api._retention_service = None
    stats_api._retention_service_path = ""
    _close_thread_connection()


def test_proxy_config_exposes_ports_as_readonly(runtime_app) -> None:
    app, _database, runtime_config, _docker = runtime_app
    client = app.test_client()

    config_response = client.get("/api/proxy/config")
    rejected = client.put("/api/proxy/config", json={"proxy_port": 29999})

    assert config_response.status_code == 200
    assert config_response.get_json()["proxy_port"] == 19888
    assert "proxy_port" in config_response.get_json()["deployment_readonly"]
    assert rejected.status_code == 400
    assert rejected.get_json()["readonly_fields"] == ["proxy_port"]
    assert not runtime_config.exists()


def test_runtime_timeout_is_atomic_and_explicitly_requires_restart(runtime_app) -> None:
    app, _database, runtime_config, _docker = runtime_app
    client = app.test_client()

    first = client.put("/api/proxy/config", json={"request_timeout": 240})
    second = client.put("/api/proxy/config", json={"request_timeout": 240})

    assert first.status_code == 200
    assert first.get_json()["restart_required"] is True
    assert first.get_json()["changed_fields"] == ["request_timeout"]
    assert second.get_json()["restart_required"] is False
    assert json.loads(runtime_config.read_text(encoding="utf-8"))["request_timeout"] == 240
    assert os.stat(runtime_config).st_mode & 0o777 == 0o600


def test_control_endpoint_ignores_request_target_and_uses_bound_service(runtime_app) -> None:
    app, _database, _runtime_config, docker = runtime_app

    response = app.test_client().post(
        "/api/proxy/restart",
        json={"container": "heimdall-proxy"},
    )

    assert response.status_code == 200
    assert response.get_json()["success"] is True
    assert docker.actions == ["restart"]


def test_control_timeout_returns_gateway_timeout(runtime_app, monkeypatch) -> None:
    app, _database, _runtime_config, _docker = runtime_app

    class TimeoutService(FakeDockerService):
        def control(self, action):
            raise DockerControlTimeout("injected readiness timeout")

    monkeypatch.setattr(stats_api, "get_docker_service", TimeoutService)
    response = app.test_client().post("/api/proxy/start")

    assert response.status_code == 504
    assert response.get_json()["success"] is False


def test_retention_api_requires_preview_and_never_deletes_on_save(runtime_app) -> None:
    app, database, _runtime_config, _docker = runtime_app
    client = app.test_client()

    initial = client.get("/api/requests/retention")
    rejected = client.put(
        "/api/requests/retention",
        json={"enabled": True, "retention_days": 30},
    )
    preview = client.post(
        "/api/requests/retention/preview",
        json={"retention_days": 30},
    )
    saved = client.put(
        "/api/requests/retention",
        json={
            "enabled": True,
            "retention_days": 30,
            "confirmation_token": preview.get_json()["confirmation_token"],
        },
    )

    assert initial.get_json()["enabled"] is False
    assert rejected.status_code == 400
    assert preview.get_json()["request_count"] == 1
    assert saved.status_code == 200
    assert saved.get_json()["cleanup_started"] is False
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 1


def test_cost_stats_group_by_client_access_key_and_model(runtime_app) -> None:
    app, database, _runtime_config, _docker = runtime_app
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS api_keys "
            "(id INTEGER PRIMARY KEY, name TEXT NOT NULL)"
        )
        connection.execute("INSERT INTO api_keys (id, name) VALUES (7, '自动化')")
        connection.execute(
            """
            INSERT INTO requests (
                date, model, success, stat_eligible, api_key_id, client_api_key_id,
                prompt_tokens, completion_tokens, total_tokens,
                billable_tokens, estimated_cost, cost_source
            ) VALUES (
                date('now'), 'priced-model', 1, 1, 7, 7,
                800000, 200000, 1000000,
                1000000, 12.5, 'request_snapshot'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO requests (
                date, model, success, stat_eligible, api_key_id, client_api_key_id,
                prompt_tokens, completion_tokens, total_tokens, billable_tokens
            ) VALUES (
                date('now'), 'unknown-model', 1, 1, 7, 7,
                90, 10, 100, 100
            )
            """
        )
        connection.commit()

    response = app.test_client().get("/api/stats/costs")
    dashboard = app.test_client().get("/api/dashboard/summary")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["summary"]["total_cost"] == 12.5
    assert payload["summary"]["coverage_rate"] == 0.5
    assert payload["summary"]["avg_cost_per_million_tokens"] == 12.5
    assert payload["by_client_key"][0]["name"] == "自动化"
    assert payload["by_model"][0]["cost_share"] == 1
    assert dashboard.status_code == 200
    assert set(dashboard.get_json()) == {"overview", "daily", "models"}


def test_deleted_client_key_uses_name_snapshot_in_all_stats(runtime_app) -> None:
    app, database, _runtime_config, _docker = runtime_app
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS api_keys "
            "(id INTEGER PRIMARY KEY, name TEXT NOT NULL)"
        )
        connection.execute("INSERT INTO api_keys (id, name) VALUES (9, '历史客户端')")
        connection.execute(
            """
            INSERT INTO requests (
                date, model, success, stat_eligible, api_key_id, client_api_key_id,
                client_api_key_name, prompt_tokens, completion_tokens, total_tokens,
                billable_tokens, estimated_cost, cost_source
            ) VALUES (
                date('now'), 'priced-model', 1, 1, 9, 9,
                '历史客户端', 8, 2, 10,
                10, 0.0001, 'request_snapshot'
            )
            """
        )
        connection.execute("DELETE FROM api_keys WHERE id = 9")
        connection.commit()

    costs = app.test_client().get("/api/stats/costs").get_json()
    api_keys = app.test_client().get("/api/stats/api-keys").get_json()["data"]

    deleted_cost = next(item for item in costs["by_client_key"] if item["id"] == 9)
    deleted_usage = next(item for item in api_keys if item["api_key_id"] == 9)
    assert deleted_cost["name"] == "历史客户端"
    assert deleted_cost["is_deleted"] is True
    assert deleted_usage["api_key_name"] == "历史客户端"
    assert deleted_usage["api_key_deleted"] is True


def test_unrecoverable_deleted_client_key_uses_stable_id_fallback(runtime_app) -> None:
    app, database, _runtime_config, _docker = runtime_app
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS api_keys "
            "(id INTEGER PRIMARY KEY, name TEXT NOT NULL)"
        )
        connection.execute(
            """
            INSERT INTO requests (
                date, model, success, stat_eligible, api_key_id, client_api_key_id,
                prompt_tokens, completion_tokens, total_tokens
            ) VALUES (date('now'), 'legacy-model', 1, 1, 99, 99, 1, 1, 2)
            """
        )
        connection.commit()

    item = next(
        item
        for item in app.test_client().get("/api/stats/api-keys").get_json()["data"]
        if item["api_key_id"] == 99
    )
    assert item["api_key_name"] == "API Key #99"
    assert item["api_key_deleted"] is True


def test_log_history_uses_cursor_without_fake_all(runtime_app) -> None:
    app, _database, _runtime_config, _docker = runtime_app
    today = date.today().isoformat()
    log_path = Path(config.LOG_DIR) / "proxy-business.log"
    log_path.write_text(
        "".join(f"{today} 10:00:0{i} - INFO - line-{i}\n" for i in range(1, 6)),
        encoding="utf-8",
    )
    client = app.test_client()

    latest = client.get(f"/api/logs/history?date={today}&lines=2")
    older = client.get(f"/api/logs/history?date={today}&lines=2&cursor=2")
    oldest = client.get(f"/api/logs/history?date={today}&lines=2&cursor=4")
    invalid = client.get(f"/api/logs/history?date={today}&cursor=bad")

    assert [line.rsplit(" ", 1)[-1] for line in latest.get_json()["lines"]] == [
        "line-4", "line-5"
    ]
    assert latest.get_json()["total"] == 5
    assert latest.get_json()["next_cursor"] == 2
    assert older.get_json()["next_cursor"] == 4
    assert oldest.get_json()["has_more"] is False
    assert invalid.status_code == 400


def test_log_stream_emits_empty_and_real_heartbeat(runtime_app, monkeypatch) -> None:
    _app, _database, _runtime_config, _docker = runtime_app
    log_path = Path(config.LOG_DIR) / "proxy-business.log"
    log_path.write_text("", encoding="utf-8")
    monkeypatch.setattr(config, "LOG_SSE_HEARTBEAT_SECONDS", 0.01, raising=False)
    monkeypatch.setattr(config, "LOG_SSE_POLL_SECONDS", 0.01, raising=False)

    stream = stats_api._stream_log_file(str(log_path), 20)
    assert next(stream) == "retry: 3000\n\n"
    assert next(stream).startswith("event: empty")
    assert next(stream).startswith("event: heartbeat")
    stream.close()


@pytest.mark.parametrize(
    "method,path",
    [
        ("post", "/api/requests/retention/preview"),
        ("put", "/api/requests/retention"),
        ("put", "/api/proxy/config"),
    ],
)
def test_runtime_endpoints_reject_non_object_json(runtime_app, method, path) -> None:
    app, _database, _runtime_config, _docker = runtime_app

    response = getattr(app.test_client(), method)(path, json=[])

    assert response.status_code == 400
