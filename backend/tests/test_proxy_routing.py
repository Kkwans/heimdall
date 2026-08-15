import json
import sqlite3
import time
from pathlib import Path

import pytest
import requests

import auth
import config
import crypto
import db
import proxy
import router


def _close_thread_connection() -> None:
    connection = getattr(db._local, "conn", None)
    if connection is not None:
        connection.close()
    db._local.conn = None


class FakeResponse:
    def __init__(self, status_code=200, payload=None, lines=None):
        self.status_code = status_code
        self._payload = payload
        self._lines = lines or []
        self.headers = {"Content-Type": "application/json", "M-TraceId": "trace-fixture"}
        self.closed = False
        self.content = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")

    def json(self):
        return self._payload

    def iter_lines(self):
        for line in self._lines:
            if isinstance(line, BaseException):
                raise line
            yield line

    def iter_content(self, chunk_size=8192):
        if self.content:
            yield self.content

    def close(self):
        self.closed = True


def _sse(payload):
    return b"data: " + json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _sse_frame(payload, event=None):
    lines = []
    if event:
        lines.append(f"event: {event}".encode("utf-8"))
    lines.append(_sse(payload))
    lines.append(b"")
    return lines


@pytest.fixture
def proxy_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _close_thread_connection()
    database = tmp_path / "heimdall.db"
    monkeypatch.setattr(config, "DB_PATH", str(database))
    monkeypatch.setattr(crypto, "_KEY_FILE", str(tmp_path / ".encryption_key"))
    monkeypatch.setattr(crypto, "_fernet", None)
    monkeypatch.setattr(config, "REQUEST_TIMEOUT", 1)

    db.init_db()
    router.init_routing_tables()
    auth.init_auth_tables()
    provider_id = router.create_provider(
        {
            "name": "fixture",
            "display_name": "Fixture",
            "openai_url": "http://fixture-upstream/v1",
            "anthropic_url": "http://fixture-upstream/v1",
            "api_key": "provider-key-one",
            "api_key_priority": 10,
        }
    )
    second_key_id = router.create_provider_api_key(
        provider_id,
        {"api_key": "provider-key-two", "priority": 0},
    )
    router.create_model(
        provider_id,
        {
            "model_name": "gateway-model",
            "upstream_model": "upstream-model",
            "context_window": 128000,
        },
    )
    client_secret = "heimdall-client-fixture"
    client_key_id = auth.create_api_key(
        {"name": "fixture-client", "key_value": client_secret}
    )["id"]
    first_key_id = sqlite3.connect(database).execute(
        "SELECT id FROM provider_api_keys WHERE provider_id = ? ORDER BY priority DESC, id",
        (provider_id,),
    ).fetchone()[0]

    records = []
    monkeypatch.setattr(db, "insert_request", records.append)
    proxy.app.config.update(TESTING=True)
    yield {
        "app": proxy.app,
        "database": database,
        "provider_id": provider_id,
        "first_key_id": first_key_id,
        "second_key_id": second_key_id,
        "client_secret": client_secret,
        "client_key_id": client_key_id,
        "records": records,
    }
    _close_thread_connection()
    crypto._fernet = None


def _success_response(protocol: str, stream: bool):
    if protocol == "openai_chat":
        if stream:
            return FakeResponse(
                lines=(
                    _sse_frame({"choices": [{"delta": {"content": "hello"}}]})
                    + _sse_frame(
                        {
                            "choices": [],
                            "usage": {"prompt_tokens": 4, "completion_tokens": 2},
                        }
                    )
                    + [b"data: [DONE]", b""]
                )
            )
        return FakeResponse(
            payload={
                "choices": [{"message": {"content": "hello"}}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6},
            }
        )
    if protocol == "openai_responses":
        if stream:
            return FakeResponse(
                lines=(
                    _sse_frame(
                        {"type": "response.output_text.delta", "delta": "hello"}
                    )
                    + _sse_frame(
                        {
                            "type": "response.completed",
                            "response": {
                                "usage": {"input_tokens": 4, "output_tokens": 2}
                            },
                        }
                    )
                )
            )
        return FakeResponse(
            payload={"output": [], "usage": {"input_tokens": 4, "output_tokens": 2}}
        )
    if stream:
        return FakeResponse(
            lines=(
                _sse_frame(
                    {
                        "type": "message_start",
                        "message": {"usage": {"input_tokens": 4, "output_tokens": 0}},
                    }
                )
                + _sse_frame(
                    {
                        "type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": "hello"},
                    }
                )
                + _sse_frame({"type": "message_delta", "usage": {"output_tokens": 2}})
            )
        )
    return FakeResponse(
        payload={"content": [], "usage": {"input_tokens": 4, "output_tokens": 2}}
    )


@pytest.mark.parametrize(
    ("protocol", "endpoint", "auth_header"),
    [
        ("openai_chat", "/v1/chat/completions", "Authorization"),
        ("openai_responses", "/v1/responses", "Authorization"),
        ("anthropic_messages", "/v1/messages", "x-api-key"),
    ],
)
@pytest.mark.parametrize("stream", [False, True])
def test_six_protocol_modes_create_one_complete_record(
    proxy_env, monkeypatch, protocol, endpoint, auth_header, stream
) -> None:
    monkeypatch.setattr(
        proxy.http_requests,
        "post",
        lambda *args, **kwargs: _success_response(protocol, stream),
    )
    headers = {auth_header: proxy_env["client_secret"]}
    if auth_header == "Authorization":
        headers[auth_header] = f"Bearer {proxy_env['client_secret']}"
    payload = {
        "model": "fixture/gateway-model",
        "messages": [{"role": "user", "content": "hello"}],
        "stream": stream,
    }

    response = proxy_env["app"].test_client().post(endpoint, json=payload, headers=headers)
    assert response.status_code == 200
    response.get_data()

    assert len(proxy_env["records"]) == 1
    record = proxy_env["records"][0]
    assert record["success"] == 1
    assert record["protocol"] == protocol
    assert record["endpoint"] == endpoint
    assert record["stream"] == int(stream)
    assert record["model"] == "gateway-model"
    assert record["original_model"] == "fixture/gateway-model"
    assert record["provider"] == "fixture"
    assert record["provider_id"] == proxy_env["provider_id"]
    assert record["provider_api_key_id"] == proxy_env["first_key_id"]
    assert record["client_api_key_id"] == proxy_env["client_key_id"]
    assert record["total_tokens"] == 6
    assert record["stat_eligible"] == 1
    assert json.loads(record["request_body"])["model"] == "fixture/gateway-model"
    assert len(json.loads(record["route_attempts"])) == 1
    assert record["response_body"]


def test_anthropic_sse_preserves_event_and_data_frames(proxy_env, monkeypatch) -> None:
    upstream = FakeResponse(
        lines=(
            _sse_frame(
                {
                    "type": "message_start",
                    "message": {"usage": {"input_tokens": 4, "output_tokens": 0}},
                },
                event="message_start",
            )
            + _sse_frame(
                {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "hello"},
                },
                event="content_block_delta",
            )
            + _sse_frame({"type": "message_stop"}, event="message_stop")
        )
    )
    monkeypatch.setattr(proxy.http_requests, "post", lambda *args, **kwargs: upstream)

    response = proxy_env["app"].test_client().post(
        "/v1/messages",
        json={"model": "fixture/gateway-model", "messages": [], "stream": True},
        headers={"x-api-key": proxy_env["client_secret"]},
    )

    body = response.get_data()
    assert response.status_code == 200
    assert (
        b"event: message_start\n"
        b'data: {"type": "message_start", "message": {"usage": {"input_tokens": 4, "output_tokens": 0}}}\n\n'
    ) in body
    assert b"event: content_block_delta\n" in body
    assert body.count(b"\n\n") == 3
    assert proxy_env["records"][0]["success"] == 1


def test_non_stream_ttfb_uses_first_response_chunk(proxy_env, monkeypatch) -> None:
    class ChunkedResponse(FakeResponse):
        def iter_content(self, chunk_size=8192):
            midpoint = max(len(self.content) // 2, 1)
            yield self.content[:midpoint]
            time.sleep(0.02)
            yield self.content[midpoint:]

    upstream = ChunkedResponse(
        payload={
            "choices": [{"message": {"content": "hello"}}],
            "usage": {"prompt_tokens": 4, "completion_tokens": 2},
        }
    )
    monkeypatch.setattr(proxy.http_requests, "post", lambda *args, **kwargs: upstream)

    response = proxy_env["app"].test_client().post(
        "/v1/chat/completions",
        json={"model": "fixture/gateway-model", "messages": []},
        headers={"Authorization": f"Bearer {proxy_env['client_secret']}"},
    )

    assert response.status_code == 200
    record = proxy_env["records"][0]
    assert record["ttfb_ms"] < record["latency_ms"]


def test_non_stream_response_read_failure_is_not_reported_as_proxy_crash(proxy_env, monkeypatch) -> None:
    class BrokenResponse(FakeResponse):
        def iter_content(self, chunk_size=8192):
            yield self.content[:1]
            raise requests.exceptions.ChunkedEncodingError("injected read break")

    upstream = BrokenResponse(payload={"choices": []})
    monkeypatch.setattr(proxy.http_requests, "post", lambda *args, **kwargs: upstream)

    response = proxy_env["app"].test_client().post(
        "/v1/chat/completions",
        json={"model": "fixture/gateway-model", "messages": []},
        headers={"Authorization": f"Bearer {proxy_env['client_secret']}"},
    )

    assert response.status_code == 502
    assert proxy_env["records"][0]["error_type"] == "connection_error"


@pytest.mark.parametrize(
    ("endpoint", "auth_header", "usage", "expected"),
    [
        (
            "/v1/responses",
            "Authorization",
            {
                "input_tokens": 10,
                "output_tokens": 3,
                "total_tokens": 13,
                "input_tokens_details": {"cached_tokens": 6},
            },
            (10, 3, 13, 6, 0),
        ),
        (
            "/v1/messages",
            "x-api-key",
            {
                "input_tokens": 2,
                "output_tokens": 1,
                "cache_read_input_tokens": 5,
                "cache_creation_input_tokens": 3,
            },
            (10, 1, 11, 5, 3),
        ),
    ],
)
def test_cache_usage_survives_proxy_recording_normalization(
    proxy_env, monkeypatch, endpoint, auth_header, usage, expected
) -> None:
    monkeypatch.setattr(
        proxy.http_requests,
        "post",
        lambda *args, **kwargs: FakeResponse(payload={"usage": usage}),
    )
    headers = {auth_header: proxy_env["client_secret"]}
    if auth_header == "Authorization":
        headers[auth_header] = f"Bearer {proxy_env['client_secret']}"

    response = proxy_env["app"].test_client().post(
        endpoint,
        json={"model": "fixture/gateway-model", "messages": []},
        headers=headers,
    )

    assert response.status_code == 200
    record = proxy_env["records"][0]
    actual = (
        record["prompt_tokens"],
        record["completion_tokens"],
        record["total_tokens"],
        record["cache_hit_tokens"],
        record["cache_miss_tokens"],
    )
    assert actual == expected


def test_retryable_status_switches_key_and_records_attempts(proxy_env, monkeypatch) -> None:
    used_secrets = []

    def post(*args, **kwargs):
        secret = kwargs["headers"]["Authorization"].removeprefix("Bearer ")
        used_secrets.append(secret)
        if secret == "provider-key-one":
            return FakeResponse(status_code=429, payload={"error": "rate_limited"})
        return _success_response("openai_chat", False)

    monkeypatch.setattr(proxy.http_requests, "post", post)
    response = proxy_env["app"].test_client().post(
        "/v1/chat/completions",
        json={"model": "gateway-model", "messages": []},
        headers={"Authorization": f"Bearer {proxy_env['client_secret']}"},
    )

    assert response.status_code == 200
    assert used_secrets == ["provider-key-one", "provider-key-two"]
    assert len(proxy_env["records"]) == 1
    record = proxy_env["records"][0]
    assert record["provider_api_key_id"] == proxy_env["second_key_id"]
    assert [item["status_code"] for item in json.loads(record["route_attempts"])] == [429, 200]
    with sqlite3.connect(proxy_env["database"]) as connection:
        error_count = connection.execute(
            "SELECT error_count FROM provider_api_keys WHERE id = ?",
            (proxy_env["first_key_id"],),
        ).fetchone()[0]
    assert error_count == 1


def test_ordinary_400_does_not_switch_or_penalize_key(proxy_env, monkeypatch) -> None:
    calls = []

    def post(*args, **kwargs):
        calls.append(kwargs["headers"]["Authorization"])
        return FakeResponse(status_code=400, payload={"error": "bad_request"})

    monkeypatch.setattr(proxy.http_requests, "post", post)
    response = proxy_env["app"].test_client().post(
        "/v1/chat/completions",
        json={"model": "gateway-model", "messages": []},
        headers={"Authorization": f"Bearer {proxy_env['client_secret']}"},
    )

    assert response.status_code == 400
    assert len(calls) == 1
    assert len(proxy_env["records"]) == 1
    with sqlite3.connect(proxy_env["database"]) as connection:
        error_count = connection.execute(
            "SELECT error_count FROM provider_api_keys WHERE id = ?",
            (proxy_env["first_key_id"],),
        ).fetchone()[0]
    assert error_count == 0


@pytest.mark.parametrize(
    ("exception", "expected_status", "expected_type"),
    [
        (requests.exceptions.Timeout(), 504, "timeout"),
        (requests.exceptions.ConnectionError(), 502, "connection_error"),
    ],
)
def test_transport_failure_rotates_all_keys_once(
    proxy_env, monkeypatch, exception, expected_status, expected_type
) -> None:
    calls = []

    def post(*args, **kwargs):
        calls.append(kwargs["headers"]["Authorization"])
        raise exception

    monkeypatch.setattr(proxy.http_requests, "post", post)
    response = proxy_env["app"].test_client().post(
        "/v1/chat/completions",
        json={"model": "gateway-model", "messages": []},
        headers={"Authorization": f"Bearer {proxy_env['client_secret']}"},
    )

    assert response.status_code == expected_status
    assert len(calls) == 2
    assert len(proxy_env["records"]) == 1
    assert proxy_env["records"][0]["error_type"] == expected_type
    assert len(json.loads(proxy_env["records"][0]["route_attempts"])) == 2


def test_third_retryable_failure_enters_cooldown_and_success_recovers(proxy_env) -> None:
    key_id = proxy_env["first_key_id"]
    for _ in range(3):
        router.mark_api_key_error(key_id, "upstream_status_500")

    with sqlite3.connect(proxy_env["database"]) as connection:
        state = connection.execute(
            "SELECT error_count, cooldown_until FROM provider_api_keys WHERE id = ?",
            (key_id,),
        ).fetchone()
    assert state[0] == 3
    assert state[1]
    assert key_id not in [item.id for item in router.get_provider_api_keys_for_route(proxy_env["provider_id"])]

    router.mark_api_key_used(key_id)
    with sqlite3.connect(proxy_env["database"]) as connection:
        recovered = connection.execute(
            "SELECT error_count, cooldown_until FROM provider_api_keys WHERE id = ?",
            (key_id,),
        ).fetchone()
    assert recovered == (0, None)


def test_auth_and_validation_failures_are_recorded_without_polluting_stats(
    proxy_env,
) -> None:
    client = proxy_env["app"].test_client()
    assert client.post("/v1/chat/completions", json={}).status_code == 400
    assert client.post(
        "/v1/chat/completions",
        json={"model": "gateway-model"},
        headers={"Authorization": "Bearer invalid"},
    ).status_code == 401

    restricted = auth.create_api_key(
        {
            "name": "restricted",
            "key_value": "restricted-secret",
            "allowed_models": "another-model",
        }
    )
    assert restricted["id"]
    assert client.post(
        "/v1/chat/completions",
        json={"model": "gateway-model"},
        headers={"Authorization": "Bearer restricted-secret"},
    ).status_code == 403
    assert client.post(
        "/v1/chat/completions",
        json={"model": "missing-model"},
        headers={"Authorization": f"Bearer {proxy_env['client_secret']}"},
    ).status_code == 400

    assert [item["stat_eligible"] for item in proxy_env["records"]] == [0, 0, 1, 1]
    assert all(item["success"] == 0 for item in proxy_env["records"])


def test_stream_interruption_is_not_recorded_as_success(proxy_env, monkeypatch) -> None:
    response = FakeResponse(
        lines=_sse_frame({"choices": [{"delta": {"content": "partial"}}]})
        + [requests.exceptions.ChunkedEncodingError("injected break")]
    )
    monkeypatch.setattr(proxy.http_requests, "post", lambda *args, **kwargs: response)

    result = proxy_env["app"].test_client().post(
        "/v1/chat/completions",
        json={"model": "gateway-model", "messages": [], "stream": True},
        headers={"Authorization": f"Bearer {proxy_env['client_secret']}"},
    )
    result.get_data()

    assert len(proxy_env["records"]) == 1
    assert proxy_env["records"][0]["status_code"] == 502
    assert proxy_env["records"][0]["success"] == 0
    assert proxy_env["records"][0]["error_type"] == "stream_interrupted"


def test_legacy_provider_secret_is_not_a_runtime_fallback(proxy_env) -> None:
    with sqlite3.connect(proxy_env["database"]) as connection:
        connection.execute(
            "DELETE FROM provider_api_keys WHERE provider_id = ?",
            (proxy_env["provider_id"],),
        )
        connection.commit()

    result = router.resolve_route_for_proxy("gateway-model")

    assert isinstance(result, router.RouteError)
    assert result.status_code == 403


def test_legacy_provider_json_import_creates_runtime_provider_key(proxy_env, tmp_path) -> None:
    providers_file = tmp_path / "providers.json"
    providers_file.write_text(
        json.dumps(
            {
                "providers": {
                    "imported": {
                        "name": "Imported Provider",
                        "base_url": "http://imported-upstream/v1",
                        "api_key": "imported-provider-secret",
                        "models": {
                            "imported-model": {"upstream_model": "upstream-imported"}
                        },
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    router._import_from_json(str(providers_file))
    route = router.resolve_route_for_proxy("imported/imported-model")

    assert isinstance(route, router.RouteResult)
    assert route.api_key == "imported-provider-secret"
    with sqlite3.connect(proxy_env["database"]) as connection:
        key_count = connection.execute(
            "SELECT COUNT(*) FROM provider_api_keys k "
            "JOIN providers p ON p.id = k.provider_id WHERE p.name = ?",
            ("imported",),
        ).fetchone()[0]
    assert key_count == 1


def test_legacy_provider_json_import_rolls_back_partial_provider(proxy_env, tmp_path) -> None:
    providers_file = tmp_path / "invalid-providers.json"
    providers_file.write_text(
        json.dumps(
            {
                "providers": {
                    "partial-import": {
                        "name": "Partial Import",
                        "base_url": "http://invalid-upstream/v1",
                        "api_key": "partial-secret",
                        # 该值会在 Provider 已插入后触发配置错误，验证整批回滚。
                        "models": {"broken-model": None},
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    router._import_from_json(str(providers_file))

    with sqlite3.connect(proxy_env["database"]) as connection:
        provider_count = connection.execute(
            "SELECT COUNT(*) FROM providers WHERE name = ?",
            ("partial-import",),
        ).fetchone()[0]
        key_count = connection.execute(
            "SELECT COUNT(*) FROM provider_api_keys k "
            "JOIN providers p ON p.id = k.provider_id WHERE p.name = ?",
            ("partial-import",),
        ).fetchone()[0]
    assert provider_count == 0
    assert key_count == 0


def test_ineligible_requests_remain_visible_but_are_excluded_from_stats(
    proxy_env, monkeypatch
) -> None:
    client = proxy_env["app"].test_client()
    assert client.post(
        "/v1/chat/completions", json={"model": "gateway-model"}
    ).status_code == 401
    monkeypatch.setattr(
        proxy.http_requests,
        "post",
        lambda *args, **kwargs: _success_response("openai_chat", False),
    )
    assert client.post(
        "/v1/chat/completions",
        json={"model": "gateway-model", "messages": []},
        headers={"Authorization": f"Bearer {proxy_env['client_secret']}"},
    ).status_code == 200
    assert [record["stat_eligible"] for record in proxy_env["records"]] == [0, 1]

    for record in proxy_env["records"]:
        db._do_insert(record)

    day = proxy_env["records"][0]["date"]
    assert db.query_requests(1, 20, {})["total"] == 2
    overview = db.query_overview(day, day)
    assert overview["total_requests"] == 1
    assert overview["success_requests"] == 1


def test_client_disconnect_finalizes_stream_as_499(proxy_env, monkeypatch) -> None:
    upstream = FakeResponse(
        lines=_sse_frame({"choices": [{"delta": {"content": "first"}}]})
        + _sse_frame({"choices": [{"delta": {"content": "second"}}]}),
    )
    monkeypatch.setattr(proxy.http_requests, "post", lambda *args, **kwargs: upstream)
    response = proxy_env["app"].test_client().post(
        "/v1/chat/completions",
        json={"model": "gateway-model", "messages": [], "stream": True},
        headers={"Authorization": f"Bearer {proxy_env['client_secret']}"},
        buffered=False,
    )

    iterator = iter(response.response)
    assert next(iterator)
    response.close()

    assert len(proxy_env["records"]) == 1
    assert proxy_env["records"][0]["status_code"] == 499
    assert proxy_env["records"][0]["success"] == 0
    assert proxy_env["records"][0]["error_type"] == "client_disconnect"


def test_upstream_receives_resolved_model_while_record_keeps_requested_model(
    proxy_env, monkeypatch
) -> None:
    forwarded = {}

    def post(*args, **kwargs):
        forwarded.update(kwargs["json"])
        return _success_response("openai_chat", False)

    monkeypatch.setattr(proxy.http_requests, "post", post)
    response = proxy_env["app"].test_client().post(
        "/v1/chat/completions",
        json={"model": "fixture/gateway-model", "messages": []},
        headers={"Authorization": f"Bearer {proxy_env['client_secret']}"},
    )

    assert response.status_code == 200
    assert forwarded["model"] == "upstream-model"
    assert proxy_env["records"][0]["model"] == "gateway-model"
    assert proxy_env["records"][0]["original_model"] == "fixture/gateway-model"
