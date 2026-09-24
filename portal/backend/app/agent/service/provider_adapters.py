# -*- coding: utf-8 -*-
"""上游服务商适配：只负责「网关 → 厂商」怎么打。

用户入口（OpenAI Chat Completions / Anthropic Messages）在 gateway_service。
上游没有对应协议时，由 protocol_bridge 翻译，不在这里叠特例。
"""

import json
from urllib import request as urlrequest

import requests

from backend.app.agent.service.proxy import proxy_mapping

# 服务端工具请求的形状按上游协议决定；这里不引 constants 以免形成循环导入。
ANTHROPIC_MESSAGES = 'anthropic-messages'
OPENAI_RESPONSES = 'openai-responses'


class ProviderAdapterError(RuntimeError):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class ProviderAdapter:
    code = ''
    label = ''
    protocol = ''
    available = False
    description = ''
    default_base_url = ''
    default_model = ''
    default_models = ()
    # 缓存字段必须按上游协议语义解释。unknown 表示只接受上游明确给出的
    # read/write/miss，不用上下文总量猜测未命中量。
    cache_semantics = 'unknown'
    # Anthropic Messages 服务端搜索的请求参数；子类可覆盖。
    search_api_version = '2023-06-01'
    search_max_tokens = 4096
    # 该厂商是否在任意基址旁边都另有一个已知路径的 Anthropic Messages 端点。
    # 这是端点拓扑事实（那个地址存不存在），不是能力声明（能不能执行搜索）—— 后者
    # 只能按实际回包观测。默认 False：一个 OpenAI 兼容基址拼出的 /v1/messages
    # 通常并不存在，盲目去打只会白费一次往返。
    anthropic_endpoint_beside_base = False

    def catalog_item(self):
        return {
            'code': self.code,
            'label': self.label,
            'protocol': self.protocol,
            'available': self.available,
            'status': 'available' if self.available else 'reserved',
            'description': self.description,
            'default_base_url': self.default_base_url,
            'default_model': self.default_model,
            'default_models': list(self.default_models),
        }

    def assert_available(self):
        if not self.available:
            raise ProviderAdapterError(f'{self.label} Adapter 尚未启用，当前仅作扩展位预留', 422)

    def discover_models(self, *, base_url, api_key, timeout, extra_headers=None, proxy_url=None):
        self.assert_available()
        raise ProviderAdapterError(f'{self.label} 暂不支持自动获取模型', 422)

    def build_chat_request(self, *, base_url, api_key, model, body):
        self.assert_available()
        raise ProviderAdapterError(f'{self.label} 暂不支持对话请求', 422)

    def build_anthropic_request(self, *, base_url, api_key, model, body, request_headers=None):
        self.assert_available()
        raise ProviderAdapterError(f'{self.label} 暂不支持 Anthropic Messages', 422)

    def build_responses_request(self, *, base_url, api_key, model, body):
        self.assert_available()
        raise ProviderAdapterError(f'{self.label} 暂不支持 OpenAI Responses', 422)

    def build_web_search_request(self, *, base_url, api_key, model, query, max_uses=5):
        self.assert_available()
        raise ProviderAdapterError(f'{self.label} 暂不支持网页搜索', 422)

    def parse_web_search_response(self, payload, limit):
        self.assert_available()
        raise ProviderAdapterError(f'{self.label} 暂不支持网页搜索', 422)

    def usage_from_web_search_response(self, payload):
        return type(self).normalized_usage(
            payload, semantics=type(self).cache_semantics,
        )

    @staticmethod
    def normalize_response(payload):
        return payload

    @classmethod
    def usage_from_response(cls, payload):
        return cls.normalized_usage(payload, semantics=cls.cache_semantics)

    @staticmethod
    def normalize_stream_chunk(chunk):
        return chunk

    @classmethod
    def usage_from_stream_event(cls, payload):
        if not isinstance(payload, dict):
            return {}
        return cls.normalized_usage(
            payload, stream=True, semantics=cls.cache_semantics,
        )

    _USAGE_KEYS = {
        'usage', 'usagemetadata', 'usagedetails', 'tokenusage',
    }
    _USAGE_NESTED_KEYS = {'response', 'message', 'result', 'data'}
    _INPUT_TOKEN_KEYS = {
        'prompttokens', 'inputtokens', 'prompttokencount', 'inputtokencount',
    }
    _OUTPUT_TOKEN_KEYS = {
        'completiontokens', 'outputtokens', 'candidatestokencount',
        'outputtokencount',
    }
    _CACHE_READ_KEYS = {
        'cachereadtokens', 'cachereadinputtokens', 'promptcachehittokens',
        'cachedtokens', 'cachehittokens', 'cachehitinputtokens',
        'inputcachedtokens', 'cachedinputtokens', 'cachedcontenttokencount',
        'cachedcontenttokens', 'cacheread',
    }
    _CACHE_WRITE_KEYS = {
        'cachewritetokens', 'cachecreationinputtokens',
        'cachewriteinputtokens',
        'promptcachewritetokens', 'cachewrite', 'cachecreationtokens',
        'cachecreationtokencount', 'cachecreation',
        'ephemeral5minputtokens', 'ephemeral1minputtokens',
        'ephemeral1hinputtokens',
    }
    _CACHE_MISS_KEYS = {
        'cachemisstokens', 'promptcachemisstokens', 'cachemissinputtokens',
        'cachemiss', 'uncachedtokens', 'uncachedinputtokens',
        'inputuncachedtokens',
    }
    # 这些字段对应 dsh / 各协议的两种不同口径：
    # - prompt_tokens 是包含缓存读写的输入总量；
    # - input_tokens 是已经排除缓存读写的未缓存输入量（Anthropic/Bedrock）。
    _PROMPT_TOTAL_INPUT_KEYS = {'prompttokens', 'prompttokencount'}
    _DISJOINT_INPUT_KEYS = {'inputtokens', 'inputtokencount'}
    _PROMPT_TOTAL_CACHE_READ_KEYS = {
        'promptcachehittokens', 'cachedtokens', 'cachehittokens',
        'cachehitinputtokens', 'inputcachedtokens', 'cachedinputtokens',
        'cachedcontenttokencount', 'cachedcontenttokens',
    }
    _PROMPT_TOTAL_CACHE_WRITE_KEYS = {
        'promptcachewritetokens', 'cachecreationtokens',
        'cachecreationtokencount',
    }
    _DISJOINT_CACHE_READ_KEYS = {'cachereadinputtokens'}
    _DISJOINT_CACHE_WRITE_KEYS = {'cachecreationinputtokens', 'cachewriteinputtokens'}

    @staticmethod
    def _normalized_key(value):
        """把 snake_case、camelCase 和连字符字段统一成可比较的 key。"""
        return ''.join(char for char in str(value or '').lower() if char.isalnum())

    @classmethod
    def _usage_maps(cls, payload):
        """提取不同协议的 usage 容器，不扫描 choices/input 等大字段。"""
        maps = []
        visited = set()

        def visit(value, depth=0, direct=False):
            if not isinstance(value, dict) or depth > 4 or id(value) in visited:
                return
            visited.add(id(value))
            if direct:
                maps.append(value)
            for key, child in value.items():
                normalized = cls._normalized_key(key)
                if not isinstance(child, dict):
                    continue
                if normalized in cls._USAGE_KEYS:
                    visit(child, depth + 1, direct=True)
                elif normalized in cls._USAGE_NESTED_KEYS:
                    visit(child, depth + 1, direct=False)

        if isinstance(payload, dict):
            visit(payload)
            # 兼容直接把 usage 对象传入适配器的调用方。
            if any(cls._normalized_key(key) in (
                cls._INPUT_TOKEN_KEYS | cls._OUTPUT_TOKEN_KEYS |
                cls._CACHE_READ_KEYS | cls._CACHE_WRITE_KEYS | cls._CACHE_MISS_KEYS
            ) for key in payload):
                maps.insert(0, payload)
        return maps

    @staticmethod
    def _first_number(*values):
        for value in values:
            if value in (None, ''):
                continue
            try:
                return max(0, int(value))
            except (TypeError, ValueError):
                continue
        return None

    @classmethod
    def _values_for_keys(cls, maps, keys):
        for mapping in maps:
            for key, value in mapping.items():
                if cls._normalized_key(key) in keys:
                    yield value

    @classmethod
    def _first_number_with_key(cls, maps, keys):
        """返回第一个数字及其原始语义 key，供缓存口径判断使用。"""
        for mapping in maps:
            for key, value in mapping.items():
                normalized = cls._normalized_key(key)
                if normalized not in keys:
                    continue
                number = cls._first_number(value)
                if number is not None:
                    return number, normalized
        return None, None

    @classmethod
    def _nested_dicts(cls, value, depth=0, visited=None):
        """展开 usage 内的 details，兼容 OpenAI 的 *_tokens_details 结构。"""
        if not isinstance(value, dict) or depth > 3:
            return []
        visited = visited if visited is not None else set()
        if id(value) in visited:
            return []
        visited.add(id(value))
        maps = [value]
        for child in value.values():
            if isinstance(child, dict):
                maps.extend(cls._nested_dicts(child, depth + 1, visited))
        return maps

    @classmethod
    def normalized_usage(cls, payload, *, stream=False, semantics=None):
        """统一 OpenAI、Anthropic、Gemini 及中转站的 usage 命名。

        已知协议允许根据 disjoint 的字段语义安全补齐未命中量；未知中转站仍只
        保留显式字段，避免把 prompt Token 或不可缓存前缀误当成未命中 Token。
        """
        maps = cls._usage_maps(payload)
        prompt = cls._first_number(*cls._values_for_keys(maps, cls._INPUT_TOKEN_KEYS))
        completion = cls._first_number(*cls._values_for_keys(maps, cls._OUTPUT_TOKEN_KEYS))
        result = {
            'prompt_tokens': prompt if prompt is not None else 0,
            'completion_tokens': completion if completion is not None else 0,
        }
        if maps:
            result.update(cls.cache_usage_fields(maps, semantics=semantics))
        return result

    @classmethod
    def _cache_usage_maps(cls, usage):
        if isinstance(usage, list):
            maps = []
            for item in usage:
                maps.extend(cls._nested_dicts(item))
            return maps
        usage_maps = cls._usage_maps(usage)
        if usage_maps:
            maps = []
            for item in usage_maps:
                maps.extend(cls._nested_dicts(item))
            return maps
        return cls._nested_dicts(usage)

    @classmethod
    def cache_usage_details(cls, usage, *, semantics=None):
        """返回缓存字段及其口径来源。

        dsh 的 TokenUsage 将 input/cacheRead/cacheWrite 视为互斥桶。对
        OpenAI/DeepSeek/Gemini 的 prompt_tokens 总量，以及 Anthropic/Bedrock
        的 input_tokens 未缓存量，只有在字段组合明确表达该语义时才推导 miss。
        """
        maps = cls._cache_usage_maps(usage)
        result = {}
        read, read_key = cls._first_number_with_key(maps, cls._CACHE_READ_KEYS)
        write, write_key = cls._first_number_with_key(maps, cls._CACHE_WRITE_KEYS)
        miss, _ = cls._first_number_with_key(maps, cls._CACHE_MISS_KEYS)
        input_tokens, input_key = cls._first_number_with_key(maps, cls._INPUT_TOKEN_KEYS)
        normalized_semantics = str(semantics or 'unknown').strip().lower()
        miss_source = 'reported' if miss is not None else None
        inferred_semantics = normalized_semantics

        if normalized_semantics == 'unknown':
            if (
                input_key in cls._PROMPT_TOTAL_INPUT_KEYS
                and (
                    read_key in cls._PROMPT_TOTAL_CACHE_READ_KEYS
                    or write_key in cls._PROMPT_TOTAL_CACHE_WRITE_KEYS
                )
            ):
                inferred_semantics = 'prompt-total'
            elif (
                input_key in cls._DISJOINT_INPUT_KEYS
                and (
                    read_key in cls._DISJOINT_CACHE_READ_KEYS
                    or write_key in cls._DISJOINT_CACHE_WRITE_KEYS
                )
            ):
                inferred_semantics = 'disjoint-input'

        if miss is None and input_tokens is not None:
            has_cache_dimension = read is not None or write is not None
            prompt_total = (
                input_key in cls._PROMPT_TOTAL_INPUT_KEYS
                and inferred_semantics == 'prompt-total'
            )
            disjoint_input = (
                input_key in cls._DISJOINT_INPUT_KEYS
                and inferred_semantics == 'disjoint-input'
            )
            if has_cache_dimension and prompt_total:
                remaining = input_tokens - (read or 0) - (write or 0)
                # 上游字段自相矛盾时保持 partial，不把错误数据伪装成 0 未命中。
                if remaining >= 0:
                    miss = remaining
                    miss_source = 'derived'
            elif has_cache_dimension and disjoint_input:
                # Anthropic/Bedrock 的 input_tokens 本身就是未缓存输入。
                miss = input_tokens
                miss_source = 'derived'

        if read is not None:
            result['cache_read_tokens'] = read
        if write is not None:
            result['cache_write_tokens'] = write
        if miss is not None:
            result['cache_miss_tokens'] = miss
        return {
            'fields': result,
            'miss_source': miss_source,
            'semantics': inferred_semantics,
        }

    @classmethod
    def cache_usage_fields(cls, usage, *, semantics=None):
        """统一缓存 usage；仅在协议语义明确时安全推导未命中量。"""
        return cls.cache_usage_details(usage, semantics=semantics)['fields']


class OpenAICompatibleAdapter(ProviderAdapter):
    protocol = 'openai-compatible'
    available = True

    @staticmethod
    def _response_json(response):
        try:
            return response.json()
        except ValueError:
            return None

    @staticmethod
    def _model_urls(base_url):
        root = str(base_url or '').rstrip('/')
        urls = [f'{root}/models']
        if not root.lower().endswith('/v1'):
            urls.append(f'{root}/v1/models')
        return urls

    @staticmethod
    def _model_ids(body):
        if isinstance(body, dict):
            values = body.get('data')
            if values is None:
                values = body.get('models')
        elif isinstance(body, list):
            values = body
        else:
            values = []
        if isinstance(values, dict):
            values = values.get('data') or values.get('models') or []
        if not isinstance(values, list):
            return []
        models = set()
        for item in values:
            if isinstance(item, dict):
                model_id = item.get('id') or item.get('model') or item.get('name')
            else:
                model_id = item
            if model_id:
                models.add(str(model_id).strip())
        return sorted(model for model in models if model)

    def discover_models(self, *, base_url, api_key, timeout, extra_headers=None, proxy_url=None):
        # 三种鉴权头一起带：OpenAI 兼容侧认 Authorization，Anthropic 侧认
        # x-api-key + anthropic-version。都发到同一个上游主机，不存在外泄，
        # 而少带一个就会让原生 Anthropic 端点直接 401。
        headers = {
            'Authorization': f'Bearer {api_key}',
            'x-api-key': api_key,
            'anthropic-version': self.search_api_version,
            'Accept': 'application/json',
        }
        for name, value in (extra_headers or {}).items():
            if str(name).lower() in {
                'authorization', 'x-api-key', 'host', 'content-length',
                'connection', 'transfer-encoding', 'cookie',
            }:
                continue
            headers[name] = value
        for url in self._model_urls(base_url):
            request_kwargs = {'headers': headers, 'timeout': timeout}
            proxies = proxy_mapping(proxy_url)
            if proxies:
                request_kwargs['proxies'] = proxies
            response = requests.get(url, **request_kwargs)
            body = self._response_json(response)
            if response.status_code in (401, 403, 402):
                detail = (response.text or '').strip()[:500]
                raise ProviderAdapterError(f'获取模型失败（HTTP {response.status_code}）：{detail}', 502)
            if response.status_code >= 400:
                if response.status_code in (404, 405, 501):
                    continue
                detail = (response.text or '').strip()[:500]
                raise ProviderAdapterError(f'获取模型失败（HTTP {response.status_code}）：{detail}', 502)
            models = self._model_ids(body)
            if models:
                self.assert_account_usable(
                    base_url=base_url, api_key=api_key, timeout=timeout, proxy_url=proxy_url,
                )
                return models
            # 当前路径返回空列表、HTML 或非标准 JSON 时，继续尝试 /v1/models。
        return []

    def assert_account_usable(self, *, base_url, api_key, timeout, proxy_url=None):
        """可选：在 /models 成功后确认账号仍可实际调用。默认无额外探测。"""
        return None

    def build_chat_request(self, *, base_url, api_key, model, body):
        payload = dict(body or {})
        payload['model'] = model
        if payload.get('stream'):
            stream_options = payload.get('stream_options')
            stream_options = dict(stream_options) if isinstance(stream_options, dict) else {}
            stream_options['include_usage'] = True
            payload['stream_options'] = stream_options
        root = str(base_url or '').rstrip('/')
        endpoint = root if root.endswith('/chat/completions') else f'{root}/chat/completions'
        return urlrequest.Request(
            endpoint,
            data=json.dumps(payload).encode('utf-8'),
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
            },
            method='POST',
        )

    @staticmethod
    def anthropic_messages_url(base_url):
        root = str(base_url or '').rstrip('/')
        if root.endswith('/v1/messages') or root.endswith('/messages'):
            return root
        if root.endswith('/v1'):
            return f'{root}/messages'
        return f'{root}/v1/messages'

    # thinking.budget_tokens 必须 ≥1024 且 < max_tokens。
    MIN_THINKING_BUDGET = 1024

    @classmethod
    def _normalize_anthropic_thinking(cls, body):
        """把 thinking 配置降级成所有 Anthropic Messages 上游都认的形状。

        adaptive 是官方合法类型，但较老的兼容入口不认；降级到 enabled 时必须
        补上 budget_tokens——它是 ThinkingConfigEnabled 的必填字段，只写
        {'type': 'enabled'} 会把一个合法请求改成非法请求。max_tokens 小到放不下
        最小预算时，只能整个关掉思考。

        注意这里不再剥离 redacted_thinking：它是官方合法的 ContentBlockParam，
        且扩展思考 + 工具调用的多轮对话要求 assistant 轮的思考块原样回传，
        剥掉会破坏签名链。
        """
        payload = dict(body or {})

        # Anthropic 允许 output_config.effort 与 thinking 并存，Claude Code 在长
        # prompt 触发思考时两个都会发。但部分兼容入口把它们映射成 reasoning_effort
        # 与 thinking_budget 之后拒绝共存（实测阿里云 MaaS 直接 400）。两者表达的
        # 是同一个意图，thinking 更具体（给的是明确预算），所以让 effort 让路。
        thinking_cfg = payload.get('thinking')
        thinking_on = (
            isinstance(thinking_cfg, dict)
            and thinking_cfg.get('type') in ('enabled', 'adaptive')
        )
        output_config = payload.get('output_config')
        if thinking_on and isinstance(output_config, dict) and 'effort' in output_config:
            trimmed = {k: v for k, v in output_config.items() if k != 'effort'}
            if trimmed:
                payload['output_config'] = trimmed
            else:
                payload.pop('output_config', None)

        thinking = payload.get('thinking')
        if not isinstance(thinking, dict) or thinking.get('type') != 'adaptive':
            return payload
        try:
            max_tokens = int(payload.get('max_tokens') or 0)
        except (TypeError, ValueError):
            max_tokens = 0
        if max_tokens <= cls.MIN_THINKING_BUDGET:
            payload['thinking'] = {'type': 'disabled'}
            return payload
        downgraded = {
            'type': 'enabled',
            'budget_tokens': min(
                max(cls.MIN_THINKING_BUDGET, max_tokens // 2), max_tokens - 1,
            ),
        }
        if thinking.get('display') is not None:
            downgraded['display'] = thinking['display']
        payload['thinking'] = downgraded
        return payload

    def build_anthropic_request(self, *, base_url, api_key, model, body, request_headers=None):
        self.assert_available()
        payload = self._normalize_anthropic_thinking(body)
        payload['model'] = model
        incoming = request_headers or {}
        headers = {
            'Authorization': f'Bearer {api_key}',
            'x-api-key': api_key,
            'Content-Type': 'application/json',
            'anthropic-version': incoming.get('Anthropic-Version') or incoming.get('anthropic-version') or '2023-06-01',
        }
        beta = incoming.get('Anthropic-Beta') or incoming.get('anthropic-beta')
        if beta:
            headers['anthropic-beta'] = beta
        return urlrequest.Request(
            self.anthropic_messages_url(base_url),
            data=json.dumps(payload).encode('utf-8'),
            headers=headers,
            method='POST',
        )

    def build_responses_request(self, *, base_url, api_key, model, body):
        self.assert_available()
        payload = dict(body or {})
        payload['model'] = model
        payload['store'] = False
        root = str(base_url or '').rstrip('/')
        endpoint = root if root.endswith('/responses') else f'{root}/responses'
        return urlrequest.Request(
            endpoint,
            data=json.dumps(payload).encode('utf-8'),
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
            },
            method='POST',
        )

    def build_web_search_request(self, *, base_url, api_key, model, query, max_uses=5,
                                 protocol=ANTHROPIC_MESSAGES):
        """服务端搜索请求。形状取决于上游协议，与厂商无关。

        能不能真正执行由网关按上游的实际回包判断（见 server_tools.WEB_SEARCH_SUPPORT）。
        """
        if protocol == OPENAI_RESPONSES:
            return self._responses_web_search_request(
                base_url=base_url, api_key=api_key, model=model, query=query,
            )
        self.assert_available()
        uses = min(10, max(1, int(max_uses or 5)))
        payload = {
            'model': model,
            'max_tokens': self.search_max_tokens,
            'messages': [{
                'role': 'user',
                'content': [{'type': 'text', 'text': f'Perform a web search for the query: {query}'}],
            }],
            'tools': [{
                'type': 'web_search_20250305',
                'name': 'web_search',
                'max_uses': uses,
            }],
        }
        return urlrequest.Request(
            self.anthropic_messages_url(base_url),
            data=json.dumps(payload).encode('utf-8'),
            headers={
                'Authorization': f'Bearer {api_key}',
                'x-api-key': api_key,
                'anthropic-version': self.search_api_version,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            method='POST',
        )

    def build_web_fetch_request(self, *, base_url, api_key, model, url,
                                max_content_tokens=None, protocol=ANTHROPIC_MESSAGES):
        """Anthropic Messages 协议的服务端抓取形状，与厂商无关。

        网关自身不发出对任意 URL 的外部请求（那是一个 SSRF 面），而是把抓取
        交给能执行服务端工具的上游账号。
        """
        if protocol != ANTHROPIC_MESSAGES:
            # Responses 协议没有可用的内置抓取工具（实测 web_fetch /
            # web_fetch_preview / url_context 都不触发），别白打一发。
            raise ProviderAdapterError(
                f'{self.label} 的 {protocol} 上游没有可用的网页抓取工具', 422,
            )
        self.assert_available()
        tool = {'type': 'web_fetch_20250910', 'name': 'web_fetch', 'max_uses': 1}
        if max_content_tokens:
            tool['max_content_tokens'] = int(max_content_tokens)
        payload = {
            'model': model,
            'max_tokens': self.search_max_tokens,
            'messages': [{
                'role': 'user',
                'content': [{'type': 'text', 'text': f'Fetch the page at this URL: {url}'}],
            }],
            'tools': [tool],
        }
        return urlrequest.Request(
            self.anthropic_messages_url(base_url),
            data=json.dumps(payload).encode('utf-8'),
            headers={
                'Authorization': f'Bearer {api_key}',
                'x-api-key': api_key,
                'anthropic-version': self.search_api_version,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            method='POST',
        )

    def parse_web_fetch_response(self, payload):
        """从上游回包里取出抓到的正文。

        与搜索不同，web_fetch 成功时 content 是单个对象而不是列表，
        正文藏在 content.content.source.data（DocumentBlock 的 PlainTextSource）。
        """
        self.assert_available()
        blocks = (payload or {}).get('content') if isinstance(payload, dict) else None
        if not isinstance(blocks, list):
            raise ProviderAdapterError(f'{self.label} 抓取返回无法解析', 502)
        for block in blocks:
            if not isinstance(block, dict) or block.get('type') != 'web_fetch_tool_result':
                continue
            content = block.get('content')
            if not isinstance(content, dict):
                continue
            if content.get('type') == 'web_fetch_tool_result_error':
                raise ProviderAdapterError(
                    str(content.get('error_code') or 'unavailable'), 502,
                )
            document = content.get('content') if isinstance(content.get('content'), dict) else {}
            source = document.get('source') if isinstance(document.get('source'), dict) else {}
            return {
                'url': str(content.get('url') or '').strip(),
                'retrieved_at': content.get('retrieved_at'),
                'title': document.get('title'),
                'text': str(source.get('data') or ''),
            }
        raise ProviderAdapterError(f'{self.label} 未返回抓取结果', 502)

    def _responses_web_search_request(self, *, base_url, api_key, model, query):
        """OpenAI Responses 的内置搜索。

        必须显式声明工具才会触发——实测阿里云 Token Plan 只认
        {'type': 'web_search'}；不声明的话模型只会把工具调用吐成一段文本。
        include 用来把来源 URL 带回来，否则 action.sources 是空的。
        """
        self.assert_available()
        payload = {
            'model': model,
            'input': f'Search the web for: {query}',
            'max_output_tokens': self.search_max_tokens,
            'tools': [{'type': 'web_search'}],
            'include': ['web_search_call.action.sources'],
        }
        root = str(base_url or '').rstrip('/')
        endpoint = root if root.endswith('/responses') else f'{root}/responses'
        return urlrequest.Request(
            endpoint,
            data=json.dumps(payload).encode('utf-8'),
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            method='POST',
        )

    def _parse_responses_web_search(self, payload, limit):
        """从 Responses 的 web_search_call 里取来源。

        实测 action.sources 的元素只有 {type, url}，没有标题，缺标题时回落到 URL。
        """
        items = (payload or {}).get('output') if isinstance(payload, dict) else None
        if not isinstance(items, list):
            raise ProviderAdapterError(f'{self.label} 搜索返回无法解析', 502)
        calls = [
            item for item in items
            if isinstance(item, dict) and item.get('type') == 'web_search_call'
        ]
        if not calls:
            raise ProviderAdapterError(f'{self.label} 未返回网页搜索结果', 502)
        cap = min(8, max(1, int(limit or 5)))
        sources, seen = [], set()

        def take(url, title=None):
            url = str(url or '').strip()
            # 有的上游会在来源 URL 上挂内部调用锚点（实测 DeepSeek 会加
            # #ws_call_id=...）。它对调用方没有意义，还会让同一页面因锚点不同
            # 而去重失败。
            if '#ws_call_id=' in url:
                url = url.split('#ws_call_id=', 1)[0]
            if not url or url in seen:
                return False
            seen.add(url)
            sources.append({'url': url, 'title': str(title or '').strip() or url})
            return len(sources) >= cap

        for call in calls:
            action = call.get('action') if isinstance(call.get('action'), dict) else {}
            for source in action.get('sources') or []:
                if isinstance(source, dict) and take(source.get('url'), source.get('title')):
                    return sources
            # 各家实现不一：有的在 action.sources 里给来源，有的只给 open_page /
            # find_in_page 动作上的 url。后者同样是模型实际读过的页面，一并收下。
            if action.get('url') and take(action.get('url')):
                return sources
        if not sources:
            # 搜了但一条来源都取不到，对调用方没有价值——当作这个端点不可用，
            # 让调度换下一个候选，而不是回一个空成功。
            raise ProviderAdapterError(f'{self.label} 的搜索结果没有可用来源', 502)
        return sources

    def parse_web_search_response(self, payload, limit, protocol=ANTHROPIC_MESSAGES):
        if protocol == OPENAI_RESPONSES:
            return self._parse_responses_web_search(payload, limit)
        self.assert_available()
        blocks = (payload or {}).get('content') if isinstance(payload, dict) else None
        if not isinstance(blocks, list):
            raise ProviderAdapterError(f'{self.label} 搜索返回无法解析', 502)
        result_blocks = [block for block in blocks if isinstance(block, dict) and block.get('type') == 'web_search_tool_result']
        if not result_blocks:
            raise ProviderAdapterError(f'{self.label} 未返回网页搜索结果', 502)
        snippets = {}
        for block in blocks:
            if not isinstance(block, dict) or block.get('type') != 'text':
                continue
            for cite in block.get('citations') or []:
                if not isinstance(cite, dict):
                    continue
                url = str(cite.get('url') or '').strip()
                text = str(cite.get('cited_text') or '').strip()
                if url and text and url not in snippets:
                    snippets[url] = text
        sources = []
        seen = set()
        cap = min(8, max(1, int(limit or 5)))
        for block in result_blocks:
            for item in block.get('content') or []:
                if not isinstance(item, dict) or item.get('type') != 'web_search_result':
                    continue
                url = str(item.get('url') or '').strip()
                if not url or url in seen:
                    continue
                seen.add(url)
                source = {'url': url, 'title': str(item.get('title') or '').strip() or url}
                snippet = snippets.get(url) or str(item.get('snippet') or '').strip()
                if snippet:
                    source['snippet'] = snippet
                page_age = str(item.get('page_age') or '').strip()
                if page_age:
                    source['publishedAt'] = page_age
                sources.append(source)
                if len(sources) >= cap:
                    return sources
        return sources


class DeepSeekAdapter(OpenAICompatibleAdapter):
    code = 'deepseek'
    label = 'DeepSeek'
    cache_semantics = 'prompt-total'
    description = '使用 DeepSeek OpenAI 兼容协议'
    default_base_url = 'https://api.deepseek.com'
    # 模型名称由管理员从上游发现或手动配置；Provider 只声明协议能力，
    # 不替账号池猜测某个具体模型。
    default_model = ''
    default_models = ()

    # DeepSeek 在 Chat 基址旁边确实提供 /anthropic/v1/messages。
    anthropic_endpoint_beside_base = True

    @staticmethod
    def anthropic_messages_url(base_url):
        """Chat Completions 基址 → Anthropic Messages（服务端 web_search）地址。"""
        root = str(base_url or '').rstrip('/')
        if root.endswith('/v1'):
            root = root[:-3].rstrip('/')
        return f'{root}/anthropic/v1/messages'

    def assert_account_usable(self, *, base_url, api_key, timeout, proxy_url=None):
        """DeepSeek /models 在欠费时仍可能 200，需再查 /user/balance。"""
        try:
            request_kwargs = {
                'headers': {'Authorization': f'Bearer {api_key}', 'Accept': 'application/json'},
                'timeout': timeout,
            }
            proxies = proxy_mapping(proxy_url)
            if proxies:
                request_kwargs['proxies'] = proxies
            response = requests.get(f"{base_url.rstrip('/')}/user/balance", **request_kwargs)
        except requests.RequestException:
            return
        if response.status_code >= 400:
            return
        try:
            body = response.json()
        except ValueError:
            return
        if not isinstance(body, dict):
            return
        if body.get('is_available') is False:
            raise ProviderAdapterError('账号余额不足，无法调用模型', 402)
        infos = body.get('balance_infos')
        if not isinstance(infos, list) or not infos:
            return
        total = 0.0
        for item in infos:
            if not isinstance(item, dict):
                continue
            try:
                total += float(item.get('total_balance') or 0)
            except (TypeError, ValueError):
                continue
        if total <= 0:
            raise ProviderAdapterError('账号余额不足，无法调用模型', 402)


class OpenAIAdapter(OpenAICompatibleAdapter):
    code = 'openai'
    label = 'OpenAI'
    cache_semantics = 'prompt-total'
    description = '使用 OpenAI Chat Completions 协议'
    default_base_url = 'https://api.openai.com/v1'


class GenericOpenAIAdapter(OpenAICompatibleAdapter):
    code = 'openai-compatible'
    label = 'OpenAI 兼容服务'
    description = '适用于实现 /models 与 /chat/completions 的兼容服务'


class CustomOpenAIAdapter(GenericOpenAIAdapter):
    """保留历史 custom 值的兼容性，新建时建议使用 openai-compatible。"""
    code = 'custom'
    label = '自定义兼容服务'


class AnthropicAdapter(OpenAICompatibleAdapter):
    code = 'anthropic'
    label = 'Anthropic'
    protocol = 'anthropic-messages'
    available = True
    cache_semantics = 'disjoint-input'
    description = 'Anthropic Messages 原生接口画像'
    default_base_url = 'https://api.anthropic.com'


class GeminiReservedAdapter(ProviderAdapter):
    code = 'gemini'
    label = 'Google Gemini'
    protocol = 'google-generative-language'
    cache_semantics = 'prompt-total'
    description = '预留 generateContent/streamGenerateContent 协议转换接口'


_ADAPTERS = (
    DeepSeekAdapter(),
    OpenAIAdapter(),
    GenericOpenAIAdapter(),
    CustomOpenAIAdapter(),
    AnthropicAdapter(),
    GeminiReservedAdapter(),
)
_REGISTRY = {adapter.code: adapter for adapter in _ADAPTERS}


def get_provider_adapter(code):
    normalized = str(code or '').strip().lower()
    adapter = _REGISTRY.get(normalized)
    if not adapter:
        raise ProviderAdapterError(f'不支持的服务商：{normalized or "未指定"}', 422)
    return adapter


def provider_catalog(*, include_legacy=False):
    return [
        adapter.catalog_item()
        for adapter in _ADAPTERS
        if include_legacy or adapter.code != 'custom'
    ]


__all__ = ['ProviderAdapter', 'ProviderAdapterError', 'get_provider_adapter', 'provider_catalog']
