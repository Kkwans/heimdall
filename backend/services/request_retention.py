"""Request-record retention configuration, preview, and scheduled cleanup."""

from __future__ import annotations

import logging
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional


CST = timezone(timedelta(hours=8))
BUSY_TIMEOUT_MS = 30_000
DEFAULT_RETENTION_DAYS = 30
MIN_RETENTION_DAYS = 1
MAX_RETENTION_DAYS = 3650
PREVIEW_TOKEN_TTL_SECONDS = 300
LOCK_NAME = "request-retention"
LOCK_TTL_SECONDS = 3600


class RetentionError(RuntimeError):
    """Base error for request-retention operations."""


class RetentionValidationError(RetentionError):
    """Raised for invalid retention settings."""


class RetentionConfirmationError(RetentionError):
    """Raised when enabling cleanup without a matching preview."""


def validate_retention_days(value: object) -> int:
    if isinstance(value, bool):
        raise RetentionValidationError("retention_days 必须为整数")
    try:
        days = int(value)
    except (TypeError, ValueError) as exc:
        raise RetentionValidationError("retention_days 必须为整数") from exc
    if not MIN_RETENTION_DAYS <= days <= MAX_RETENTION_DAYS:
        raise RetentionValidationError("retention_days 必须在 1-3650 之间")
    return days


def retention_cutoff(retention_days: int, today: Optional[date] = None) -> date:
    """Return the first retained calendar date, including today in the window."""
    days = validate_retention_days(retention_days)
    current = today or datetime.now(CST).date()
    return current - timedelta(days=days - 1)


class RequestRetentionService:
    def __init__(
        self,
        database_path: str,
        *,
        batch_size: int = 500,
        token_ttl_seconds: int = PREVIEW_TOKEN_TTL_SECONDS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.database_path = str(Path(database_path).expanduser().resolve())
        self.batch_size = max(1, min(int(batch_size), 5000))
        self.token_ttl_seconds = max(30, int(token_ttl_seconds))
        self._monotonic = monotonic
        self._tokens: dict[str, tuple[float, tuple[int, str, int, int]]] = {}
        self._token_lock = threading.Lock()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.database_path,
            timeout=BUSY_TIMEOUT_MS / 1000,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        connection.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @staticmethod
    def _require_schema(connection: sqlite3.Connection) -> None:
        row = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' "
            "AND name='request_retention_settings'"
        ).fetchone()
        if not row:
            raise RetentionError("请求保留 schema 尚未迁移")

    def get_config(self) -> dict:
        with self._connect() as connection:
            self._require_schema(connection)
            row = connection.execute(
                "SELECT enabled, retention_days, updated_at, last_run_at, "
                "last_deleted_count, last_deleted_body_bytes, last_error "
                "FROM request_retention_settings WHERE id = 1"
            ).fetchone()
        if not row:
            raise RetentionError("请求保留配置缺失")
        return {
            "enabled": bool(row["enabled"]),
            "retention_days": int(row["retention_days"]),
            "updated_at": row["updated_at"],
            "last_run_at": row["last_run_at"],
            "last_deleted_count": int(row["last_deleted_count"] or 0),
            "last_deleted_body_bytes": int(row["last_deleted_body_bytes"] or 0),
            "last_error": row["last_error"],
        }

    @staticmethod
    def _preview_values(
        connection: sqlite3.Connection,
        days: int,
        current_date: date,
    ) -> dict:
        cutoff = retention_cutoff(days, current_date).isoformat()
        row = connection.execute(
            """
            SELECT
                COUNT(*) AS request_count,
                COALESCE(SUM(length(CAST(COALESCE(request_body, '') AS BLOB))), 0)
                    AS request_body_bytes,
                COALESCE(SUM(length(CAST(COALESCE(response_body, '') AS BLOB))), 0)
                    AS response_body_bytes,
                COUNT(DISTINCT date) AS affected_dates
            FROM requests
            WHERE date < ?
            """,
            (cutoff,),
        ).fetchone()
        daily_stats_count = connection.execute(
            "SELECT COUNT(*) FROM daily_stats WHERE date < ?",
            (cutoff,),
        ).fetchone()[0]
        request_bytes = int(row["request_body_bytes"] or 0)
        response_bytes = int(row["response_body_bytes"] or 0)
        return {
            "retention_days": days,
            "cutoff_date": cutoff,
            "request_count": int(row["request_count"] or 0),
            "request_body_bytes": request_bytes,
            "response_body_bytes": response_bytes,
            "total_body_bytes": request_bytes + response_bytes,
            "affected_dates": int(row["affected_dates"] or 0),
            "daily_stats_count": int(daily_stats_count or 0),
        }

    def _prune_tokens(self) -> None:
        now = self._monotonic()
        expired = [token for token, item in self._tokens.items() if item[0] <= now]
        for token in expired:
            self._tokens.pop(token, None)

    def preview(self, retention_days: object, *, today: Optional[date] = None) -> dict:
        days = validate_retention_days(retention_days)
        current_date = today or datetime.now(CST).date()
        with self._connect() as connection:
            self._require_schema(connection)
            values = self._preview_values(connection, days, current_date)
        token = secrets.token_urlsafe(24)
        fingerprint = (
            days,
            values["cutoff_date"],
            values["request_count"],
            values["total_body_bytes"],
        )
        with self._token_lock:
            self._prune_tokens()
            self._tokens[token] = (
                self._monotonic() + self.token_ttl_seconds,
                fingerprint,
            )
        return {
            **values,
            "confirmation_token": token,
            "confirmation_expires_in": self.token_ttl_seconds,
        }

    def _consume_confirmation(
        self,
        token: object,
        *,
        days: int,
        today: date,
    ) -> None:
        if not isinstance(token, str) or not token:
            raise RetentionConfirmationError("启用自动清理前必须先预览并确认")
        with self._token_lock:
            self._prune_tokens()
            stored = self._tokens.pop(token, None)
        if not stored:
            raise RetentionConfirmationError("预览确认已失效，请重新预览")

        with self._connect() as connection:
            self._require_schema(connection)
            current = self._preview_values(connection, days, today)
        fingerprint = (
            days,
            current["cutoff_date"],
            current["request_count"],
            current["total_body_bytes"],
        )
        if stored[1] != fingerprint:
            raise RetentionConfirmationError("待清理数据已变化，请重新预览")

    def update_config(
        self,
        *,
        enabled: object,
        retention_days: object,
        confirmation_token: object = None,
        today: Optional[date] = None,
    ) -> dict:
        if not isinstance(enabled, bool):
            raise RetentionValidationError("enabled 必须为布尔值")
        days = validate_retention_days(retention_days)
        current_date = today or datetime.now(CST).date()
        if enabled:
            self._consume_confirmation(
                confirmation_token,
                days=days,
                today=current_date,
            )

        with self._connect() as connection:
            self._require_schema(connection)
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    "UPDATE request_retention_settings SET "
                    "enabled = ?, retention_days = ?, updated_at = CURRENT_TIMESTAMP "
                    "WHERE id = 1",
                    (int(enabled), days),
                )
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        return self.get_config()

    def _acquire_lock(self, owner: str, now: datetime) -> bool:
        expires_at = now.timestamp() + LOCK_TTL_SECONDS
        now_timestamp = now.timestamp()
        with self._connect() as connection:
            self._require_schema(connection)
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """
                    INSERT INTO maintenance_locks (name, owner, expires_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(name) DO UPDATE SET
                        owner = excluded.owner,
                        expires_at = excluded.expires_at
                    WHERE maintenance_locks.expires_at <= ?
                    """,
                    (LOCK_NAME, owner, expires_at, now_timestamp),
                )
                row = connection.execute(
                    "SELECT owner FROM maintenance_locks WHERE name = ?",
                    (LOCK_NAME,),
                ).fetchone()
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        return bool(row and row["owner"] == owner)

    def _release_lock(self, owner: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM maintenance_locks WHERE name = ? AND owner = ?",
                (LOCK_NAME, owner),
            )

    def _renew_lock(self, owner: str) -> bool:
        """Extend a cleanup lock, failing closed if ownership was lost."""
        expires_at = datetime.now(CST).timestamp() + LOCK_TTL_SECONDS
        with self._connect() as connection:
            cursor = connection.execute(
                "UPDATE maintenance_locks SET expires_at = ? "
                "WHERE name = ? AND owner = ?",
                (expires_at, LOCK_NAME, owner),
            )
        return cursor.rowcount == 1

    def run_cleanup(self, *, now: Optional[datetime] = None) -> dict:
        current = now or datetime.now(CST)
        config_value = self.get_config()
        if not config_value["enabled"]:
            return {"ran": False, "reason": "disabled", "deleted_count": 0}

        owner = str(uuid.uuid4())
        if not self._acquire_lock(owner, current):
            return {"ran": False, "reason": "locked", "deleted_count": 0}

        deleted_count = 0
        preview = None
        cutoff = retention_cutoff(
            config_value["retention_days"], current.astimezone(CST).date()
        ).isoformat()
        try:
            with self._connect() as connection:
                preview = self._preview_values(
                    connection,
                    config_value["retention_days"],
                    current.astimezone(CST).date(),
                )

            while True:
                if not self._renew_lock(owner):
                    raise RetentionError("请求保留任务锁已失效，已停止清理")
                with self._connect() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    try:
                        rows = connection.execute(
                            "SELECT id FROM requests WHERE date < ? "
                            "ORDER BY id LIMIT ?",
                            (cutoff, self.batch_size),
                        ).fetchall()
                        ids = [int(row["id"]) for row in rows]
                        if not ids:
                            connection.commit()
                            break
                        placeholders = ",".join("?" for _ in ids)
                        connection.execute(
                            f"DELETE FROM requests WHERE id IN ({placeholders})",
                            ids,
                        )
                        connection.commit()
                        deleted_count += len(ids)
                    except Exception:
                        connection.rollback()
                        raise

            with self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    connection.execute("DELETE FROM daily_stats WHERE date < ?", (cutoff,))
                    connection.execute(
                        "UPDATE request_retention_settings SET "
                        "last_run_at = ?, last_deleted_count = ?, "
                        "last_deleted_body_bytes = ?, last_error = NULL "
                        "WHERE id = 1",
                        (
                            current.isoformat(),
                            deleted_count,
                            int(preview["total_body_bytes"] if preview else 0),
                        ),
                    )
                    connection.commit()
                except Exception:
                    connection.rollback()
                    raise
            return {
                "ran": True,
                "reason": "completed",
                "cutoff_date": cutoff,
                "deleted_count": deleted_count,
                "deleted_body_bytes": int(preview["total_body_bytes"] if preview else 0),
            }
        except Exception as exc:
            try:
                with self._connect() as connection:
                    connection.execute(
                        "UPDATE request_retention_settings SET last_run_at = ?, last_error = ? "
                        "WHERE id = 1",
                        (current.isoformat(), str(exc)[:500]),
                    )
            finally:
                raise
        finally:
            self._release_lock(owner)


_worker_guard = threading.Lock()
_worker_started = False


def _seconds_until_next_run(now: datetime) -> float:
    local_now = now.astimezone(CST)
    next_run = datetime.combine(
        local_now.date(),
        datetime_time(hour=0, minute=15),
        tzinfo=CST,
    )
    if next_run <= local_now:
        next_run += timedelta(days=1)
    return max(1.0, (next_run - local_now).total_seconds())


def start_retention_worker(
    service: RequestRetentionService,
    *,
    logger: Optional[logging.Logger] = None,
) -> bool:
    """Start the one explicit Dashboard worker; return False if already started."""
    global _worker_started
    with _worker_guard:
        if _worker_started:
            return False
        _worker_started = True

    worker_logger = logger or logging.getLogger("system")

    def _run() -> None:
        while True:
            delay = _seconds_until_next_run(datetime.now(CST))
            time.sleep(delay)
            try:
                result = service.run_cleanup()
                if result.get("ran"):
                    worker_logger.info(
                        "请求保留任务完成: deleted=%s cutoff=%s",
                        result.get("deleted_count"),
                        result.get("cutoff_date"),
                    )
            except Exception as exc:
                worker_logger.error("请求保留任务失败: %s", exc)

    threading.Thread(
        target=_run,
        daemon=True,
        name="request-retention-worker",
    ).start()
    return True
