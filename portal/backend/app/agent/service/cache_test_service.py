# -*- coding: utf-8 -*-
"""缓存命中率测试：N 轮完全相同请求，经真实网关链路测量上游缓存命中效果。

测试与生产调用完全同链路（AgentGatewayService.chat_completions），并通过固定
X-COATI-Session-ID 触发会话亲和，将 N 轮请求钉在同一上游账号上——不同 Key 各自
缓存独立，只有同账号同模型同前缀才能测出真实命中率。

每轮从用量事件回读实际使用的账号（credential_id / 账号名 / 实际上游模型），
并在汇总中校验账号一致性，中途换号（冷却/fallback）时明确提示结果可能失真。
"""

import json
import time
from uuid import uuid4

from backend.app.agent.crud.cache_test import AgentCacheTestCRUD
from backend.app.agent.schema.cache_test import (
    AgentValidationError,
    normalize_cache_test_payload,
)
from backend.app.agent.service.credential_service import AgentCredentialError
from backend.app.agent.service.gateway_service import AgentGatewayError, AgentGatewayService
from backend.app.agent.service.provider_adapters import ProviderAdapter
from backend.app.agent.service.usage_service import AgentUsageError

MAX_ROUNDS = 5
SESSION_PREFIX = 'cachetest'


class AgentCacheTestError(RuntimeError):
    def __init__(self, message, status_code=400, payload=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.payload = payload or {}


class AgentCacheTestService:
    def __init__(self, db, models):
        self.models = models
        self.crud = AgentCacheTestCRUD(db, models)
        self.gateway = AgentGatewayService(db, models)

    # ── 列表 / 详情 / 删除 ────────────────────────────────────────────────

    def list_tests(self, user_id, page=1, per_page=20, search=None):
        rows, total = self.crud.page(user_id, page=page, per_page=per_page, search=search)
        return {
            'items': [row.to_dict() for row in rows],
            'total': total,
            'page': page,
            'per_page': per_page,
        }

    def get_test(self, user_id, test_id):
        row = self.crud.get(test_id, user_id=user_id)
        if not row:
            raise AgentCacheTestError('测试记录不存在', 404)
        return row.to_dict()

    def delete_test(self, user_id, test_id):
        row = self.crud.get(test_id, user_id=user_id)
        if not row:
            raise AgentCacheTestError('测试记录不存在', 404)
        self.crud.remove(row)
        return {'deleted': test_id}

    # ── 运行测试 ──────────────────────────────────────────────────────────

    def run(self, user, data):
        try:
            payload = normalize_cache_test_payload(data)
        except AgentValidationError as exc:
            raise AgentCacheTestError(str(exc), 400) from exc

        user_id = int(getattr(user, 'id', 0) or 0)
        run_token = uuid4().hex[:12]
        session_id = f'{SESSION_PREFIX}-{user_id}-{run_token}'
        headers = {'X-COATI-Session-ID': session_id}
        body = {
            'model': payload['model'],
            'messages': [{'role': 'user', 'content': payload['prompt']}],
            'max_tokens': payload['max_tokens'],
            'stream': False,
        }

        rounds_data = []
        errors = []
        for index in range(payload['rounds']):
            round_no = index + 1
            started = time.time()
            try:
                parsed, status, request_id = self.gateway.chat_completions(
                    user, body, request_headers=headers,
                )
                latency_ms = int((time.time() - started) * 1000)
                if status >= 400:
                    message = self._payload_error(parsed) or f'上游返回 HTTP {status}'
                    rounds_data.append(self._round_failure(
                        round_no, latency_ms, status, message, request_id,
                    ))
                    errors.append(f'第{round_no}轮: {message}')
                    break
                rounds_data.append(self._round_success(
                    round_no, latency_ms, status, request_id, parsed,
                ))
            except (AgentGatewayError, AgentCredentialError, AgentUsageError) as exc:
                latency_ms = int((time.time() - started) * 1000)
                message = getattr(exc, 'message', None) or str(exc)
                rounds_data.append(self._round_failure(
                    round_no, latency_ms, getattr(exc, 'status_code', None), message,
                ))
                errors.append(f'第{round_no}轮: {message}')
                break

        summary = self._summarize(rounds_data)
        status = self._overall_status(rounds_data)
        error_summary = '；'.join(errors)[:500] or None
        row = self.crud.create(
            user_id=user_id,
            name=payload['name'],
            model=payload['model'],
            prompt=payload['prompt'],
            rounds=payload['rounds'],
            max_tokens=payload['max_tokens'],
            status=status,
            summary_json=json.dumps(summary, ensure_ascii=False),
            rounds_json=json.dumps(rounds_data, ensure_ascii=False),
            error_summary=error_summary,
        )
        return row.to_dict()

    # ── 逐轮数据 ──────────────────────────────────────────────────────────

    def _round_success(self, round_no, latency_ms, http_status, request_id, parsed):
        payload = parsed if isinstance(parsed, dict) else {}
        normalized_usage = ProviderAdapter.normalized_usage(payload)
        prompt_tokens = int(normalized_usage.get('prompt_tokens') or 0)
        completion_tokens = int(normalized_usage.get('completion_tokens') or 0)
        cache_details = ProviderAdapter.cache_usage_details(payload)
        cache = cache_details['fields']
        cache_read = cache.get('cache_read_tokens')
        cache_write = cache.get('cache_write_tokens')
        cache_miss = cache.get('cache_miss_tokens')
        if cache_read is not None:
            cache_read = int(cache_read)
        if cache_write is not None:
            cache_write = int(cache_write)
        if cache_miss is not None:
            cache_miss = int(cache_miss)
        has_cache_read = 'cache_read_tokens' in cache
        has_cache_miss = 'cache_miss_tokens' in cache
        # dsh 的命中率分母是 input + cacheRead + cacheWrite；写入缓存本身
        # 不是命中，不能从分母中漏掉。
        cache_observed = (cache_read or 0) + (cache_write or 0) + (cache_miss or 0)
        if has_cache_read and has_cache_miss:
            cache_status = 'complete'
            hit_ratio = round(cache_read / cache_observed, 4) if cache_observed > 0 else 0
            cache_ratio_source = cache_details.get('miss_source') or 'reported'
        elif cache:
            # 未知协议只有部分缓存字段时，不能把 prompt_tokens 当成未命中量：
            # 不同 Provider 可能只上报可缓存区间，直接相除会制造假命中率。
            cache_status = 'partial'
            hit_ratio = None
            cache_ratio_source = 'estimated' if has_cache_read and prompt_tokens > 0 else None
        else:
            cache_status = 'unreported'
            hit_ratio = None
            cache_ratio_source = None
        cache_context_tokens = prompt_tokens
        if cache_details.get('semantics') == 'disjoint-input':
            # Anthropic/Bedrock 的 prompt_tokens/input_tokens 只代表未缓存桶，
            # 需要把 read/write 加回上下文总量后再计算覆盖率。
            cache_context_tokens += (cache_read or 0) + (cache_write or 0)
        cache_coverage = (
            round(cache_observed / cache_context_tokens, 4)
            if cache_context_tokens > 0 and (has_cache_read or has_cache_miss)
            else None
        )
        credential = self._round_credential(request_id)
        return {
            'round': round_no,
            'status': 'ok',
            'latency_ms': latency_ms,
            'http_status': http_status,
            'prompt_tokens': prompt_tokens,
            'completion_tokens': completion_tokens,
            'cache_read_tokens': cache_read,
            'cache_write_tokens': cache_write,
            'cache_miss_tokens': cache_miss,
            'cache_observed_tokens': cache_observed,
            'cache_context_tokens': cache_context_tokens,
            'cache_status': cache_status,
            'cache_coverage': cache_coverage,
            'cache_ratio_source': cache_ratio_source,
            'hit_ratio': hit_ratio,
            'request_id': request_id,
            **credential,
        }

    def _round_failure(self, round_no, latency_ms, http_status, message, request_id=None):
        credential = self._round_credential(request_id)
        return {
            'round': round_no,
            'status': 'error',
            'latency_ms': latency_ms,
            'http_status': http_status,
            'prompt_tokens': 0,
            'completion_tokens': 0,
            'cache_read_tokens': None,
            'cache_write_tokens': None,
            'cache_miss_tokens': None,
            'cache_observed_tokens': 0,
            'cache_status': 'unavailable',
            'cache_coverage': None,
            'cache_ratio_source': None,
            'hit_ratio': None,
            'request_id': request_id,
            'error': (message or '')[:300],
            **credential,
        }

    def _round_credential(self, request_id):
        """回查用量事件拿到该轮实际路由到的账号；拿不到时返回空。"""
        event = self.crud.usage_event(request_id)
        if not event:
            return {
                'credential_id': None,
                'credential_name': None,
                'upstream_model': None,
            }
        credential_id = getattr(event, 'credential_id', None)
        credential = self.crud.credential(credential_id) if credential_id else None
        return {
            'credential_id': credential_id,
            'credential_name': getattr(credential, 'name', None) if credential else None,
            'upstream_model': getattr(event, 'upstream_model', None) or None,
        }

    @staticmethod
    def _payload_error(parsed):
        if not isinstance(parsed, dict):
            return None
        for key in ('error', 'message'):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:300]
            if isinstance(value, dict):
                message = value.get('message')
                if isinstance(message, str) and message.strip():
                    return message.strip()[:300]
        return None

    # ── 汇总 ──────────────────────────────────────────────────────────────

    def _summarize(self, rounds_data):
        successful = [row for row in rounds_data if row.get('status') == 'ok']
        # 使用真实轮次而不是 successful[1:]：如果首轮失败或数据被补写，不能把
        # 第二个成功结果误当成冷启动基线。
        cold = next((row for row in rounds_data if row.get('round') == 1), None)
        warm = [row for row in successful if (row.get('round') or 0) > 1]
        cold_latency = cold.get('latency_ms') if cold and cold.get('status') == 'ok' else None
        warm_latencies = [row.get('latency_ms') for row in warm if row.get('latency_ms')]
        warm_avg = int(sum(warm_latencies) / len(warm_latencies)) if warm_latencies else None

        prompt_total = sum(row.get('prompt_tokens') or 0 for row in successful)
        read_total = sum(row.get('cache_read_tokens') or 0 for row in successful)
        write_total = sum(row.get('cache_write_tokens') or 0 for row in successful)
        miss_total = sum(row.get('cache_miss_tokens') or 0 for row in successful)

        measurable = [
            row for row in successful
            if row.get('cache_status') == 'complete'
        ]
        warm_measurable = [
            row for row in warm
            if row.get('cache_status') == 'complete'
        ]
        warm_read_total = sum(row.get('cache_read_tokens') or 0 for row in warm_measurable)
        warm_write_total = sum(row.get('cache_write_tokens') or 0 for row in warm_measurable)
        warm_miss_total = sum(row.get('cache_miss_tokens') or 0 for row in warm_measurable)
        warm_observed_total = warm_read_total + warm_write_total + warm_miss_total
        all_read_total = sum(row.get('cache_read_tokens') or 0 for row in measurable)
        all_write_total = sum(row.get('cache_write_tokens') or 0 for row in measurable)
        all_miss_total = sum(row.get('cache_miss_tokens') or 0 for row in measurable)
        all_observed_total = all_read_total + all_write_total + all_miss_total
        coverage_rows = [
            row for row in successful
            if row.get('cache_coverage') is not None
            and (row.get('cache_context_tokens') or row.get('prompt_tokens'))
        ]
        warm_coverage_rows = [
            row for row in warm
            if row.get('cache_coverage') is not None
            and (row.get('cache_context_tokens') or row.get('prompt_tokens'))
        ]
        warm_coverage_read = sum(row.get('cache_read_tokens') or 0 for row in warm_coverage_rows)
        warm_coverage_prompt = sum(
            row.get('cache_context_tokens') or row.get('prompt_tokens') or 0
            for row in warm_coverage_rows
        )
        all_coverage_read = sum(row.get('cache_read_tokens') or 0 for row in coverage_rows)
        all_coverage_prompt = sum(
            row.get('cache_context_tokens') or row.get('prompt_tokens') or 0
            for row in coverage_rows
        )
        warm_hit_ratios = [
            row.get('hit_ratio') for row in warm_measurable
            if row.get('hit_ratio') is not None
        ]
        avg_hit_ratio = round(
            sum(warm_hit_ratios) / len(warm_hit_ratios), 4,
        ) if warm_hit_ratios else None
        warm_hit_ratio = (
            round(warm_read_total / warm_observed_total, 4)
            if warm and len(warm_measurable) == len(warm) and warm_observed_total > 0
            else None
        )
        warm_cache_coverage = (
            round(warm_coverage_read / warm_coverage_prompt, 4)
            if warm_coverage_prompt > 0 else None
        )
        overall_cache_coverage = (
            round(all_coverage_read / all_coverage_prompt, 4)
            if all_coverage_prompt > 0 else None
        )
        overall_hit_ratio = (
            round(all_read_total / all_observed_total, 4)
            if successful and len(measurable) == len(successful) and all_observed_total > 0
            else None
        )
        ratio_sources = {
            row.get('cache_ratio_source')
            for row in measurable
            if row.get('cache_ratio_source')
        }
        cache_ratio_source = (
            next(iter(ratio_sources)) if len(ratio_sources) == 1
            else 'mixed' if ratio_sources else None
        )

        if not successful:
            cache_data_status = 'unavailable'
        elif all(row.get('cache_status') == 'complete' for row in successful):
            cache_data_status = 'complete'
        elif any(row.get('cache_status') == 'complete' for row in successful):
            cache_data_status = 'partial'
        elif any(row.get('cache_status') == 'partial' for row in successful):
            cache_data_status = 'partial'
        else:
            cache_data_status = 'unreported'

        known_ids = [row.get('credential_id') for row in successful if row.get('credential_id')]
        account_consistent = None
        if known_ids and len(set(known_ids)) > 1:
            account_consistent = False
        elif known_ids and len(known_ids) == len(successful):
            account_consistent = True
        account_name = next(
            (row.get('credential_name') for row in successful if row.get('credential_name')),
            None,
        )

        speedup = None
        latency_saved_pct = None
        if cold_latency and warm_avg:
            speedup = round(cold_latency / warm_avg, 2) if warm_avg > 0 else None
            if cold_latency > 0:
                latency_saved_pct = round(
                    (cold_latency - warm_avg) / cold_latency * 100, 1,
                )

        return {
            'rounds_total': len(rounds_data),
            'rounds_ok': len(successful),
            'cold_latency_ms': cold_latency,
            'warm_avg_latency_ms': warm_avg,
            'speedup_x': speedup,
            'latency_saved_pct': latency_saved_pct,
            'avg_hit_ratio': avg_hit_ratio,
            # avg_hit_ratio 保留原字段供历史列表兼容；新页面优先使用加权后的
            # warm_hit_ratio，避免不同轮次 Token 数量不同时产生均值偏差。
            'warm_hit_ratio': warm_hit_ratio,
            'warm_cache_coverage': warm_cache_coverage,
            'overall_cache_coverage': overall_cache_coverage,
            'overall_hit_ratio': overall_hit_ratio,
            'cache_data_status': cache_data_status,
            'cache_ratio_source': cache_ratio_source,
            'cache_observed_tokens': all_observed_total,
            'warm_cache_read_tokens': warm_read_total,
            'warm_cache_write_tokens': warm_write_total,
            'warm_cache_miss_tokens': warm_miss_total,
            'warm_cache_observed_tokens': warm_observed_total,
            'first_round_cache_status': cold.get('cache_status') if cold else None,
            'first_round_cache_hit': bool(cold and (cold.get('cache_read_tokens') or 0) > 0),
            'prompt_tokens': prompt_total,
            'completion_tokens': sum(row.get('completion_tokens') or 0 for row in successful),
            'cache_read_tokens': read_total,
            'cache_write_tokens': write_total,
            'cache_miss_tokens': miss_total,
            'account_consistent': account_consistent,
            'account_name': account_name,
        }

    @staticmethod
    def _overall_status(rounds_data):
        if not rounds_data:
            return 'failed'
        if all(row.get('status') == 'ok' for row in rounds_data):
            return 'ok'
        if rounds_data[0].get('status') == 'error':
            return 'failed'
        return 'partial'
