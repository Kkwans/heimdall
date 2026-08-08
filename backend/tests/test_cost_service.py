import json
import sqlite3

from migrations import MIGRATIONS, apply_migrations
from services.cost_service import PricingSnapshot, calculate_cost


def _pricing(**overrides):
    values = {
        "model_id": 3,
        "provider_id": 2,
        "model_name": "priced-model",
        "price_input": "10",
        "price_output": "20",
        "price_cache_read": "1",
        "price_cache_write": "4",
    }
    values.update(overrides)
    return PricingSnapshot.from_mapping(values)


def test_cost_calculation_does_not_double_count_cache_subsets() -> None:
    result = calculate_cost(
        {
            "prompt_tokens": 1_000_000,
            "completion_tokens": 500_000,
            "cache_hit_tokens": 200_000,
            "cache_miss_tokens": 100_000,
        },
        _pricing(),
        source="request_snapshot",
    )

    # 70 万普通输入 + 20 万缓存读取 + 10 万缓存写入 + 50 万输出。
    assert result.estimated_cost == 17.6
    assert result.billable_tokens == 1_500_000
    snapshot = json.loads(result.snapshot_json)
    assert snapshot["currency"] == "CNY"
    assert snapshot["token_breakdown"] == {
        "standard_input": 700_000,
        "cache_read": 200_000,
        "cache_write": 100_000,
        "output": 500_000,
    }


def test_configured_zero_prices_are_a_known_free_request() -> None:
    result = calculate_cost(
        {"prompt_tokens": 9, "completion_tokens": 1},
        _pricing(
            price_input=0,
            price_output=0,
            price_cache_read=0,
            price_cache_write=0,
        ),
        source="request_snapshot",
    )

    assert result.estimated_cost == 0
    assert result.billable_tokens == 10


def test_v5_backfills_only_unambiguous_priced_history(tmp_path) -> None:
    database = tmp_path / "costs.db"
    apply_migrations(database, migrations=MIGRATIONS[:4])
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE providers (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                api_key TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE models (
                id INTEGER PRIMARY KEY,
                provider_id INTEGER NOT NULL,
                model_name TEXT NOT NULL,
                price_input REAL DEFAULT 0,
                price_output REAL DEFAULT 0,
                price_cache_read REAL DEFAULT 0,
                price_cache_write REAL DEFAULT 0,
                pricing_configured BOOLEAN NOT NULL DEFAULT 0
            );
            INSERT INTO providers (id, name) VALUES (1, 'priced-provider');
            INSERT INTO providers (id, name) VALUES (2, 'unknown-provider');
            INSERT INTO models VALUES (1, 1, 'priced-model', 10, 20, 1, 4, 1);
            INSERT INTO models VALUES (2, 2, 'unknown-model', 0, 0, 0, 0, 0);
            """
        )
        connection.execute(
            """
            INSERT INTO requests
                (date, model, provider, provider_id, success,
                 prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens)
            VALUES ('2026-08-08', 'priced-model', 'priced-provider', 1, 1,
                    1000000, 500000, 200000, 100000)
            """
        )
        connection.execute(
            """
            INSERT INTO requests
                (date, model, provider, provider_id, success,
                 prompt_tokens, completion_tokens)
            VALUES ('2026-08-08', 'unknown-model', 'unknown-provider', 2, 1, 100, 20)
            """
        )
        connection.commit()

    first = apply_migrations(database)
    second = apply_migrations(database)

    assert first.applied_versions == (5,)
    assert second.applied_versions == ()
    with sqlite3.connect(database) as connection:
        rows = connection.execute(
            "SELECT model, estimated_cost, cost_source, billable_tokens, pricing_snapshot "
            "FROM requests ORDER BY id"
        ).fetchall()
    assert rows[0][0:4] == ("priced-model", 17.6, "historical_estimate", 1_500_000)
    assert json.loads(rows[0][4])["source"] == "historical_estimate"
    assert rows[1][1:] == (None, None, None, None)
