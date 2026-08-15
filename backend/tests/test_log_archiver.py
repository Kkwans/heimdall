from pathlib import Path
from datetime import datetime, timedelta

import config
import proxy


def _configure_log_dir(monkeypatch, tmp_path: Path) -> Path:
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    monkeypatch.setattr(config, "LOG_DIR", str(log_dir))
    return log_dir


def test_archive_writes_atomically_and_keeps_today(monkeypatch, tmp_path: Path) -> None:
    log_dir = _configure_log_dir(monkeypatch, tmp_path)
    log_file = log_dir / "proxy-system.log"
    today = datetime.now(proxy.CST).date()
    previous = today - timedelta(days=2)
    log_file.write_text(
        f"{previous.isoformat()} 12:00:00 - old\n"
        "continuation\n"
        f"{today.isoformat()} 09:00:00 - today\n",
        encoding="utf-8",
    )

    proxy._archive_missed_log_days("proxy-system.log")

    assert (log_dir / f"proxy-system.log.{previous.isoformat()}").read_text(encoding="utf-8") == (
        f"{previous.isoformat()} 12:00:00 - old\ncontinuation\n"
    )
    assert log_file.read_text(encoding="utf-8") == f"{today.isoformat()} 09:00:00 - today\n"
    assert not list(log_dir.glob("*.tmp"))


def test_archive_failure_does_not_truncate_source(monkeypatch, tmp_path: Path) -> None:
    log_dir = _configure_log_dir(monkeypatch, tmp_path)
    log_file = log_dir / "proxy-system.log"
    today = datetime.now(proxy.CST).date()
    previous = today - timedelta(days=2)
    original = f"{previous.isoformat()} 12:00:00 - old\n{today.isoformat()} 09:00:00 - today\n"
    log_file.write_text(original, encoding="utf-8")

    def fail_mkstemp(*args, **kwargs):
        raise OSError("simulated archive failure")

    monkeypatch.setattr(proxy.tempfile, "mkstemp", fail_mkstemp)
    proxy._archive_missed_log_days("proxy-system.log")

    assert log_file.read_text(encoding="utf-8") == original
    assert not (log_dir / f"proxy-system.log.{previous.isoformat()}").exists()
