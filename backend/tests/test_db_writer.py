import sqlite3
import threading

import pytest

import config
import db


@pytest.fixture
def writer_database(tmp_path, monkeypatch):
    db.shutdown_writer()
    connection = getattr(db._local, "conn", None)
    if connection is not None:
        connection.close()
    db._local.conn = None
    database = tmp_path / "heimdall.db"
    monkeypatch.setattr(config, "DB_PATH", str(database))
    db.init_db()
    yield database
    db.flush_pending_writes(5)
    db.shutdown_writer()
    connection = getattr(db._local, "conn", None)
    if connection is not None:
        connection.close()
    db._local.conn = None


def _record(index: int, *, stat_eligible: int = 1, latency_ms: int = 10) -> dict:
    return {
        "created_at": "2026-08-14 12:00:00",
        "date": "2026-08-14",
        "model": "fixture-model",
        "original_model": "fixture-model",
        "stream": 1,
        "messages_count": 1,
        "prompt_tokens": 4,
        "completion_tokens": 2,
        "total_tokens": 6,
        "cache_hit_tokens": 0,
        "cache_miss_tokens": 0,
        "reasoning_tokens": 0,
        "latency_ms": latency_ms,
        "ttfb_ms": 5,
        "status_code": 200,
        "success": 1,
        "error_type": None,
        "trace_id": f"trace-{index}",
        "client_ip": "127.0.0.1",
        "request_body": "{}",
        "response_body": "{}",
        "provider": "fixture",
        "api_key_id": 1,
        "provider_id": 1,
        "provider_api_key_id": 1,
        "client_api_key_id": 1,
        "client_api_key_name": "fixture-client",
        "protocol": "openai_chat",
        "endpoint": "/v1/chat/completions",
        "route_attempts": "[]",
        "stat_eligible": stat_eligible,
        "estimated_cost": 0.1,
        "pricing_snapshot": "{}",
        "cost_source": "test",
        "billable_tokens": 6,
    }


def test_request_writer_is_bounded_and_updates_daily_stats(writer_database):
    for index in range(8):
        db.insert_request(_record(index, latency_ms=10 + index))

    assert db.flush_pending_writes(5)
    writer_threads = [
        thread for thread in threading.enumerate() if thread.name == "heimdall-db-writer"
    ]
    assert len(writer_threads) == 1

    with sqlite3.connect(writer_database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 8
        daily = connection.execute(
            "SELECT total_requests, total_tokens, avg_latency_ms "
            "FROM daily_stats WHERE date = ?",
            ("2026-08-14",),
        ).fetchone()
    assert daily == (8, 48, 13.5)


def test_ineligible_request_is_stored_without_daily_aggregation(writer_database):
    db._do_insert(_record(1, stat_eligible=0))

    with sqlite3.connect(writer_database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM daily_stats").fetchone()[0] == 0


def test_writer_retries_transient_sqlite_lock(writer_database, monkeypatch):
    original_increment = db._increment_daily_stats
    calls = {"count": 0}

    def fail_once(connection, record, target_date):
        calls["count"] += 1
        if calls["count"] == 1:
            raise sqlite3.OperationalError("database is locked")
        return original_increment(connection, record, target_date)

    monkeypatch.setattr(db, "_increment_daily_stats", fail_once)
    db._do_insert(_record(1))

    assert calls["count"] == 2
    with sqlite3.connect(writer_database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 1
        assert connection.execute(
            "SELECT total_requests FROM daily_stats WHERE date = ?",
            ("2026-08-14",),
        ).fetchone() == (1,)


def test_daily_stats_zero_fill_requested_date_range(writer_database):
    db._do_insert(_record(1))

    rows = db.query_daily("2026-08-13", "2026-08-15")

    assert [row["date"] for row in rows] == [
        "2026-08-13", "2026-08-14", "2026-08-15"
    ]
    assert rows[0]["total_requests"] == 0
    assert rows[1]["total_requests"] == 1
    assert rows[2]["total_requests"] == 0


def test_daily_stats_all_range_clamps_zero_fill_to_actual_data(writer_database):
    first = _record(1)
    first["date"] = "2026-08-08"
    second = _record(2)
    second["date"] = "2026-08-10"
    db._do_insert(first)
    db._do_insert(second)

    rows = db.query_daily("0001-01-01", "9999-12-31")

    assert [row["date"] for row in rows] == [
        "2026-08-08", "2026-08-09", "2026-08-10"
    ]


def test_request_filter_options_are_usable_before_auth_schema(writer_database):
    # The filter endpoint is also used by isolated migration checks where the
    # auth table may not have been created yet.
    db._do_insert(_record(1))
    options = db.query_request_filter_options()
    assert options["providers"] == ["fixture"]
    assert options["protocols"] == ["openai_chat"]
    assert options["client_keys"] == [
        {"id": 1, "name": "fixture-client", "is_deleted": True}
    ]
    request_page = db.query_requests(1, 20, {"provider": "fixture"})
    assert request_page["total"] == 1
    assert request_page["items"][0]["api_key_name"] == "fixture-client"

    with sqlite3.connect(writer_database) as connection:
        connection.execute("CREATE TABLE api_keys (id INTEGER PRIMARY KEY, name TEXT)")
        connection.execute("INSERT INTO api_keys(id, name) VALUES (1, 'fixture-client')")
        connection.commit()
    options = db.query_request_filter_options()
    assert options["client_keys"] == [
        {"id": 1, "name": "fixture-client", "is_deleted": False}
    ]


def test_request_without_client_key_uses_explicit_unassigned_label(writer_database):
    record = _record(99)
    record["api_key_id"] = None
    record["client_api_key_id"] = None
    record["client_api_key_name"] = None
    db._do_insert(record)

    request_page = db.query_requests(1, 20)

    assert request_page["total"] == 1
    assert request_page["items"][0]["api_key_name"] == "未关联 API Key"


def test_stats_keep_unassigned_key_without_auth_table(writer_database):
    record = _record(100)
    record["api_key_id"] = None
    record["client_api_key_id"] = None
    record["client_api_key_name"] = None
    db._do_insert(record)

    costs = db.query_cost_stats("2026-08-14", "2026-08-14")
    usage = db.query_api_key_stats("2026-08-14", "2026-08-14")
    model_usage = db.query_api_key_model_stats("2026-08-14", "2026-08-14")
    daily_usage = db.query_api_key_daily("2026-08-14", "2026-08-14")

    assert costs["by_client_key"][0]["name"] == "未关联 API Key"
    assert costs["by_client_key"][0]["is_deleted"] is False
    assert usage[0]["api_key_name"] == "未关联 API Key"
    assert usage[0]["api_key_id"] is None
    assert usage[0]["api_key_deleted"] is False
    assert model_usage[0]["api_key_name"] == "未关联 API Key"
    assert daily_usage[0]["api_key_name"] == "未关联 API Key"
