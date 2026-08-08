import sqlite3
from datetime import date, datetime
from pathlib import Path

import pytest

import config
import db
from migrations import apply_migrations
from services.request_retention import (
    CST,
    RequestRetentionService,
    RetentionConfirmationError,
    RetentionError,
    RetentionValidationError,
    _seconds_until_next_run,
    retention_cutoff,
)


def _close_thread_connection() -> None:
    connection = getattr(db._local, "conn", None)
    if connection is not None:
        connection.close()
    db._local.conn = None


@pytest.fixture
def retention_database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    _close_thread_connection()
    database = tmp_path / "heimdall.db"
    monkeypatch.setattr(config, "DB_PATH", str(database))
    db.init_db()
    _close_thread_connection()
    apply_migrations(database)

    with sqlite3.connect(database) as connection:
        rows = [
            ("2026-06-01", "old-a", '{"prompt":"a"}', '{"answer":"a"}'),
            ("2026-06-02", "old-b", '{"prompt":"中文"}', '{"answer":"中文"}'),
            ("2026-08-08", "current", '{"prompt":"keep"}', '{"answer":"keep"}'),
        ]
        connection.executemany(
            "INSERT INTO requests (date, model, request_body, response_body) "
            "VALUES (?, ?, ?, ?)",
            rows,
        )
        connection.executemany(
            "INSERT INTO daily_stats (date, total_requests) VALUES (?, ?)",
            [("2026-06-01", 1), ("2026-06-02", 1), ("2026-08-08", 1)],
        )
        connection.commit()
    yield database
    _close_thread_connection()


def test_cutoff_includes_today_in_retention_window() -> None:
    assert retention_cutoff(1, date(2026, 8, 8)) == date(2026, 8, 8)
    assert retention_cutoff(30, date(2026, 8, 8)) == date(2026, 7, 10)


def test_worker_schedules_today_before_run_time_and_tomorrow_afterwards() -> None:
    before = datetime(2026, 8, 8, 0, 10, tzinfo=CST)
    after = datetime(2026, 8, 8, 0, 20, tzinfo=CST)

    assert _seconds_until_next_run(before) == 5 * 60
    assert _seconds_until_next_run(after) == 23 * 60 * 60 + 55 * 60


@pytest.mark.parametrize("value", [0, 3651, True, "invalid", None])
def test_invalid_retention_days_are_rejected(value) -> None:
    with pytest.raises(RetentionValidationError):
        retention_cutoff(value, date(2026, 8, 8))


def test_preview_requires_confirmation_and_save_does_not_delete(
    retention_database: Path,
) -> None:
    service = RequestRetentionService(str(retention_database), batch_size=1)
    assert service.get_config()["enabled"] is False

    preview = service.preview(30, today=date(2026, 8, 8))
    assert preview["request_count"] == 2
    assert preview["affected_dates"] == 2
    assert preview["daily_stats_count"] == 2
    assert preview["total_body_bytes"] > 0

    with pytest.raises(RetentionConfirmationError):
        service.update_config(
            enabled=True,
            retention_days=30,
            today=date(2026, 8, 8),
        )

    updated = service.update_config(
        enabled=True,
        retention_days=30,
        confirmation_token=preview["confirmation_token"],
        today=date(2026, 8, 8),
    )
    assert updated["enabled"] is True
    with sqlite3.connect(retention_database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 3


def test_cleanup_is_batched_and_removes_matching_daily_stats(
    retention_database: Path,
) -> None:
    service = RequestRetentionService(str(retention_database), batch_size=1)
    preview = service.preview(30, today=date(2026, 8, 8))
    service.update_config(
        enabled=True,
        retention_days=30,
        confirmation_token=preview["confirmation_token"],
        today=date(2026, 8, 8),
    )

    result = service.run_cleanup(now=datetime(2026, 8, 8, 12, tzinfo=CST))

    assert result["ran"] is True
    assert result["deleted_count"] == 2
    assert result["deleted_body_bytes"] == preview["total_body_bytes"]
    with sqlite3.connect(retention_database) as connection:
        requests = connection.execute(
            "SELECT date, model FROM requests ORDER BY id"
        ).fetchall()
        daily = connection.execute(
            "SELECT date FROM daily_stats ORDER BY date"
        ).fetchall()
        config_row = connection.execute(
            "SELECT last_deleted_count, last_error FROM request_retention_settings"
        ).fetchone()
    assert requests == [("2026-08-08", "current")]
    assert daily == [("2026-08-08",)]
    assert config_row == (2, None)


def test_unexpired_maintenance_lock_prevents_duplicate_cleanup(
    retention_database: Path,
) -> None:
    service = RequestRetentionService(str(retention_database))
    preview = service.preview(30, today=date(2026, 8, 8))
    service.update_config(
        enabled=True,
        retention_days=30,
        confirmation_token=preview["confirmation_token"],
        today=date(2026, 8, 8),
    )
    now = datetime(2026, 8, 8, 12, tzinfo=CST)
    with sqlite3.connect(retention_database) as connection:
        connection.execute(
            "INSERT INTO maintenance_locks (name, owner, expires_at) VALUES (?, ?, ?)",
            ("request-retention", "another-worker", now.timestamp() + 600),
        )
        connection.commit()

    result = service.run_cleanup(now=now)

    assert result == {"ran": False, "reason": "locked", "deleted_count": 0}
    with sqlite3.connect(retention_database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 3


def test_cleanup_stops_if_maintenance_lock_ownership_is_lost(
    retention_database: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = RequestRetentionService(str(retention_database), batch_size=1)
    preview = service.preview(30, today=date(2026, 8, 8))
    service.update_config(
        enabled=True,
        retention_days=30,
        confirmation_token=preview["confirmation_token"],
        today=date(2026, 8, 8),
    )
    monkeypatch.setattr(service, "_renew_lock", lambda _owner: False)

    with pytest.raises(RetentionError, match="任务锁已失效"):
        service.run_cleanup(now=datetime(2026, 8, 8, 12, tzinfo=CST))

    with sqlite3.connect(retention_database) as connection:
        assert connection.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 3


def test_preview_confirmation_expires(retention_database: Path) -> None:
    clock = [0.0]
    service = RequestRetentionService(
        str(retention_database),
        token_ttl_seconds=30,
        monotonic=lambda: clock[0],
    )
    preview = service.preview(30, today=date(2026, 8, 8))
    clock[0] = 31.0

    with pytest.raises(RetentionConfirmationError, match="失效"):
        service.update_config(
            enabled=True,
            retention_days=30,
            confirmation_token=preview["confirmation_token"],
            today=date(2026, 8, 8),
        )
