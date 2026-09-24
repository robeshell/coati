# -*- coding: utf-8 -*-
"""缓存测试统计口径的回归测试。"""

from backend.app.agent.service.cache_test_service import AgentCacheTestService


def _service_without_database():
    service = AgentCacheTestService.__new__(AgentCacheTestService)
    service._round_credential = lambda _request_id: {
        'credential_id': 6,
        'credential_name': 'test-account',
        'upstream_model': 'deepseek-v4-flash',
    }
    return service


def test_round_success_uses_cache_read_plus_miss_as_denominator():
    service = _service_without_database()
    row = service._round_success(
        2,
        100,
        200,
        'req-test',
        {
            'usage': {
                'prompt_tokens': 896,
                'completion_tokens': 32,
                'prompt_tokens_details': {
                    'cached_tokens': 768,
                    'cache_miss_tokens': 128,
                },
            },
        },
    )

    assert row['cache_status'] == 'complete'
    assert row['cache_observed_tokens'] == 896
    assert row['cache_coverage'] == 1
    assert row['hit_ratio'] == 0.8571


def test_round_success_derives_openai_miss_from_prompt_total():
    service = _service_without_database()
    row = service._round_success(
        2,
        100,
        200,
        'req-test',
        {
            'usage': {
                'prompt_tokens': 896,
                'completion_tokens': 32,
                'prompt_tokens_details': {'cached_tokens': 768},
            },
        },
    )

    assert row['cache_status'] == 'complete'
    assert row['cache_coverage'] == 1
    assert row['cache_ratio_source'] == 'derived'
    assert row['hit_ratio'] == 0.8571
    assert row['cache_read_tokens'] == 768
    assert row['cache_write_tokens'] is None
    assert row['cache_miss_tokens'] == 128


def test_round_success_keeps_unknown_cache_read_partial():
    service = _service_without_database()
    row = service._round_success(
        2,
        100,
        200,
        'req-test',
        {
            'usage': {
                'prompt_tokens': 896,
                'completion_tokens': 32,
                'cache_read_tokens': 768,
            },
        },
    )

    assert row['cache_status'] == 'partial'
    assert row['cache_coverage'] == 0.8571
    assert row['cache_ratio_source'] == 'estimated'
    assert row['hit_ratio'] is None
    assert row['cache_read_tokens'] == 768
    assert row['cache_write_tokens'] is None
    assert row['cache_miss_tokens'] is None


def test_round_success_counts_cache_write_as_not_hit():
    service = _service_without_database()
    row = service._round_success(
        2,
        100,
        200,
        'req-test',
        {
            'usage': {
                'prompt_tokens': 1000,
                'completion_tokens': 32,
                'prompt_tokens_details': {'cached_tokens': 700},
                'cache_write_tokens': 100,
            },
        },
    )

    assert row['cache_status'] == 'complete'
    assert row['cache_observed_tokens'] == 1000
    assert row['hit_ratio'] == 0.7


def test_round_success_reads_gemini_usage_metadata_shape():
    service = _service_without_database()
    row = service._round_success(
        2,
        100,
        200,
        'req-test',
        {
            'usageMetadata': {
                'promptTokenCount': 100,
                'candidatesTokenCount': 20,
                'cachedContentTokenCount': 70,
            },
        },
    )

    assert row['cache_status'] == 'complete'
    assert row['cache_miss_tokens'] == 30
    assert row['hit_ratio'] == 0.7


def test_round_success_uses_anthropic_disjoint_input_as_cache_miss():
    service = _service_without_database()
    row = service._round_success(
        2,
        100,
        200,
        'req-test',
        {
            'usage': {
                'input_tokens': 100,
                'output_tokens': 20,
                'cache_read_input_tokens': 70,
                'cache_creation_input_tokens': 30,
            },
        },
    )

    assert row['cache_status'] == 'complete'
    assert row['cache_miss_tokens'] == 100
    assert row['cache_observed_tokens'] == 200
    assert row['cache_context_tokens'] == 200
    assert row['cache_coverage'] == 1
    assert row['hit_ratio'] == 0.35


def test_summary_separates_first_round_from_warm_requests():
    service = _service_without_database()
    summary = service._summarize([
        {
            'round': 1,
            'status': 'ok',
            'latency_ms': 1000,
            'prompt_tokens': 896,
            'completion_tokens': 32,
            'cache_read_tokens': 0,
            'cache_write_tokens': 0,
            'cache_miss_tokens': 896,
            'cache_status': 'complete',
            'hit_ratio': 0,
            'credential_id': 6,
            'credential_name': 'test-account',
        },
        {
            'round': 2,
            'status': 'ok',
            'latency_ms': 700,
            'prompt_tokens': 896,
            'completion_tokens': 32,
            'cache_read_tokens': 768,
            'cache_write_tokens': 0,
            'cache_miss_tokens': 128,
            'cache_status': 'complete',
            'hit_ratio': 0.8571,
            'credential_id': 6,
            'credential_name': 'test-account',
        },
        {
            'round': 3,
            'status': 'ok',
            'latency_ms': 600,
            'prompt_tokens': 896,
            'completion_tokens': 32,
            'cache_read_tokens': 768,
            'cache_write_tokens': 0,
            'cache_miss_tokens': 128,
            'cache_status': 'complete',
            'hit_ratio': 0.8571,
            'credential_id': 6,
            'credential_name': 'test-account',
        },
    ])

    assert summary['cold_latency_ms'] == 1000
    assert summary['warm_avg_latency_ms'] == 650
    assert summary['warm_hit_ratio'] == 0.8571
    assert summary['avg_hit_ratio'] == 0.8571
    assert summary['overall_hit_ratio'] == 0.5714
    assert summary['first_round_cache_hit'] is False
    assert summary['cache_data_status'] == 'complete'
    assert summary['account_consistent'] is True
