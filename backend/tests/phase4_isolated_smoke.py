"""Fail-closed runtime/retention smoke for the isolated Heimdall stack."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request


ADMIN = os.getenv("HEIMDALL_SMOKE_ADMIN", "http://127.0.0.1:18889")
EXPECTED_CONTAINER = "heimdall-refinement-proxy"


def request(path: str, *, method: str = "GET", payload=None, expected=200):
    body = None
    headers = {}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(ADMIN + path, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            data = json.loads(response.read().decode("utf-8"))
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
        data = json.loads(exc.read().decode("utf-8"))
    if status != expected:
        raise AssertionError(f"{method} {path}: expected {expected}, got {status}: {data}")
    return data


def wait_ready(expected: bool, timeout: float = 20) -> dict:
    deadline = time.monotonic() + timeout
    last = {}
    while time.monotonic() < deadline:
        last = request("/api/proxy/status")
        if bool(last.get("ready")) is expected:
            return last
        time.sleep(0.5)
    raise AssertionError(f"Proxy readiness did not become {expected}: {last}")


def main() -> int:
    status = request("/api/proxy/status")
    if status.get("container_name") != EXPECTED_CONTAINER:
        raise AssertionError(f"refusing control target: {status}")
    if not status.get("ready"):
        raise AssertionError(f"isolated proxy not ready before smoke: {status}")

    config = request("/api/proxy/config")
    assert config["proxy_port"] == 19888
    assert config["active_proxy_port"] == 19888
    assert config["dashboard_port"] == 18889
    assert "proxy_port" in config["editable_fields"]
    assert "openai_base_path" in config["editable_fields"]
    assert "anthropic_base_path" in config["editable_fields"]
    request(
        "/api/proxy/config",
        method="PUT",
        payload={"proxy_port": 80},
        expected=400,
    )
    unchanged = request(
        "/api/proxy/config",
        method="PUT",
        payload={"proxy_port": 19888, "openai_base_path": "/openai"},
    )
    assert unchanged["success"] is True and unchanged["restart_required"] is False

    restart = request("/api/proxy/restart", method="POST")
    assert restart["success"] and restart["state"]["ready"]

    stopped = request("/api/proxy/stop", method="POST")
    assert stopped["success"] and not stopped["state"]["running"]
    wait_ready(False)

    started = request("/api/proxy/start", method="POST")
    assert started["success"] and started["state"]["ready"]
    wait_ready(True)

    retention = request("/api/requests/retention")
    assert retention["enabled"] is False
    preview = request(
        "/api/requests/retention/preview",
        method="POST",
        payload={"retention_days": 3650},
    )
    enabled = request(
        "/api/requests/retention",
        method="PUT",
        payload={
            "enabled": True,
            "retention_days": 3650,
            "confirmation_token": preview["confirmation_token"],
        },
    )
    assert enabled["enabled"] is True and enabled["cleanup_started"] is False
    disabled = request(
        "/api/requests/retention",
        method="PUT",
        payload={"enabled": False, "retention_days": 3650},
    )
    assert disabled["enabled"] is False

    print("proxy_allowlist=passed")
    print("proxy_restart_stop_start=passed")
    print("proxy_readiness=passed")
    print("proxy_connection_config=passed")
    print("retention_preview_confirmation=passed")
    print("retention_save_without_delete=passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
