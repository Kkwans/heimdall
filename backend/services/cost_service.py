"""Request cost calculation with immutable per-request pricing snapshots."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Mapping, Optional


MILLION = Decimal("1000000")
COST_QUANTUM = Decimal("0.00000001")


def _non_negative_int(value: Any) -> int:
    try:
        return max(int(value or 0), 0)
    except (TypeError, ValueError):
        return 0


def _decimal(value: Any) -> Decimal:
    try:
        return max(Decimal(str(value or 0)), Decimal("0"))
    except Exception:
        return Decimal("0")


@dataclass(frozen=True)
class PricingSnapshot:
    model_id: int
    provider_id: int
    model_name: str
    currency: str
    unit: str
    price_input: str
    price_output: str
    price_cache_read: str
    price_cache_write: str

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "PricingSnapshot":
        return cls(
            model_id=int(value["model_id"]),
            provider_id=int(value["provider_id"]),
            model_name=str(value["model_name"]),
            currency="CNY",
            unit="per_million_tokens",
            price_input=str(_decimal(value.get("price_input"))),
            price_output=str(_decimal(value.get("price_output"))),
            price_cache_read=str(_decimal(value.get("price_cache_read"))),
            price_cache_write=str(_decimal(value.get("price_cache_write"))),
        )


@dataclass(frozen=True)
class CostResult:
    estimated_cost: float
    billable_tokens: int
    snapshot_json: str


def calculate_cost(
    usage: Mapping[str, Any],
    pricing: PricingSnapshot,
    *,
    source: str,
) -> CostResult:
    """Calculate CNY cost without counting cache tokens twice.

    Heimdall's normalized contract treats cache read/write tokens as subsets of
    prompt tokens. Any malformed upstream usage is clamped so the three input
    buckets never exceed the normalized prompt total.
    """

    prompt_tokens = _non_negative_int(usage.get("prompt_tokens"))
    completion_tokens = _non_negative_int(usage.get("completion_tokens"))
    cache_read_tokens = min(
        _non_negative_int(usage.get("cache_hit_tokens")), prompt_tokens
    )
    cache_write_tokens = min(
        _non_negative_int(usage.get("cache_miss_tokens")),
        max(prompt_tokens - cache_read_tokens, 0),
    )
    standard_input_tokens = max(
        prompt_tokens - cache_read_tokens - cache_write_tokens, 0
    )

    cost = (
        Decimal(standard_input_tokens) * _decimal(pricing.price_input)
        + Decimal(cache_read_tokens) * _decimal(pricing.price_cache_read)
        + Decimal(cache_write_tokens) * _decimal(pricing.price_cache_write)
        + Decimal(completion_tokens) * _decimal(pricing.price_output)
    ) / MILLION
    rounded = cost.quantize(COST_QUANTUM, rounding=ROUND_HALF_UP)
    snapshot = {
        **asdict(pricing),
        "source": source,
        "token_breakdown": {
            "standard_input": standard_input_tokens,
            "cache_read": cache_read_tokens,
            "cache_write": cache_write_tokens,
            "output": completion_tokens,
        },
    }
    return CostResult(
        estimated_cost=float(rounded),
        billable_tokens=prompt_tokens + completion_tokens,
        snapshot_json=json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
    )


def pricing_for_route(connection: Any, model_id: Optional[int]) -> Optional[PricingSnapshot]:
    if not model_id:
        return None
    row = connection.execute(
        """
        SELECT id AS model_id, provider_id, model_name,
               price_input, price_output, price_cache_read, price_cache_write
        FROM models
        WHERE id = ? AND COALESCE(pricing_configured, 0) = 1
        """,
        (model_id,),
    ).fetchone()
    return PricingSnapshot.from_mapping(dict(row)) if row else None


def estimate_for_route(
    connection: Any,
    model_id: Optional[int],
    usage: Mapping[str, Any],
) -> Optional[CostResult]:
    pricing = pricing_for_route(connection, model_id)
    if pricing is None:
        return None
    return calculate_cost(usage, pricing, source="request_snapshot")
