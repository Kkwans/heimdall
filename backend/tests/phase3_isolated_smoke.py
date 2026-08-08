"""HTTP smoke matrix for the disposable Heimdall refinement stack."""

from __future__ import annotations

import http.client
import json
import os
import time
import urllib.error
import urllib.request


ADMIN = os.getenv("HEIMDALL_SMOKE_ADMIN", "http://127.0.0.1:18889")
PROXY = os.getenv("HEIMDALL_SMOKE_PROXY", "http://127.0.0.1:19888")
CLIENT_SECRET = "heimdall-phase3-isolated-client"
PROVIDER = "phase3-fixture"


def call(method, url, payload=None, headers=None):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request_headers = {"Content-Type": "application/json"}
    request_headers.update(headers or {})
    request = urllib.request.Request(
        url, data=body, headers=request_headers, method=method
    )
    try:
        response = urllib.request.urlopen(request, timeout=15)
        try:
            return response.status, response.read()
        except http.client.IncompleteRead as exc:
            return response.status, exc.partial
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def json_call(method, url, payload=None, headers=None):
    status, body = call(method, url, payload, headers)
    return status, json.loads(body or b"{}")


def _remove_old_fixture() -> None:
    _, providers = json_call("GET", ADMIN + "/api/providers")
    for provider in providers.get("providers", []):
        if provider.get("name") == PROVIDER:
            call("DELETE", f"{ADMIN}/api/providers/{provider['id']}")
    _, keys = json_call("GET", ADMIN + "/api/keys")
    for key in keys.get("keys", []):
        if key.get("name") == "Phase 3 isolated":
            call("DELETE", f"{ADMIN}/api/keys/{key['id']}")


def main() -> int:
    _remove_old_fixture()
    _, baseline_data = json_call(
        "GET", ADMIN + "/api/stats/requests?page=1&page_size=1"
    )
    baseline = baseline_data.get("total", 0)
    baseline_id = (
        baseline_data.get("items", [{}])[0].get("id", 0)
        if baseline_data.get("items")
        else 0
    )
    _, overview_before = json_call("GET", ADMIN + "/api/stats/overview")
    provider_id = None
    client_key_id = None
    try:
        status, created = json_call(
            "POST",
            ADMIN + "/api/providers",
            {
                "name": PROVIDER,
                "display_name": "Phase 3 Fixture",
                "openai_url": "http://fake-upstream:8090",
                "anthropic_url": "http://fake-upstream:8090",
                "api_key": "fixture-success",
                "api_key_priority": 10,
            },
        )
        assert status == 201, (status, created)
        provider_id = created["id"]
        status, _ = json_call(
            "POST",
            f"{ADMIN}/api/providers/{provider_id}/api-keys",
            {"api_key": "fixture-success-two", "priority": 0},
        )
        assert status == 201
        _, key_data = json_call(
            "GET", f"{ADMIN}/api/providers/{provider_id}/api-keys"
        )
        first_key_id = key_data["keys"][0]["id"]
        second_key_id = key_data["keys"][1]["id"]

        status, _ = json_call(
            "POST",
            f"{ADMIN}/api/providers/{provider_id}/models",
            {
                "model_name": "phase3-model",
                "upstream_model": "fixture-upstream-model",
                "context_window": 128000,
                "pricing_configured": False,
            },
        )
        assert status == 201
        status, key_created = json_call(
            "POST",
            ADMIN + "/api/keys",
            {
                "name": "Phase 3 isolated",
                "key_value": CLIENT_SECRET,
            },
        )
        assert status == 201
        client_key_id = key_created["id"]

        cases = (
            ("chat_nonstream", "/v1/chat/completions", False, "openai"),
            ("chat_stream", "/v1/chat/completions", True, "openai"),
            ("responses_nonstream", "/v1/responses", False, "openai"),
            ("responses_stream", "/v1/responses", True, "openai"),
            ("anthropic_nonstream", "/v1/messages", False, "anthropic"),
            ("anthropic_stream", "/v1/messages", True, "anthropic"),
        )
        statuses = {}
        for name, path, stream, protocol in cases:
            payload = {"model": PROVIDER + "/phase3-model", "stream": stream}
            if protocol == "openai" and "responses" in name:
                payload["input"] = "integration"
            else:
                payload["messages"] = [{"role": "user", "content": "integration"}]
            headers = (
                {"x-api-key": CLIENT_SECRET}
                if protocol == "anthropic"
                else {"Authorization": "Bearer " + CLIENT_SECRET}
            )
            statuses[name] = call("POST", PROXY + path, payload, headers)[0]

        json_call(
            "PUT",
            f"{ADMIN}/api/provider-api-keys/{first_key_id}",
            {"api_key": "fixture-400", "priority": 10},
        )
        statuses["ordinary_400"] = call(
            "POST",
            PROXY + "/v1/chat/completions",
            {"model": PROVIDER + "/phase3-model", "messages": []},
            {"Authorization": "Bearer " + CLIENT_SECRET},
        )[0]

        json_call(
            "PUT",
            f"{ADMIN}/api/provider-api-keys/{first_key_id}",
            {"api_key": "fixture-disconnect", "priority": 10},
        )
        statuses["stream_disconnect"] = call(
            "POST",
            PROXY + "/v1/chat/completions",
            {
                "model": PROVIDER + "/phase3-model",
                "messages": [],
                "stream": True,
            },
            {"Authorization": "Bearer " + CLIENT_SECRET},
        )[0]

        json_call(
            "PUT",
            f"{ADMIN}/api/provider-api-keys/{first_key_id}",
            {"api_key": "fixture-429", "priority": 10},
        )
        statuses["retry_429"] = call(
            "POST",
            PROXY + "/v1/chat/completions",
            {"model": PROVIDER + "/phase3-model", "messages": []},
            {"Authorization": "Bearer " + CLIENT_SECRET},
        )[0]
        json_call(
            "PUT",
            f"{ADMIN}/api/provider-api-keys/{first_key_id}",
            {"api_key": "fixture-500", "priority": 10},
        )
        for index in range(1):
            statuses[f"retry_500_{index + 1}"] = call(
                "POST",
                PROXY + "/v1/chat/completions",
                {"model": PROVIDER + "/phase3-model", "messages": []},
                {"Authorization": "Bearer " + CLIENT_SECRET},
            )[0]

        statuses["missing_auth"] = call(
            "POST",
            PROXY + "/v1/chat/completions",
            {"model": PROVIDER + "/phase3-model", "messages": []},
        )[0]
        statuses["invalid_auth"] = call(
            "POST",
            PROXY + "/v1/chat/completions",
            {"model": PROVIDER + "/phase3-model", "messages": []},
            {"Authorization": "Bearer invalid-phase3-key"},
        )[0]

        time.sleep(1)
        _, key_state = json_call(
            "GET", f"{ADMIN}/api/providers/{provider_id}/api-keys"
        )
        first_state = next(
            item for item in key_state["keys"] if item["id"] == first_key_id
        )
        second_state = next(
            item for item in key_state["keys"] if item["id"] == second_key_id
        )
        _, request_data = json_call(
            "GET", ADMIN + "/api/stats/requests?page=1&page_size=20"
        )
        _, overview_after = json_call("GET", ADMIN + "/api/stats/overview")
        new_items = [
            item
            for item in request_data["items"]
            if item.get("provider") == PROVIDER and item.get("id", 0) > baseline_id
        ]
        assert all(
            status == 200
            for name, status in statuses.items()
            if name not in {"ordinary_400", "missing_auth", "invalid_auth"}
        ), statuses
        assert statuses["ordinary_400"] == 400
        assert statuses["missing_auth"] == 401
        assert statuses["invalid_auth"] == 401
        assert request_data["total"] == baseline + 12
        assert len(new_items) == 10
        assert all(item.get("protocol") for item in new_items)
        assert all(item.get("provider_api_key_id") for item in new_items)
        assert first_state["error_count"] == 3
        assert first_state["cooldown_until"]
        assert second_state["last_used_at"]
        attempts = [
            item.get("route_attempts")
            if isinstance(item.get("route_attempts"), list)
            else json.loads(item.get("route_attempts") or "[]")
            for item in new_items
        ]
        assert sum(len(value) == 2 for value in attempts) == 2
        assert sum(item["status_code"] == 400 for item in new_items) == 1
        assert (
            sum(item.get("error_type") == "stream_interrupted" for item in new_items)
            == 1
        )
        assert (
            overview_after["total_requests"]
            == overview_before["total_requests"] + 10
        )
        ineligible = [
            item
            for item in request_data["items"]
            if item.get("id", 0) > baseline_id
            and item.get("stat_eligible") == 0
            and item.get("status_code") == 401
        ]
        assert len(ineligible) >= 2
        print("six_modes=passed")
        print("ordinary_400_no_rotation=passed")
        print("retryable_rotation=passed")
        print("stream_interruption=passed")
        print("cooldown_after_three_failures=passed")
        print("single_record_per_request=passed")
        print("ineligible_visible_but_excluded=passed")
        print("new_records=12")
        return 0
    finally:
        if client_key_id is not None:
            call("DELETE", f"{ADMIN}/api/keys/{client_key_id}")
        if provider_id is not None:
            call("DELETE", f"{ADMIN}/api/providers/{provider_id}")


if __name__ == "__main__":
    raise SystemExit(main())
