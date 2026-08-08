"""Heimdall SQLite schema migration and backup utilities.

The module deliberately requires callers to provide a database path. Production
deployment code can therefore perform a verified backup before applying changes,
while tests and isolated environments can use disposable databases explicitly.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Optional, Sequence


SCHEMA_VERSIONS_TABLE = "schema_versions"
BUSY_TIMEOUT_MS = 30_000


class MigrationError(RuntimeError):
    """Raised when a database cannot be migrated safely."""


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    apply: Callable[[sqlite3.Connection], None]


@dataclass(frozen=True)
class MigrationResult:
    database: str
    previous_version: int
    current_version: int
    applied_versions: tuple[int, ...]
    integrity: str


@dataclass(frozen=True)
class DatabaseReport:
    database: str
    size_bytes: int
    integrity: str
    schema_version: int
    table_count: int


def _baseline_schema_versions(_connection: sqlite3.Connection) -> None:
    """Version 1 only establishes the migration ledger itself."""


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone() is not None


def _column_exists(connection: sqlite3.Connection, table: str, column: str) -> bool:
    return any(
        str(row[1]) == column
        for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
    )


def _database_directory(connection: sqlite3.Connection) -> Path:
    row = connection.execute("PRAGMA database_list").fetchone()
    if not row or not row[2]:
        raise MigrationError("无法确定数据库目录")
    return Path(str(row[2])).resolve().parent


def _decode_stored_secret(connection: sqlite3.Connection, stored_value: str) -> str:
    """仅用于迁移去重；不会把明文写入迁移表或日志。"""
    if not stored_value or not stored_value.startswith("gAAAAA"):
        return stored_value or ""

    key_path = _database_directory(connection) / ".encryption_key"
    if not key_path.is_file():
        raise MigrationError("legacy Provider Key 已加密，但数据库目录缺少 .encryption_key")

    try:
        from cryptography.fernet import Fernet

        return Fernet(key_path.read_bytes()).decrypt(
            stored_value.encode("utf-8")
        ).decode("utf-8")
    except Exception as exc:
        raise MigrationError("无法解密 legacy Provider Key，迁移已停止") from exc


def _migrate_admin_secrets_and_pricing(connection: sqlite3.Connection) -> None:
    """建立 Provider Key 单一来源，并区分未知价格与免费价格。"""
    if _table_exists(connection, "providers"):
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS provider_api_keys (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_id   INTEGER NOT NULL,
                api_key       VARCHAR(512) NOT NULL,
                priority      INTEGER DEFAULT 0,
                enabled       BOOLEAN DEFAULT 1,
                last_used_at  DATETIME,
                last_error_at DATETIME,
                error_count   INTEGER DEFAULT 0,
                created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_provider_api_keys_route "
            "ON provider_api_keys(provider_id, enabled, priority DESC, id ASC)"
        )

        if _column_exists(connection, "providers", "api_key"):
            providers = connection.execute(
                "SELECT id, api_key FROM providers WHERE api_key IS NOT NULL AND api_key <> ''"
            ).fetchall()
            for provider_id, legacy_stored in providers:
                legacy_plaintext = _decode_stored_secret(connection, str(legacy_stored))
                existing = connection.execute(
                    "SELECT api_key, priority FROM provider_api_keys "
                    "WHERE provider_id = ? ORDER BY priority DESC, id ASC",
                    (provider_id,),
                ).fetchall()
                existing_plaintexts = {
                    _decode_stored_secret(connection, str(row[0])) for row in existing
                }
                if legacy_plaintext in existing_plaintexts:
                    continue
                lowest_priority = min([int(row[1] or 0) for row in existing] + [0])
                connection.execute(
                    "INSERT INTO provider_api_keys "
                    "(provider_id, api_key, priority, enabled) VALUES (?, ?, ?, 1)",
                    (provider_id, legacy_stored, lowest_priority),
                )

    if _table_exists(connection, "models"):
        if not _column_exists(connection, "models", "pricing_configured"):
            connection.execute(
                "ALTER TABLE models ADD COLUMN "
                "pricing_configured BOOLEAN NOT NULL DEFAULT 0"
            )
        price_columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(models)").fetchall()
        }
        known_price_columns = [
            column
            for column in (
                "price_input",
                "price_output",
                "price_cache_read",
                "price_cache_write",
            )
            if column in price_columns
        ]
        if known_price_columns:
            nonzero = " OR ".join(
                f"COALESCE({column}, 0) <> 0" for column in known_price_columns
            )
            connection.execute(
                f"UPDATE models SET pricing_configured = 1 WHERE {nonzero}"
            )


def _migrate_routing_and_request_records(connection: sqlite3.Connection) -> None:
    """Add Key health state and the unified request-recording contract."""
    if _table_exists(connection, "provider_api_keys"):
        for column, definition in (
            ("cooldown_until", "DATETIME"),
            ("last_error_summary", "TEXT"),
        ):
            if not _column_exists(connection, "provider_api_keys", column):
                connection.execute(
                    f"ALTER TABLE provider_api_keys ADD COLUMN {column} {definition}"
                )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_provider_api_keys_route "
            "ON provider_api_keys(provider_id, enabled, priority DESC, id ASC)"
        )

    if not _table_exists(connection, "requests"):
        return

    request_columns = (
        ("provider_id", "INTEGER"),
        ("provider_api_key_id", "INTEGER"),
        ("client_api_key_id", "INTEGER"),
        ("protocol", "TEXT"),
        ("endpoint", "TEXT"),
        ("route_attempts", "TEXT"),
        ("stat_eligible", "BOOLEAN NOT NULL DEFAULT 1"),
    )
    for column, definition in request_columns:
        if not _column_exists(connection, "requests", column):
            connection.execute(
                f"ALTER TABLE requests ADD COLUMN {column} {definition}"
            )

    if _column_exists(connection, "requests", "api_key_id"):
        connection.execute(
            "UPDATE requests SET client_api_key_id = api_key_id "
            "WHERE client_api_key_id IS NULL AND api_key_id IS NOT NULL"
        )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_requests_provider_id ON requests(provider_id)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_requests_provider_api_key_id "
        "ON requests(provider_api_key_id)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_requests_stat_date "
        "ON requests(stat_eligible, date)"
    )


def _migrate_request_retention(connection: sqlite3.Connection) -> None:
    """Add disabled-by-default request retention and maintenance locking."""
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS request_retention_settings (
            id                       INTEGER PRIMARY KEY CHECK (id = 1),
            enabled                  BOOLEAN NOT NULL DEFAULT 0
                                     CHECK (enabled IN (0, 1)),
            retention_days           INTEGER NOT NULL DEFAULT 30
                                     CHECK (retention_days BETWEEN 1 AND 3650),
            updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_run_at              TEXT,
            last_deleted_count       INTEGER NOT NULL DEFAULT 0,
            last_deleted_body_bytes  INTEGER NOT NULL DEFAULT 0,
            last_error               TEXT
        )
        """
    )
    connection.execute(
        """
        INSERT OR IGNORE INTO request_retention_settings
            (id, enabled, retention_days)
        VALUES (1, 0, 30)
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS maintenance_locks (
            name        TEXT PRIMARY KEY,
            owner       TEXT NOT NULL,
            expires_at  REAL NOT NULL
        )
        """
    )
    if _table_exists(connection, "requests"):
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_requests_retention_date_id "
            "ON requests(date, id)"
        )


def _historical_pricing_for_request(
    connection: sqlite3.Connection,
    *,
    model_name: str,
    provider_id: Optional[int],
    provider_name: str,
):
    """Return pricing only when an old request can be matched unambiguously."""
    select_sql = """
        SELECT m.id AS model_id, m.provider_id, m.model_name,
               m.price_input, m.price_output,
               m.price_cache_read, m.price_cache_write
        FROM models m
        JOIN providers p ON p.id = m.provider_id
        WHERE m.model_name = ? AND COALESCE(m.pricing_configured, 0) = 1
    """
    params: list[object] = [model_name]
    if provider_id is not None:
        select_sql += " AND m.provider_id = ?"
        params.append(provider_id)
    elif provider_name:
        select_sql += " AND p.name = ?"
        params.append(provider_name)
    rows = connection.execute(select_sql, params).fetchall()
    return rows[0] if len(rows) == 1 else None


def _migrate_request_costs(connection: sqlite3.Connection) -> None:
    """Add immutable request cost snapshots and backfill provable history."""
    if not _table_exists(connection, "requests"):
        return

    for column, definition in (
        ("estimated_cost", "REAL"),
        ("pricing_snapshot", "TEXT"),
        ("cost_source", "TEXT"),
        ("billable_tokens", "INTEGER"),
    ):
        if not _column_exists(connection, "requests", column):
            connection.execute(f"ALTER TABLE requests ADD COLUMN {column} {definition}")
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_requests_cost_date "
        "ON requests(stat_eligible, date, estimated_cost)"
    )

    required_tables = {"models", "providers"}
    if not all(_table_exists(connection, table) for table in required_tables):
        return

    connection.execute(
        """
        UPDATE requests
        SET billable_tokens = COALESCE(prompt_tokens, 0)
                            + COALESCE(completion_tokens, 0)
        WHERE billable_tokens IS NULL
          AND COALESCE(success, 1) = 1
          AND COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0) > 0
        """
    )

    from services.cost_service import PricingSnapshot, calculate_cost

    rows = connection.execute(
        """
        SELECT id, model, provider_id, COALESCE(provider, '') AS provider,
               prompt_tokens, completion_tokens,
               cache_hit_tokens, cache_miss_tokens
        FROM requests
        WHERE estimated_cost IS NULL
          AND COALESCE(success, 1) = 1
          AND COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0) > 0
        """
    ).fetchall()
    for row in rows:
        pricing_row = _historical_pricing_for_request(
            connection,
            model_name=str(row[1]),
            provider_id=int(row[2]) if row[2] is not None else None,
            provider_name=str(row[3] or ""),
        )
        if pricing_row is None:
            continue
        result = calculate_cost(
            {
                "prompt_tokens": row[4],
                "completion_tokens": row[5],
                "cache_hit_tokens": row[6],
                "cache_miss_tokens": row[7],
            },
            PricingSnapshot.from_mapping(dict(zip(
                ("model_id", "provider_id", "model_name", "price_input", "price_output", "price_cache_read", "price_cache_write"),
                pricing_row,
            ))),
            source="historical_estimate",
        )
        connection.execute(
            """
            UPDATE requests
            SET estimated_cost = ?, pricing_snapshot = ?,
                cost_source = 'historical_estimate', billable_tokens = ?
            WHERE id = ?
            """,
            (result.estimated_cost, result.snapshot_json, result.billable_tokens, row[0]),
        )


MIGRATIONS: tuple[Migration, ...] = (
    Migration(1, "initialize_schema_versions", _baseline_schema_versions),
    Migration(2, "admin_secrets_and_pricing", _migrate_admin_secrets_and_pricing),
    Migration(3, "routing_and_request_records", _migrate_routing_and_request_records),
    Migration(4, "request_retention", _migrate_request_retention),
    Migration(5, "request_costs", _migrate_request_costs),
)


def _normalise_migrations(migrations: Iterable[Migration]) -> tuple[Migration, ...]:
    ordered = tuple(sorted(migrations, key=lambda item: item.version))
    versions = [item.version for item in ordered]
    if not ordered or versions[0] != 1:
        raise MigrationError("迁移必须从版本 1 开始")
    if versions != list(range(1, len(ordered) + 1)):
        raise MigrationError("迁移版本必须连续且不能重复")
    if any(not item.name.strip() for item in ordered):
        raise MigrationError("迁移名称不能为空")
    return ordered


def _connect(database: Path, *, readonly: bool = False) -> sqlite3.Connection:
    if readonly:
        connection = sqlite3.connect(
            f"{database.resolve().as_uri()}?mode=ro",
            uri=True,
            timeout=BUSY_TIMEOUT_MS / 1000,
        )
        connection.execute("PRAGMA query_only=ON")
    else:
        connection = sqlite3.connect(
            str(database),
            timeout=BUSY_TIMEOUT_MS / 1000,
            isolation_level=None,
        )
    connection.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def _integrity_check(connection: sqlite3.Connection) -> str:
    row = connection.execute("PRAGMA integrity_check").fetchone()
    result = str(row[0]) if row else "missing-result"
    if result.lower() != "ok":
        raise MigrationError(f"数据库完整性检查失败: {result}")
    return result


def _read_schema_version(connection: sqlite3.Connection) -> int:
    exists = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (SCHEMA_VERSIONS_TABLE,),
    ).fetchone()
    if not exists:
        return 0
    row = connection.execute(
        f"SELECT COALESCE(MAX(version), 0) FROM {SCHEMA_VERSIONS_TABLE}"
    ).fetchone()
    return int(row[0]) if row else 0


def apply_migrations(
    database_path: os.PathLike[str] | str,
    *,
    migrations: Optional[Sequence[Migration]] = None,
) -> MigrationResult:
    """Apply all known migrations atomically to an explicit database path."""

    database = Path(database_path).expanduser().resolve()
    database.parent.mkdir(parents=True, exist_ok=True)
    known = _normalise_migrations(migrations or MIGRATIONS)
    connection = _connect(database)
    applied_now: list[int] = []

    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {SCHEMA_VERSIONS_TABLE} (
                version     INTEGER PRIMARY KEY,
                name        TEXT NOT NULL,
                applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )

        rows = connection.execute(
            f"SELECT version, name FROM {SCHEMA_VERSIONS_TABLE} ORDER BY version"
        ).fetchall()
        applied = {int(row[0]): str(row[1]) for row in rows}
        known_by_version = {item.version: item for item in known}
        unknown = sorted(set(applied) - set(known_by_version))
        if unknown:
            raise MigrationError(f"数据库包含当前代码未知的迁移版本: {unknown}")

        for version, recorded_name in applied.items():
            expected_name = known_by_version[version].name
            if recorded_name != expected_name:
                raise MigrationError(
                    f"迁移版本 {version} 名称不匹配: "
                    f"database={recorded_name!r}, code={expected_name!r}"
                )

        previous_version = max(applied, default=0)
        for migration in known:
            if migration.version in applied:
                continue
            migration.apply(connection)
            connection.execute(
                f"INSERT INTO {SCHEMA_VERSIONS_TABLE} (version, name) VALUES (?, ?)",
                (migration.version, migration.name),
            )
            applied_now.append(migration.version)

        connection.commit()
        integrity = _integrity_check(connection)
        current_version = _read_schema_version(connection)
        return MigrationResult(
            database=str(database),
            previous_version=previous_version,
            current_version=current_version,
            applied_versions=tuple(applied_now),
            integrity=integrity,
        )
    except Exception:
        if connection.in_transaction:
            connection.rollback()
        raise
    finally:
        connection.close()


def inspect_database(database_path: os.PathLike[str] | str) -> DatabaseReport:
    """Return read-only integrity and schema metadata for a database."""

    database = Path(database_path).expanduser().resolve()
    if not database.is_file():
        raise FileNotFoundError(f"数据库不存在: {database}")
    connection = _connect(database, readonly=True)
    try:
        integrity = _integrity_check(connection)
        table_count = int(
            connection.execute(
                "SELECT COUNT(*) FROM sqlite_master "
                "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            ).fetchone()[0]
        )
        return DatabaseReport(
            database=str(database),
            size_bytes=database.stat().st_size,
            integrity=integrity,
            schema_version=_read_schema_version(connection),
            table_count=table_count,
        )
    finally:
        connection.close()


def backup_database(
    source_path: os.PathLike[str] | str,
    destination_path: os.PathLike[str] | str,
) -> DatabaseReport:
    """Create and verify an online SQLite backup without mutating the source."""

    source = Path(source_path).expanduser().resolve()
    destination = Path(destination_path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"源数据库不存在: {source}")
    if source == destination:
        raise MigrationError("备份目标不能与源数据库相同")
    if destination.exists():
        raise FileExistsError(f"备份目标已存在: {destination}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.partial")
    if temporary.exists():
        raise FileExistsError(f"临时备份文件已存在: {temporary}")

    source_connection = _connect(source, readonly=True)
    destination_connection: Optional[sqlite3.Connection] = None
    try:
        _integrity_check(source_connection)
        destination_connection = sqlite3.connect(str(temporary))
        source_connection.backup(destination_connection)
        destination_connection.commit()
        _integrity_check(destination_connection)
        destination_connection.close()
        destination_connection = None
        os.replace(temporary, destination)
        return inspect_database(destination)
    except Exception:
        if destination_connection is not None:
            destination_connection.close()
        if temporary.exists():
            temporary.unlink()
        raise
    finally:
        source_connection.close()


def create_timestamped_backup(
    source_path: os.PathLike[str] | str,
    backup_directory: os.PathLike[str] | str,
) -> DatabaseReport:
    source = Path(source_path).expanduser().resolve()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    destination = Path(backup_directory).expanduser().resolve() / (
        f"{source.stem}-{timestamp}{source.suffix or '.db'}"
    )
    return backup_database(source, destination)


def _print_json(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Heimdall SQLite 安全迁移工具")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="只读检查数据库")
    inspect_parser.add_argument("--database", required=True)

    backup_parser = subparsers.add_parser("backup", help="创建一致性备份")
    backup_parser.add_argument("--database", required=True)
    backup_parser.add_argument("--backup-dir", required=True)

    migrate_parser = subparsers.add_parser("migrate", help="备份后执行迁移")
    migrate_parser.add_argument("--database", required=True)
    migrate_parser.add_argument("--backup-dir")
    migrate_parser.add_argument(
        "--skip-backup",
        action="store_true",
        help="仅用于一次性临时数据库和隔离测试卷",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "inspect":
        _print_json(asdict(inspect_database(args.database)))
        return 0
    if args.command == "backup":
        _print_json(asdict(create_timestamped_backup(args.database, args.backup_dir)))
        return 0

    database = Path(args.database).expanduser().resolve()
    backup_report = None
    if database.exists() and database.stat().st_size > 0 and not args.skip_backup:
        if not args.backup_dir:
            raise MigrationError("现有数据库迁移前必须提供 --backup-dir")
        backup_report = create_timestamped_backup(database, args.backup_dir)
    result = apply_migrations(database)
    _print_json(
        {
            "backup": asdict(backup_report) if backup_report else None,
            "migration": asdict(result),
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
