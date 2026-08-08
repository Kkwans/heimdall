import json
import os
import sqlite3
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
    monkeypatch.setattr(config, "DB_PATH", str(database))
    monkeypatch.setattr(config, "RUNTIME_CONFIG_PATH", str(runtime_config))
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
