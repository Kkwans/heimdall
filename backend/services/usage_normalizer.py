"""Normalize usage payloads from Heimdall's supported upstream protocols."""

from __future__ import annotations

from typing import Any, Dict


def _integer(value: Any) -> int:
    try:
        return max(int(value or 0), 0)
    except (TypeError, ValueError):
        return 0


def normalize_usage(raw_usage: Any) -> Dict[str, int]:
    """Return the common token fields understood by the request recorder."""
    usage = raw_usage if isinstance(raw_usage, dict) else {}
    prompt_details = usage.get("prompt_tokens_details") or {}
    completion_details = usage.get("completion_tokens_details") or {}

    prompt_tokens = _integer(
        usage.get("prompt_tokens", usage.get("input_tokens", 0))
    )
    completion_tokens = _integer(
        usage.get("completion_tokens", usage.get("output_tokens", 0))
    )
    cache_read_tokens = _integer(
        usage.get("cache_read_input_tokens")
        or usage.get("prompt_cache_hit_tokens")
        or prompt_details.get("cached_tokens")
    )
    cache_write_tokens = _integer(
        usage.get("cache_creation_input_tokens")
        or usage.get("prompt_cache_miss_tokens")
    )

    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": _integer(usage.get("total_tokens"))
        or prompt_tokens + completion_tokens,
        "cache_hit_tokens": cache_read_tokens,
        "cache_miss_tokens": cache_write_tokens,
        "reasoning_tokens": _integer(completion_details.get("reasoning_tokens")),
    }


def usage_from_stream_event(event: Any, protocol: str) -> Dict[str, int]:
    """Extract a partial normalized usage snapshot from one SSE event."""
    if not isinstance(event, dict):
        return normalize_usage({})

    if protocol == "anthropic_messages":
        raw = event.get("usage") or (event.get("message") or {}).get("usage") or {}
    elif protocol == "openai_responses":
        raw = event.get("usage") or (event.get("response") or {}).get("usage") or {}
    else:
        raw = event.get("usage") or {}
    return normalize_usage(raw)


def merge_usage(current: Dict[str, int], update: Dict[str, int]) -> Dict[str, int]:
    """Merge partial stream usage without double-counting cumulative snapshots."""
    merged = dict(current)
    for field in (
        "prompt_tokens",
        "completion_tokens",
        "cache_hit_tokens",
        "cache_miss_tokens",
        "reasoning_tokens",
    ):
        merged[field] = max(_integer(merged.get(field)), _integer(update.get(field)))
    merged["total_tokens"] = max(
        _integer(merged.get("total_tokens")),
        _integer(update.get("total_tokens")),
        merged.get("prompt_tokens", 0) + merged.get("completion_tokens", 0),
    )
    return merged
