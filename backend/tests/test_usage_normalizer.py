from services.usage_normalizer import merge_usage, normalize_usage


def test_openai_usage_includes_cache_and_reasoning_tokens() -> None:
    usage = normalize_usage(
        {
            "prompt_tokens": 10,
            "completion_tokens": 4,
            "prompt_tokens_details": {"cached_tokens": 6},
            "completion_tokens_details": {"reasoning_tokens": 2},
        }
    )

    assert usage == {
        "prompt_tokens": 10,
        "completion_tokens": 4,
        "total_tokens": 14,
        "cache_hit_tokens": 6,
        "cache_miss_tokens": 0,
        "reasoning_tokens": 2,
    }


def test_anthropic_and_responses_usage_use_input_output_fields() -> None:
    usage = normalize_usage(
        {
            "input_tokens": 12,
            "output_tokens": 3,
            "cache_read_input_tokens": 5,
            "cache_creation_input_tokens": 2,
        }
    )

    assert usage["prompt_tokens"] == 12
    assert usage["completion_tokens"] == 3
    assert usage["total_tokens"] == 15
    assert usage["cache_hit_tokens"] == 5
    assert usage["cache_miss_tokens"] == 2


def test_stream_usage_merge_does_not_double_count_cumulative_snapshots() -> None:
    merged = merge_usage(
        normalize_usage({"input_tokens": 4}),
        normalize_usage({"output_tokens": 2}),
    )
    merged = merge_usage(merged, normalize_usage({"input_tokens": 4, "output_tokens": 2}))

    assert merged["prompt_tokens"] == 4
    assert merged["completion_tokens"] == 2
    assert merged["total_tokens"] == 6
