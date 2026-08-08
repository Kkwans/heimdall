import sqlite3
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from migrations import (
    MIGRATIONS,
    Migration,
    MigrationError,
    apply_migrations,
    backup_database,
    create_timestamped_backup,
    inspect_database,
    main,
)


FIXTURE_SQL = Path(__file__).parent / "fixtures" / "legacy_schema.sql"


def _create_legacy_database(path: Path) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.executescript(FIXTURE_SQL.read_text(encoding="utf-8"))
        connection.commit()
    finally:
        connection.close()


def test_empty_database_migration_is_idempotent(tmp_path: Path) -> None:
    database = tmp_path / "empty.db"

    first = apply_migrations(database)
    second = apply_migrations(database)

    assert first.previous_version == 0
    assert first.current_version == 2
    assert first.applied_versions == (1, 2)
    assert second.previous_version == 2
    assert second.current_version == 2
    assert second.applied_versions == ()
    assert inspect_database(database).integrity == "ok"


def test_legacy_database_is_backed_up_before_migration(tmp_path: Path) -> None:
    database = tmp_path / "legacy.db"
    backup_dir = tmp_path / "backups"
    _create_legacy_database(database)

    backup = create_timestamped_backup(database, backup_dir)
    result = apply_migrations(database)

    assert backup.integrity == "ok"
    assert Path(backup.database).parent == backup_dir
    assert result.current_version == 2
    with sqlite3.connect(database) as connection:
        row = connection.execute("SELECT model FROM requests").fetchone()
        migrated_key = connection.execute(
            "SELECT api_key FROM provider_api_keys WHERE provider_id = 1"
        ).fetchone()
    assert row == ("fixture-model",)
    assert migrated_key == ("fixture-not-a-secret",)


def test_failed_migration_rolls_back_schema_and_version(tmp_path: Path) -> None:
    database = tmp_path / "rollback.db"
    apply_migrations(database)

    def fail_after_schema_change(connection: sqlite3.Connection) -> None:
        connection.execute("CREATE TABLE must_be_rolled_back (id INTEGER)")
        raise RuntimeError("injected migration failure")

    migrations = (*MIGRATIONS, Migration(3, "injected_failure", fail_after_schema_change))
    with pytest.raises(RuntimeError, match="injected migration failure"):
        apply_migrations(database, migrations=migrations)

    with sqlite3.connect(database) as connection:
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='must_be_rolled_back'"
        ).fetchone()
        version = connection.execute("SELECT MAX(version) FROM schema_versions").fetchone()[0]
    assert table is None
    assert version == 2


def test_backup_never_overwrites_existing_file(tmp_path: Path) -> None:
    database = tmp_path / "source.db"
    destination = tmp_path / "backup.db"
    _create_legacy_database(database)
    destination.write_text("preserve-me", encoding="utf-8")

    with pytest.raises(FileExistsError):
        backup_database(database, destination)

    assert destination.read_text(encoding="utf-8") == "preserve-me"


def test_unknown_schema_version_is_rejected(tmp_path: Path) -> None:
    database = tmp_path / "future.db"
    apply_migrations(database)
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO schema_versions (version, name) VALUES (99, 'future_version')"
        )
        connection.commit()

    with pytest.raises(MigrationError, match="未知的迁移版本"):
        apply_migrations(database)


def test_cli_requires_backup_directory_for_existing_database(tmp_path: Path) -> None:
    database = tmp_path / "existing.db"
    _create_legacy_database(database)

    with pytest.raises(MigrationError, match="必须提供 --backup-dir"):
        main(["migrate", "--database", str(database)])


def test_admin_migration_deduplicates_encrypted_legacy_key_and_backfills_pricing(
    tmp_path: Path,
) -> None:
    database = tmp_path / "heimdall.db"
    key = Fernet.generate_key()
    (tmp_path / ".encryption_key").write_bytes(key)
    fernet = Fernet(key)
    legacy_secret = "provider-secret-for-migration"

    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE providers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                base_url TEXT NOT NULL,
                api_key TEXT NOT NULL
            );
            CREATE TABLE provider_api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_id INTEGER NOT NULL,
                api_key TEXT NOT NULL,
                priority INTEGER DEFAULT 0,
                enabled BOOLEAN DEFAULT 1,
                last_used_at DATETIME,
                last_error_at DATETIME,
                error_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
            );
            CREATE TABLE models (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_id INTEGER NOT NULL,
                model_name TEXT NOT NULL UNIQUE,
                price_input REAL DEFAULT 0,
                price_output REAL DEFAULT 0,
                price_cache_read REAL DEFAULT 0,
                price_cache_write REAL DEFAULT 0
            );
            """
        )
        legacy_ciphertext = fernet.encrypt(legacy_secret.encode()).decode()
        duplicate_ciphertext = fernet.encrypt(legacy_secret.encode()).decode()
        connection.execute(
            "INSERT INTO providers (name, base_url, api_key) VALUES (?, ?, ?)",
            ("encrypted-provider", "https://example.com", legacy_ciphertext),
        )
        connection.execute(
            "INSERT INTO provider_api_keys (provider_id, api_key, priority) VALUES (1, ?, 10)",
            (duplicate_ciphertext,),
        )
        connection.execute(
            "INSERT INTO models (provider_id, model_name, price_input) VALUES (1, 'paid-model', 1.5)"
        )
        connection.execute(
            "INSERT INTO models (provider_id, model_name) VALUES (1, 'unknown-model')"
        )
        connection.commit()

    result = apply_migrations(database)

    assert result.current_version == 2
    with sqlite3.connect(database) as connection:
        key_count = connection.execute(
            "SELECT COUNT(*) FROM provider_api_keys WHERE provider_id = 1"
        ).fetchone()[0]
        pricing = dict(
            connection.execute(
                "SELECT model_name, pricing_configured FROM models ORDER BY model_name"
            ).fetchall()
        )
        route_index = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='index' "
            "AND name='idx_provider_api_keys_route'"
        ).fetchone()
    assert key_count == 1
    assert pricing == {"paid-model": 1, "unknown-model": 0}
    assert route_index == (1,)
