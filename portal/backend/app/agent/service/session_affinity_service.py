# -*- coding: utf-8 -*-
"""平台账号池的会话亲和调度。"""

from flask import current_app

from backend.app.agent.crud import AgentSessionAffinityCRUD


class AgentSessionAffinityService:
    def __init__(self, db, models):
        self.crud = AgentSessionAffinityCRUD(db, models)

    @staticmethod
    def enabled():
        value = current_app.config.get('AGENT_SESSION_AFFINITY_ENABLED', True)
        if isinstance(value, str):
            return value.strip().lower() not in {'0', 'false', 'no', 'off'}
        return bool(value)

    @staticmethod
    def ttl_seconds():
        value = current_app.config.get('AGENT_SESSION_AFFINITY_TTL_SECONDS', 3600)
        try:
            value = int(value or 3600)
        except (TypeError, ValueError):
            value = 3600
        return min(7 * 24 * 3600, max(60, value))

    def resolve(self, user_id, session_id, model_key):
        if not self.enabled() or not user_id:
            return None
        session_id = str(session_id or '').strip()[:64]
        model_key = str(model_key or '').strip()[:255]
        if not session_id or not model_key:
            return None
        row = self.crud.get_active(
            user_id, session_id, model_key,
            ttl_seconds=self.ttl_seconds(),
        )
        return {
            'user_id': user_id,
            'session_id': session_id,
            'model_key': model_key,
            'selection_key': f'{user_id}:{session_id}:{model_key}',
            'credential_id': row.credential_id if row else None,
            'hit': bool(row),
        }

    def bind(self, context, credential_id):
        if not context or credential_id is None:
            return None
        return self.crud.bind(
            context['user_id'], context['session_id'], context['model_key'], credential_id,
            ttl_seconds=self.ttl_seconds(),
        )

    def order_initial_candidates(self, context, candidates, *, active_requests=None):
        """首次会话绑定按有效绑定负载做平滑加权轮询。

        已有会话由 resolve() 直接命中绑定，不会经过这里；因此该排序只影响新
        会话的第一次选择，既能分散账号，又不会破坏同一会话的缓存亲和。
        """
        candidates = list(candidates or [])
        if (
            not self.enabled()
            or (context and context.get('hit'))
            or len(candidates) <= 1
        ):
            return candidates

        active_requests = active_requests or {}
        if not context and not active_requests:
            return candidates

        with_ids = [row for row in candidates if getattr(row, 'id', None) is not None]
        if len(with_ids) <= 1:
            return candidates
        loads = {'counts': {}, 'last_credential_id': None}
        if context:
            try:
                # 首次绑定要在整个账号池内均衡。会话本身仍按用户隔离，只有
                # “哪个账号承接新会话”的负载视图需要跨用户共享。
                loads = self.crud.active_binding_loads(
                    None,
                    context.get('model_key'),
                    [row.id for row in with_ids],
                )
            except Exception:
                try:
                    self.recover_transaction()
                except Exception:
                    pass
                current_app.logger.warning('读取会话绑定负载失败，继续使用实时请求负载', exc_info=True)
        return self._smooth_order(candidates, loads, active_requests)

    @staticmethod
    def _smooth_order(candidates, loads, active_requests=None):
        counts = (loads or {}).get('counts') or {}
        last_id = (loads or {}).get('last_credential_id')
        active_requests = active_requests or {}
        result = []

        priorities = sorted(
            {int(getattr(row, 'priority', 0) or 0) for row in candidates},
            reverse=True,
        )
        for priority in priorities:
            bucket = [
                row for row in candidates
                if int(getattr(row, 'priority', 0) or 0) == priority
            ]
            identifiable = [row for row in bucket if getattr(row, 'id', None) is not None]
            opaque = [row for row in bucket if getattr(row, 'id', None) is None]
            if len(identifiable) <= 1:
                result.extend(bucket)
                continue

            # 根据当前活跃绑定数计算平滑负载：score=(已绑定会话数+1)/权重。
            # 这样会优先补齐负载较低的账号；相同负载时从最近选择账号之后继续
            # 轮转，避免同一账号连续成为多个新会话的首选。
            ordered = sorted(identifiable, key=lambda row: int(row.id))
            virtual_counts = {row.id: counts.get(row.id, 0) for row in ordered}
            remaining = list(ordered)
            previous_id = last_id if last_id in virtual_counts else None
            while remaining:
                scores = {
                    row.id: (
                        virtual_counts[row.id]
                        + int(active_requests.get(row.id, 0) or 0)
                        + 1
                    ) / max(1, int(getattr(row, 'weight', 1) or 1))
                    for row in remaining
                }
                best_score = min(scores.values())
                ties = [row for row in remaining if scores[row.id] == best_score]
                if previous_id in {row.id for row in ties}:
                    tie_index = next(index for index, row in enumerate(ties) if row.id == previous_id)
                    ties = ties[tie_index + 1:] + ties[:tie_index + 1]
                selected = ties[0]
                result.append(selected)
                remaining.remove(selected)
                virtual_counts[selected.id] += 1
                previous_id = selected.id
            result.extend(opaque)

        return result

    def invalidate(self, context, credential_id=None):
        if not context:
            return False
        return self.crud.invalidate(
            context['user_id'], context['session_id'], context['model_key'],
            credential_id=credential_id,
        )

    def recover_transaction(self):
        """亲和表不可用时清理失败事务，让主网关查询可以继续。"""
        self.crud.rollback()
