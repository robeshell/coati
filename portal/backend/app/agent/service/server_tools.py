# -*- coding: utf-8 -*-
"""Anthropic 服务端工具（server tool）。

server tool 与普通客户端工具的根本区别：搜索由服务端自己执行完再把结果注入
对话，客户端拿到的是「已经搜完」的结果块，没有任何工具要它去跑。所以网关必须
把 tools[] 里的 web_search_* 声明拦下来，换成上游能理解的普通工具声明，等上游
发出调用后自己闭环，最后按官方形状拼回 server_tool_use / web_search_tool_result。

字段形状以官方 web search tool 文档为准：
- 工具版本有三个：web_search_20250305 / web_search_20260209 / web_search_20260318，
  统一按 `web_search_` 前缀识别。
- 结果项只有 url / title / page_age / encrypted_content，没有 snippet。
- 出错时不是 HTTP 错误：content 从「列表」变成单个对象
  {"type": "web_search_tool_result_error", "error_code": ...}，官方 SDK 就是靠
  list / object 分支的。
"""

import base64
import json
import re
import threading

from backend.app.agent.service.protocol_bridge import encode_sse

WEB_SEARCH_TOOL_PREFIX = 'web_search_'
WEB_SEARCH_TOOL_NAME = 'web_search'
DEFAULT_WEB_SEARCH_TOOL_TYPE = 'web_search_20250305'

# 官方错误码全集；网关只会产出其中一部分，但校验时按这份清单收敛。
WEB_SEARCH_ERROR_CODES = (
    'too_many_requests',
    'invalid_tool_input',
    'max_uses_exceeded',
    'query_too_long',
    'request_too_large',
    'unavailable',
)

WEB_FETCH_TOOL_PREFIX = 'web_fetch_'
WEB_FETCH_TOOL_NAME = 'web_fetch'
DEFAULT_WEB_FETCH_TOOL_TYPE = 'web_fetch_20250910'

WEB_FETCH_ERROR_CODES = (
    'invalid_tool_input',
    'url_too_long',
    'url_not_allowed',
    'url_not_accessible',
    'unsupported_content_type',
    'too_many_requests',
    'max_uses_exceeded',
    'unavailable',
)

# 网关不执行、也不静默透传的服务端工具。这些要么需要网关不该拥有的基础设施
# （沙箱），要么还没有需求；一律明确拒绝，让调用方看到原因，而不是转发出去
# 等一个永远不会有人执行的 tool_use——那正是 web_search 当初的坑。
REJECTED_SERVER_TOOL_PREFIXES = (
    'code_execution_',
    'bash_code_execution_',
    'text_editor_code_execution_',
    'tool_search_tool_',
)

MAX_URL_LENGTH = 2048

# 官方 max_uses 不填时不设上限；网关必须有个兜底，否则模型可以无限循环。
DEFAULT_MAX_USES = 5
# 单次搜索取回的结果条数（web_search 端点自身上限为 8）。
SEARCH_RESULT_LIMIT = 8
# 官方限制查询长度；超长直接按 query_too_long 回错误块，不浪费一次上游往返。
MAX_QUERY_LENGTH = 400

# encrypted_content 在官方语义里是「必须原样回传、由服务端解密」的不透明串。
# 网关自己就是这里的服务端，于是把正文塞进这个串：下一轮客户端把它带回来时，
# 历史归一化可以还原出真正的网页内容，而不是只剩标题和链接。
_ENCRYPTED_PREFIX = 'coati1:'

# 换给上游的普通工具声明。原来的 server tool 声明经 anthropic→openai 桥接后会变成
# 一个 parameters 为空对象的 function，模型只能自己瞎编参数名（实测 qwen 发出的是
# {"queries": "[...]"}）。给出显式 input_schema 才能从根上治掉这个问题。
WEB_SEARCH_CLIENT_TOOL = {
    'name': WEB_SEARCH_TOOL_NAME,
    'description': (
        'Search the web for current information. '
        'Returns a ranked list of result pages with title, URL and page content. '
        'Use one focused query per call.'
    ),
    'input_schema': {
        'type': 'object',
        'properties': {
            'query': {
                'type': 'string',
                'description': 'The search query.',
            },
        },
        'required': ['query'],
    },
}


# ─── 工具声明：拦下 server tool ────────────────────────────────────────────────

WEB_FETCH_CLIENT_TOOL = {
    'name': WEB_FETCH_TOOL_NAME,
    'description': (
        'Fetch the full text content of a web page by URL. '
        'Use it when you already know the exact page to read.'
    ),
    'input_schema': {
        'type': 'object',
        'properties': {
            'url': {
                'type': 'string',
                'description': 'The absolute URL of the page to fetch.',
            },
        },
        'required': ['url'],
    },
}


def is_web_search_tool(tool):
    return server_tool_kind(tool) == WEB_SEARCH_TOOL_NAME


def server_tool_kind(tool):
    """这条工具声明属于哪一类服务端工具；普通客户端工具返回 None。

    只按 type 前缀判断——name 由调用方自选，不能作为依据。
    """
    if not isinstance(tool, dict):
        return None
    kind = str(tool.get('type') or '')
    if kind.startswith(WEB_SEARCH_TOOL_PREFIX):
        return WEB_SEARCH_TOOL_NAME
    if kind.startswith(WEB_FETCH_TOOL_PREFIX):
        return WEB_FETCH_TOOL_NAME
    if any(kind.startswith(prefix) for prefix in REJECTED_SERVER_TOOL_PREFIXES):
        return kind
    return None


def responses_builtin_tool_types(body):
    """Responses 请求里声明的内置（服务端）工具类型。

    Responses 的 tools 数组里，type 不是 function 的都是由服务端执行的内置工具
    （web_search / file_search / code_interpreter / mcp ...）。跨协议转换时它们
    无法表达，只有原生 Responses 上游能执行——所以选路要优先照顾这一点，
    否则同一个请求换把账号就会被拒。
    """
    body = body if isinstance(body, dict) else {}
    types = []
    for tool in body.get('tools') or []:
        if not isinstance(tool, dict):
            continue
        kind = str(tool.get('type') or '').strip()
        if kind and kind != 'function':
            types.append(kind)
    return types


def is_rejected_server_tool(tool):
    kind = str((tool or {}).get('type') or '') if isinstance(tool, dict) else ''
    return any(kind.startswith(prefix) for prefix in REJECTED_SERVER_TOOL_PREFIXES)


def _int_or_none(value):
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None


def _domain_list(value):
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item or '').strip()]


def web_search_config(tool):
    """把 server tool 声明收敛成网关内部配置。"""
    tool = tool if isinstance(tool, dict) else {}
    return {
        'type': str(tool.get('type') or DEFAULT_WEB_SEARCH_TOOL_TYPE),
        'name': str(tool.get('name') or WEB_SEARCH_TOOL_NAME),
        'max_uses': _int_or_none(tool.get('max_uses')),
        'allowed_domains': _domain_list(tool.get('allowed_domains')),
        'blocked_domains': _domain_list(tool.get('blocked_domains')),
        'user_location': tool.get('user_location') if isinstance(tool.get('user_location'), dict) else None,
    }


def web_fetch_config(tool):
    tool = tool if isinstance(tool, dict) else {}
    return {
        'type': str(tool.get('type') or DEFAULT_WEB_FETCH_TOOL_TYPE),
        'name': str(tool.get('name') or WEB_FETCH_TOOL_NAME),
        'max_uses': _int_or_none(tool.get('max_uses')),
        'allowed_domains': _domain_list(tool.get('allowed_domains')),
        'blocked_domains': _domain_list(tool.get('blocked_domains')),
        'max_content_tokens': _int_or_none(tool.get('max_content_tokens')),
        'citations': tool.get('citations') if isinstance(tool.get('citations'), dict) else None,
    }


SERVER_TOOL_CONFIG_BUILDERS = {
    WEB_SEARCH_TOOL_NAME: web_search_config,
    WEB_FETCH_TOOL_NAME: web_fetch_config,
}


def extract_server_tools(body):
    """摘掉所有服务端工具声明并记住参数。

    返回 (configs, rejected, body)：configs 是 {工具名: 配置}，rejected 是网关
    既不执行也不该静默透传的声明类型。换成什么形状取决于最终路由到哪把账号，
    见 apply_server_tools。
    """
    body = dict(body or {})
    tools = body.get('tools')
    if not isinstance(tools, list):
        return {}, [], body
    configs = {}
    rejected = []
    remaining = []
    for tool in tools:
        kind = server_tool_kind(tool)
        if kind is None:
            remaining.append(tool)
            continue
        if kind in SERVER_TOOL_CONFIG_BUILDERS:
            configs.setdefault(kind, SERVER_TOOL_CONFIG_BUILDERS[kind](tool))
        else:
            rejected.append(kind)
        continue
    if not configs and not rejected:
        return {}, [], body
    for name, config in configs.items():
        # 客户端自己也声明了同名工具时以客户端的为准：它有自己的执行方，
        # 网关不能把别人的工具抢过来自己跑。
        config['client_tool_conflict'] = any(
            isinstance(tool, dict) and tool.get('name') == name for tool in remaining
        )
    body['tools'] = remaining
    return configs, rejected, body


def extract_web_search_tool(body):
    """摘掉 tools[] 里的 web_search_* 声明并记住它的参数。

    这里只负责摘，不负责换：换成什么形状取决于最终路由到哪把账号——能原生
    执行的上游要收到它自己协议的内置工具声明，不能的才换成网关代跑的普通工具。
    该决定只能在选路之后做，见 apply_web_search_tool。

    返回 (config, body)；没有声明时 config 为 None 且 body 原样。
    """
    body = dict(body or {})
    tools = body.get('tools')
    if not isinstance(tools, list):
        return None, body
    config = None
    remaining = []
    for tool in tools:
        if is_web_search_tool(tool):
            if config is None:
                config = web_search_config(tool)
            continue
        remaining.append(tool)
    if config is None:
        return None, body
    # 客户端自己也声明了同名工具时以客户端的为准：它有自己的执行方，
    # 网关不能把别人的工具抢过来自己跑。
    config['client_tool_conflict'] = any(
        isinstance(tool, dict) and tool.get('name') == WEB_SEARCH_TOOL_NAME
        for tool in remaining
    )
    body['tools'] = remaining
    return config, body


# ─── 按上游协议决定工具形状 ───────────────────────────────────────────────────

UPSTREAM_ANTHROPIC_MESSAGES = 'anthropic-messages'
UPSTREAM_OPENAI_RESPONSES = 'openai-responses'
UPSTREAM_OPENAI_CHAT = 'openai-chat'

# Responses 原生 web_search 的输出项需要显式 include 才会带回来源。
RESPONSES_SOURCES_INCLUDE = 'web_search_call.action.sources'


def _responses_user_location(user_location):
    """Responses 的 WebSearchTool.UserLocation 没有 type 字段，只有四个自由文本项。"""
    if not isinstance(user_location, dict):
        return None
    picked = {
        key: str(user_location.get(key)).strip()
        for key in ('city', 'region', 'country', 'timezone')
        if str(user_location.get(key) or '').strip()
    }
    return picked or None


def native_web_search_tool(config, upstream_protocol):
    """上游协议的内置搜索工具声明；无法忠实表达这份配置时返回 None。

    宁可退回网关闭环，也不能悄悄丢掉客户端要求的约束：Responses 的原生工具
    只有 filters.allowed_domains，既没有域名黑名单也没有 max_uses，带了这两项
    就不能走原生。
    """
    config = config or {}
    if upstream_protocol == UPSTREAM_ANTHROPIC_MESSAGES:
        tool = {
            'type': config.get('type') or DEFAULT_WEB_SEARCH_TOOL_TYPE,
            'name': WEB_SEARCH_TOOL_NAME,
        }
        if config.get('max_uses') is not None:
            tool['max_uses'] = config['max_uses']
        for key in ('allowed_domains', 'blocked_domains'):
            if config.get(key):
                tool[key] = list(config[key])
        if config.get('user_location'):
            tool['user_location'] = config['user_location']
        return tool
    if upstream_protocol == UPSTREAM_OPENAI_RESPONSES:
        if config.get('blocked_domains') or config.get('max_uses') is not None:
            return None
        tool = {'type': 'web_search'}
        if config.get('allowed_domains'):
            tool['filters'] = {'allowed_domains': list(config['allowed_domains'])}
        location = _responses_user_location(config.get('user_location'))
        if location:
            tool['user_location'] = location
        return tool
    return None


def native_web_fetch_tool(config, upstream_protocol):
    """web_fetch 只有 Anthropic Messages 有内置形状；Responses 没有对应工具。"""
    if upstream_protocol != UPSTREAM_ANTHROPIC_MESSAGES:
        return None
    config = config or {}
    tool = {
        'type': config.get('type') or DEFAULT_WEB_FETCH_TOOL_TYPE,
        'name': WEB_FETCH_TOOL_NAME,
    }
    if config.get('max_uses') is not None:
        tool['max_uses'] = config['max_uses']
    if config.get('max_content_tokens') is not None:
        tool['max_content_tokens'] = config['max_content_tokens']
    for key in ('allowed_domains', 'blocked_domains'):
        if config.get(key):
            tool[key] = list(config[key])
    if config.get('citations'):
        tool['citations'] = config['citations']
    return tool


NATIVE_SERVER_TOOL_BUILDERS = {
    WEB_SEARCH_TOOL_NAME: native_web_search_tool,
    WEB_FETCH_TOOL_NAME: native_web_fetch_tool,
}


def _gateway_tool_in_protocol_shape(client_tool, upstream_protocol):
    """网关代跑时给上游的普通工具声明，按上游协议的工具格式给。

    原来的 server tool 声明经协议桥接后会退化成一个 parameters 为空对象的
    function，模型只能自己瞎编参数名（实测 qwen 发出的是 {"queries": "[...]"}）。
    给出显式 schema 才能从根上治掉。
    """
    spec = json.loads(json.dumps(client_tool))
    if upstream_protocol == UPSTREAM_ANTHROPIC_MESSAGES:
        return spec
    if upstream_protocol == UPSTREAM_OPENAI_RESPONSES:
        return {
            'type': 'function',
            'name': spec['name'],
            'description': spec['description'],
            'parameters': spec['input_schema'],
        }
    return {
        'type': 'function',
        'function': {
            'name': spec['name'],
            'description': spec['description'],
            'parameters': spec['input_schema'],
        },
    }


def gateway_web_search_tool(upstream_protocol):
    return _gateway_tool_in_protocol_shape(WEB_SEARCH_CLIENT_TOOL, upstream_protocol)


def gateway_web_fetch_tool(upstream_protocol):
    return _gateway_tool_in_protocol_shape(WEB_FETCH_CLIENT_TOOL, upstream_protocol)


GATEWAY_SERVER_TOOL_BUILDERS = {
    WEB_SEARCH_TOOL_NAME: gateway_web_search_tool,
    WEB_FETCH_TOOL_NAME: gateway_web_fetch_tool,
}


def _tool_names(tool):
    if not isinstance(tool, dict):
        return ''
    if tool.get('name'):
        return tool['name']
    fn = tool.get('function')
    return fn.get('name') if isinstance(fn, dict) else ''


def apply_web_search_tool(body, config, upstream_protocol, *, native, offer=True,
                          kind=WEB_SEARCH_TOOL_NAME):
    """把搜索工具按上游协议注入已经桥接好的出站 body。

    native=True 表示这把账号会自己执行搜索，注入它协议的内置工具声明并原样透传
    结果；否则注入网关代跑用的普通工具。offer=False 表示本轮不再提供搜索
    （闭环的收尾轮），此时要把先前注入的声明撤掉。

    客户端自己声明了同名工具时整个函数不作为：那把工具有它自己的执行方，
    网关既不能替换也不能撤掉。
    """
    if config is None or config.get('client_tool_conflict'):
        return body
    body = dict(body or {})
    tool = None
    if offer:
        tool = (
            NATIVE_SERVER_TOOL_BUILDERS[kind](config, upstream_protocol) if native
            else GATEWAY_SERVER_TOOL_BUILDERS[kind](upstream_protocol)
        )
    # 只清理网关自己注入的那一个；此时 body 里不会有客户端的同名工具。
    tools = [
        item for item in (body.get('tools') or [])
        if _tool_names(item) != kind
    ]
    if tool is not None:
        tools.append(tool)
        if native and kind == WEB_SEARCH_TOOL_NAME and upstream_protocol == UPSTREAM_OPENAI_RESPONSES:
            include = [
                item for item in (body.get('include') or [])
                if item != RESPONSES_SOURCES_INCLUDE
            ]
            include.append(RESPONSES_SOURCES_INCLUDE)
            body['include'] = include
    if tools:
        body['tools'] = tools
    else:
        body.pop('tools', None)
        body.pop('tool_choice', None)
    choice = body.get('tool_choice')
    if isinstance(choice, dict) and choice.get('name') == kind and tool is None:
        # tool_choice 还指着已经撤掉的工具会被上游判成非法请求。
        body['tool_choice'] = {'type': 'auto'}
    return body


NATIVE_WEB_SEARCH_PROTOCOLS = (UPSTREAM_ANTHROPIC_MESSAGES, UPSTREAM_OPENAI_RESPONSES)


def apply_server_tools(body, configs, upstream_protocol, *, native_kinds=(), offer=True):
    """把所有服务端工具按上游协议注入已经桥接好的出站 body。

    native_kinds 里的工具交给上游原生执行（注入它协议的内置声明并原样透传结果），
    其余注入网关代跑用的普通工具。offer=False 表示本轮不再提供（闭环收尾轮）。
    """
    for name, config in (configs or {}).items():
        body = apply_web_search_tool(
            body, config, upstream_protocol,
            native=name in native_kinds, offer=offer, kind=name,
        )
    return body


def protocol_supports_native_web_search(upstream_protocol, config=None):
    """协议轴：这个上游协议有没有内置搜索形状，且能忠实表达这份配置。"""
    return native_web_search_tool(config or {}, upstream_protocol) is not None


class ServerToolSupportRegistry:
    """账号轴：按账号记住上游到底执不执行 server tool。

    这件事既推不出也配不准。厂商名推不出——它只说明画像，不说明这个端点的行为；
    上游协议也推不出——DashScope 的 Anthropic 兼容入口协议完全对得上，但它只会
    把 server tool 当普通工具打回来。唯一可靠的办法是发一次看回来什么：回来
    server_tool_use 就是执行了，回来普通 tool_use 就是没执行。

    观测结果只活在进程内：它是上游行为的缓存而不是配置，重启后重新学一次的
    代价只有一轮往返，而写进库里反而会把一次偶发观测固化成长期事实。
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._state = {}

    def executes(self, credential_id):
        """True/False 为已探明；None 表示还没探过，应当乐观地试一次原生。"""
        if credential_id is None:
            return None
        with self._lock:
            return self._state.get(credential_id)

    def record(self, credential_id, executes):
        if credential_id is None:
            return
        with self._lock:
            self._state[credential_id] = bool(executes)

    def clear(self, credential_id=None):
        with self._lock:
            if credential_id is None:
                self._state.clear()
            else:
                self._state.pop(credential_id, None)


WEB_SEARCH_SUPPORT = ServerToolSupportRegistry()


def native_server_tool_kinds(upstream_protocol, credential_id, configs):
    """这一轮哪些服务端工具可以交给上游原生执行。

    只有**已确认会执行**的账号才走原生，未探明的一律先用网关代跑的普通工具。

    这里曾经是「没被确认不执行就乐观地试一次」，但那个策略修不好：原生探测
    的回包里没有任何工具活动时，无法区分「上游忽略了声明」和「模型觉得不用
    搜」——实测同一把账号两次行为都不一样（一次把调用吐成文本，一次直接说
    自己不能联网）。靠猜就必然时好时坏。

    确认走的是另一条确定性路径：resolve_search_routes 真的让账号搜一次，
    看有没有结果回来，成功记 True、失败记 False。那是个明确的问题，有明确的
    答案。代价只是每个 worker 首次搜索少一次原生透传，之后自动收敛。
    """
    if WEB_SEARCH_SUPPORT.executes(credential_id) is not True:
        return set()
    return {
        name for name, config in (configs or {}).items()
        if NATIVE_SERVER_TOOL_BUILDERS[name](config, upstream_protocol) is not None
    }


def should_try_native_web_search(upstream_protocol, credential_id, config):
    """要不要把原生声明发给这把账号：协议有内置形状，且已确认它会执行。"""
    if not protocol_supports_native_web_search(upstream_protocol, config):
        return False
    return WEB_SEARCH_SUPPORT.executes(credential_id) is True


# ─── 查询词解析 ────────────────────────────────────────────────────────────────

_QUERY_KEYS = ('query', 'queries', 'q', 'search_query', 'search_queries')


def _loads_or_none(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def _flatten_query(value):
    if isinstance(value, list):
        out = []
        for item in value:
            out.extend(_flatten_query(item))
        return out
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        parsed = _loads_or_none(text)
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item or '').strip()]
        return [text]
    if value is None:
        return []
    text = str(value).strip()
    return [text] if text else []


def search_queries_from_input(value):
    """从 tool_use.input 取查询词。

    官方形状是 {'query': '...'}（单数）。但网关后面的模型不一定照办：实测
    qwen 发出的是 {'queries': '["a", "b"]'}——字段名复数、值还是个 JSON 字符串。
    两种形状都要能吃，否则取不到查询词，搜索永远是空的。
    """
    if isinstance(value, str):
        parsed = _loads_or_none(value)
        value = parsed if isinstance(parsed, dict) else {'query': value}
    if not isinstance(value, dict):
        return []
    collected = []
    for key in _QUERY_KEYS:
        if key in value:
            collected.extend(_flatten_query(value[key]))
    seen = set()
    queries = []
    for item in collected:
        if item and item not in seen:
            seen.add(item)
            queries.append(item)
    return queries


def localized_query(query, user_location):
    """user_location 是本地化提示；上游搜索后端吃的是自然语言查询，附加地点词。"""
    if not isinstance(user_location, dict):
        return query
    parts = [
        str(user_location.get(key) or '').strip()
        for key in ('city', 'region', 'country')
    ]
    parts = [part for part in parts if part]
    if not parts:
        return query
    return f"{query} ({', '.join(parts)})"


# ─── 域名过滤 ──────────────────────────────────────────────────────────────────

_SCHEME_RE = re.compile(r'^[a-z][a-z0-9+.-]*://', re.IGNORECASE)


def _domain_key(entry):
    """归一成 (host, path)；官方要求条目是不带协议的裸域名，可选带路径。"""
    text = str(entry or '').strip().lower()
    if not text:
        return None
    text = _SCHEME_RE.sub('', text)
    text = text.split('?', 1)[0].split('#', 1)[0]
    host, _, path = text.partition('/')
    host = host.split('@')[-1].split(':')[0]
    if host.startswith('www.'):
        host = host[4:]
    if not host:
        return None
    path = path.strip('/')
    return host, (f'/{path}' if path else '')


def _domain_matches(url, entries):
    target = _domain_key(url)
    if not target:
        return False
    host, path = target
    for entry in entries:
        key = _domain_key(entry)
        if not key:
            continue
        entry_host, entry_path = key
        if host != entry_host and not host.endswith(f'.{entry_host}'):
            continue
        if entry_path and not (path == entry_path or path.startswith(f'{entry_path}/')):
            continue
        return True
    return False


def filter_sources(sources, config):
    """官方 allowed_domains / blocked_domains 由服务端执行，二选一。"""
    config = config or {}
    allowed = config.get('allowed_domains') or []
    blocked = config.get('blocked_domains') or []
    items = [item for item in (sources or []) if isinstance(item, dict)]
    if allowed:
        return [item for item in items if _domain_matches(item.get('url'), allowed)]
    if blocked:
        return [item for item in items if not _domain_matches(item.get('url'), blocked)]
    return items


# ─── 内容块构造 ────────────────────────────────────────────────────────────────

def _encrypt_content(payload):
    raw = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    return _ENCRYPTED_PREFIX + base64.urlsafe_b64encode(raw).decode('ascii')


def _decrypt_content(value):
    text = str(value or '')
    if not text.startswith(_ENCRYPTED_PREFIX):
        return None
    try:
        raw = base64.urlsafe_b64decode(text[len(_ENCRYPTED_PREFIX):].encode('ascii'))
        decoded = json.loads(raw.decode('utf-8'))
    except (ValueError, TypeError):
        return None
    return decoded if isinstance(decoded, dict) else None


def server_tool_use_block(block_id, query):
    return {
        'type': 'server_tool_use',
        'id': block_id,
        'name': WEB_SEARCH_TOOL_NAME,
        'input': {'query': query},
    }


def fetch_tool_use_block(block_id, url):
    return {
        'type': 'server_tool_use',
        'id': block_id,
        'name': WEB_FETCH_TOOL_NAME,
        'input': {'url': url},
    }


def web_search_result_item(source):
    """官方结果项字段：url / title / page_age / encrypted_content。"""
    source = source if isinstance(source, dict) else {}
    url = str(source.get('url') or '').strip()
    title = str(source.get('title') or '').strip() or url
    item = {'type': 'web_search_result', 'url': url, 'title': title}
    page_age = str(source.get('page_age') or source.get('publishedAt') or '').strip()
    if page_age:
        item['page_age'] = page_age
    content = str(source.get('content') or source.get('snippet') or '').strip()
    item['encrypted_content'] = _encrypt_content({
        'url': url, 'title': title, 'content': content, 'page_age': page_age,
    })
    return item


def web_search_tool_result_block(tool_use_id, sources):
    """成功：content 是列表。零结果返回空列表，不是错误。"""
    return {
        'type': 'web_search_tool_result',
        'tool_use_id': tool_use_id,
        'content': [web_search_result_item(source) for source in sources or []],
    }


def web_search_error_block(tool_use_id, error_code):
    """出错：content 变成单个对象，不是列表——官方 SDK 靠这个分支。"""
    code = error_code if error_code in WEB_SEARCH_ERROR_CODES else 'unavailable'
    return {
        'type': 'web_search_tool_result',
        'tool_use_id': tool_use_id,
        'content': {'type': 'web_search_tool_result_error', 'error_code': code},
    }


def fetch_url_from_input(value):
    """从 tool_use.input 取 URL。

    官方形状是 {'url': '...'}。同样按 web_search 的教训兼容复数与 JSON 字符串
    形状——网关后面的模型不一定照官方 schema 发。
    """
    if isinstance(value, str):
        parsed = _loads_or_none(value)
        value = parsed if isinstance(parsed, dict) else {'url': value}
    if not isinstance(value, dict):
        return None
    for key in ('url', 'urls', 'link', 'uri'):
        if key not in value:
            continue
        for item in _flatten_query(value[key]):
            if item:
                return item
    return None


def web_fetch_result_block(tool_use_id, fetched, *, citations=None):
    """成功：content 是单个 web_fetch_result 对象，正文包在 DocumentBlock 里。

    注意与 web_search 不同——那边成功时 content 是列表，这边是对象；
    两种结果都是对象，靠 type 区分成功与失败。
    """
    fetched = fetched or {}
    url = str(fetched.get('url') or '').strip()
    return {
        'type': 'web_fetch_tool_result',
        'tool_use_id': tool_use_id,
        'content': {
            'type': 'web_fetch_result',
            'url': url,
            'retrieved_at': fetched.get('retrieved_at'),
            'content': {
                'type': 'document',
                'title': fetched.get('title') or None,
                'citations': citations or {'enabled': True},
                'source': {
                    'type': 'text',
                    'media_type': 'text/plain',
                    'data': str(fetched.get('text') or ''),
                },
            },
        },
    }


def web_fetch_error_block(tool_use_id, error_code):
    code = error_code if error_code in WEB_FETCH_ERROR_CODES else 'unavailable'
    return {
        'type': 'web_fetch_tool_result',
        'tool_use_id': tool_use_id,
        'content': {'type': 'web_fetch_tool_result_error', 'error_code': code},
    }


def render_fetch_result(url, fetched):
    fetched = fetched or {}
    title = str(fetched.get('title') or '').strip()
    text = str(fetched.get('text') or '').strip()
    header = f'Fetched {url}'
    if title:
        header += f' — {title}'
    return f'{header}\n\n{text}' if text else f'{header}\n\n(empty page)'


def render_fetch_error(url, error_code, detail=None):
    text = f'Fetching "{url}" failed: {error_code}.'
    return f'{text} {detail}' if detail else text


def is_web_search_call(block):
    """上游发出的、需要网关代跑的搜索调用（普通 tool_use）。"""
    return (
        isinstance(block, dict)
        and block.get('type') == 'tool_use'
        and block.get('name') == WEB_SEARCH_TOOL_NAME
    )


SERVER_TOOL_NAMES = (WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME)
SERVER_TOOL_RESULT_TYPES = ('web_search_tool_result', 'web_fetch_tool_result')


# 有些上游收到不认识的 server tool 声明后既不执行、也不退化成结构化 tool_use，
# 而是把模型生成的 Hermes/Qwen 风格调用原样当正文吐出来。实测阿里云 MaaS 的
# Anthropic 兼容入口就是这样。这是第三种回包形状，必须单独识别——否则它既不
# 会被判成原生、也进不了闭环，最后带着这段标记直接回给客户端。
_LEAKED_TOOL_CALL_MARKERS = ('<tool_call>', '<function=', '<｜tool▁call▁begin｜>')


def has_leaked_tool_call_text(blocks):
    for block in blocks or []:
        if not isinstance(block, dict) or block.get('type') != 'text':
            continue
        text = str(block.get('text') or '')
        if any(marker in text for marker in _LEAKED_TOOL_CALL_MARKERS):
            return True
    return False


def is_server_tool_call(block):
    """上游发出的、需要网关代跑的服务端工具调用（普通 tool_use）。"""
    return (
        isinstance(block, dict)
        and block.get('type') == 'tool_use'
        and block.get('name') in SERVER_TOOL_NAMES
    )


def is_server_web_search_block(block):
    """上游自己就执行完了服务端工具时产出的块，原样透传即可。"""
    if not isinstance(block, dict):
        return False
    if block.get('type') in SERVER_TOOL_RESULT_TYPES:
        return True
    return (
        block.get('type') == 'server_tool_use'
        and block.get('name') in SERVER_TOOL_NAMES
    )


# ─── 给上游看的纯文本渲染 ──────────────────────────────────────────────────────

def render_search_results(query, sources):
    sources = [item for item in (sources or []) if isinstance(item, dict)]
    if not sources:
        return f'Search results for "{query}": no results found.'
    lines = [f'Search results for "{query}":']
    for index, source in enumerate(sources, start=1):
        url = str(source.get('url') or '').strip()
        title = str(source.get('title') or '').strip() or url
        lines.append(f'[{index}] {title}')
        if url:
            lines.append(f'URL: {url}')
        page_age = str(source.get('page_age') or source.get('publishedAt') or '').strip()
        if page_age:
            lines.append(f'Updated: {page_age}')
        content = str(source.get('content') or source.get('snippet') or '').strip()
        if content:
            lines.append(content)
        lines.append('')
    return '\n'.join(lines).strip()


def render_search_error(query, error_code, detail=None):
    text = f'Search for "{query}" failed: {error_code}.'
    return f'{text} {detail}' if detail else text


# ─── 纯搜索请求的短路 ─────────────────────────────────────────────────────────

# Claude Code 的 WebSearch 会为搜索单独发一个子请求，正文就是这句话。
_SEARCH_ONLY_LEAD_INS = (
    'perform a web search for the query:',
    'perform a web search for:',
)


def _last_user_text(messages):
    for message in reversed(messages or []):
        if not isinstance(message, dict) or message.get('role') != 'user':
            continue
        content = message.get('content')
        if isinstance(content, str):
            return content.strip()
        if not isinstance(content, list):
            return ''
        parts = [
            part.get('text') or '' for part in content
            if isinstance(part, dict) and part.get('type') == 'text'
        ]
        # 这一轮里只要带了工具结果，就不是「纯搜索请求」。
        if any(
            isinstance(part, dict) and part.get('type') in ('tool_result', 'image')
            for part in content
        ):
            return ''
        return '\n'.join(text for text in parts if text).strip()
    return ''


def search_only_query(body, configs):
    """识别「这一整个请求只是为了搜一次」，返回查询词；不是则返回 None。

    Claude Code 的 WebSearch 就是这种形态：单独一个子请求、只声明 web_search
    一个工具、正文是固定引导语加查询词。这种请求让模型参与没有意义——它既不
    需要决定搜什么，也不需要基于结果继续推理——却要付两轮以上的上游 token。

    **必须命中引导语才短路。** 只看「单条消息 + 只有搜索工具」是不够的：
    「Claude Code 多少钱？」＋ web_search 工具同样满足，但那是正常对话，
    用户要的是模型的回答而不是一串链接。省 token 不能以截胡对话为代价。
    """
    if set(configs or {}) != {WEB_SEARCH_TOOL_NAME}:
        return None
    if (configs[WEB_SEARCH_TOOL_NAME] or {}).get('client_tool_conflict'):
        return None
    body = body if isinstance(body, dict) else {}
    # 摘掉 server tool 之后还剩别的工具，说明客户端还指望模型能调它们。
    if body.get('tools'):
        return None
    messages = body.get('messages') or []
    if len([m for m in messages if isinstance(m, dict)]) != 1:
        return None
    text = _last_user_text(messages)
    if not text:
        return None
    lowered = text.lower()
    for lead in _SEARCH_ONLY_LEAD_INS:
        if lowered.startswith(lead):
            return text[len(lead):].strip() or None
    return None


# ─── 多轮历史归一化 ────────────────────────────────────────────────────────────

def _render_history_result_block(block):
    content = block.get('content')
    if block.get('type') == 'web_fetch_tool_result':
        if not isinstance(content, dict):
            return 'Web fetch failed: unavailable.'
        if content.get('type') == 'web_fetch_tool_result_error':
            return f"Web fetch failed: {content.get('error_code') or 'unavailable'}."
        document = content.get('content') if isinstance(content.get('content'), dict) else {}
        source = document.get('source') if isinstance(document.get('source'), dict) else {}
        return render_fetch_result(content.get('url') or '', {
            'title': document.get('title'), 'text': source.get('data'),
        })
    if isinstance(content, dict):
        code = str(content.get('error_code') or 'unavailable')
        return f'Web search failed: {code}.'
    sources = []
    for item in content or []:
        if not isinstance(item, dict):
            continue
        decoded = _decrypt_content(item.get('encrypted_content')) or {}
        sources.append({
            'url': item.get('url') or decoded.get('url'),
            'title': item.get('title') or decoded.get('title'),
            'page_age': item.get('page_age') or decoded.get('page_age'),
            'content': decoded.get('content'),
        })
    return render_search_results('previous turn', sources)


def normalize_server_tool_history(body):
    """把客户端回传的 server tool 历史块降级成上游能吃的形状。

    官方要求下一轮把 server_tool_use / web_search_tool_result 原样带回来，
    Claude Code 也确实这么干。但上游（例如 DashScope 的 Anthropic 兼容入口）
    不认识这两个 type，原样转发大概率 400；而 anthropic→openai 桥接则会把它们
    静默丢掉，模型直接丢失上一轮的全部搜索结果。统一拍平成文本最稳：不引入
    tool_use / tool_result 的配对约束，任何上游协议都能接。
    """
    body = dict(body or {})
    messages = body.get('messages')
    if not isinstance(messages, list):
        return body
    changed = False
    normalized = []
    for message in messages:
        if not isinstance(message, dict) or not isinstance(message.get('content'), list):
            normalized.append(message)
            continue
        if not any(is_server_web_search_block(part) for part in message['content']):
            normalized.append(message)
            continue
        changed = True
        content = []
        for part in message['content']:
            if not is_server_web_search_block(part):
                content.append(part)
                continue
            if part.get('type') == 'server_tool_use':
                params = part.get('input') if isinstance(part.get('input'), dict) else {}
                if part.get('name') == WEB_FETCH_TOOL_NAME:
                    text = f"Fetched the page: {params.get('url') or ''}"
                else:
                    text = f"Searched the web for: {params.get('query') or ''}"
                content.append({'type': 'text', 'text': text.strip()})
            else:
                content.append({'type': 'text', 'text': _render_history_result_block(part)})
        if content:
            normalized.append({**message, 'content': content})
    if not changed:
        return body
    body['messages'] = normalized
    return body


# ─── 非流式响应 → Anthropic SSE ───────────────────────────────────────────────

def _block_events(index, block):
    if not isinstance(block, dict):
        return []
    kind = block.get('type')
    events = []
    if kind == 'text':
        events.append(encode_sse('content_block_start', {
            'type': 'content_block_start', 'index': index,
            'content_block': {'type': 'text', 'text': ''},
        }))
        text = block.get('text') or ''
        if text:
            events.append(encode_sse('content_block_delta', {
                'type': 'content_block_delta', 'index': index,
                'delta': {'type': 'text_delta', 'text': text},
            }))
        for citation in block.get('citations') or []:
            events.append(encode_sse('content_block_delta', {
                'type': 'content_block_delta', 'index': index,
                'delta': {'type': 'citations_delta', 'citation': citation},
            }))
    elif kind == 'thinking':
        events.append(encode_sse('content_block_start', {
            'type': 'content_block_start', 'index': index,
            'content_block': {'type': 'thinking', 'thinking': ''},
        }))
        thinking = block.get('thinking') or ''
        if thinking:
            events.append(encode_sse('content_block_delta', {
                'type': 'content_block_delta', 'index': index,
                'delta': {'type': 'thinking_delta', 'thinking': thinking},
            }))
        if block.get('signature'):
            events.append(encode_sse('content_block_delta', {
                'type': 'content_block_delta', 'index': index,
                'delta': {'type': 'signature_delta', 'signature': block['signature']},
            }))
    elif kind in ('tool_use', 'server_tool_use'):
        started = {key: value for key, value in block.items() if key != 'input'}
        started['input'] = {}
        events.append(encode_sse('content_block_start', {
            'type': 'content_block_start', 'index': index, 'content_block': started,
        }))
        events.append(encode_sse('content_block_delta', {
            'type': 'content_block_delta', 'index': index,
            'delta': {
                'type': 'input_json_delta',
                'partial_json': json.dumps(block.get('input') or {}, ensure_ascii=False),
            },
        }))
    else:
        # web_search_tool_result 等结果块整块随 content_block_start 下发，
        # 与官方流式示例一致。
        events.append(encode_sse('content_block_start', {
            'type': 'content_block_start', 'index': index, 'content_block': block,
        }))
    events.append(encode_sse('content_block_stop', {
        'type': 'content_block_stop', 'index': index,
    }))
    return events


def anthropic_message_to_sse(payload):
    """把已经拼好的非流式 Messages 响应铺成一条完整的 Anthropic SSE。

    服务端闭环必须先把搜索跑完才知道最终内容，无法边搜边流；这里保证下游拿到
    的事件序列与真实流式一致，客户端不需要区分。
    """
    payload = payload if isinstance(payload, dict) else {}
    message = {key: value for key, value in payload.items() if key != 'content'}
    message.setdefault('id', 'msg_coati')
    message.setdefault('type', 'message')
    message.setdefault('role', 'assistant')
    message['content'] = []
    chunks = [encode_sse('message_start', {'type': 'message_start', 'message': message})]
    for index, block in enumerate(payload.get('content') or []):
        chunks.extend(_block_events(index, block))
    delta = {'stop_reason': payload.get('stop_reason') or 'end_turn'}
    if payload.get('stop_sequence') is not None:
        delta['stop_sequence'] = payload['stop_sequence']
    chunks.append(encode_sse('message_delta', {
        'type': 'message_delta', 'delta': delta, 'usage': payload.get('usage') or {},
    }))
    chunks.append(encode_sse('message_stop', {'type': 'message_stop'}))
    return b''.join(chunks)


__all__ = [
    'DEFAULT_MAX_USES',
    'MAX_QUERY_LENGTH',
    'SEARCH_RESULT_LIMIT',
    'WEB_SEARCH_CLIENT_TOOL',
    'WEB_SEARCH_ERROR_CODES',
    'WEB_SEARCH_TOOL_NAME',
    'WEB_SEARCH_TOOL_PREFIX',
    'anthropic_message_to_sse',
    'apply_web_search_tool',
    'extract_web_search_tool',
    'gateway_web_search_tool',
    'native_web_search_tool',
    'protocol_supports_native_web_search',
    'should_try_native_web_search',
    'NATIVE_WEB_SEARCH_PROTOCOLS',
    'WEB_SEARCH_SUPPORT',
    'filter_sources',
    'has_leaked_tool_call_text',
    'is_server_web_search_block',
    'is_web_search_call',
    'is_web_search_tool',
    'localized_query',
    'normalize_server_tool_history',
    'render_search_error',
    'render_search_results',
    'responses_builtin_tool_types',
    'search_only_query',
    'search_queries_from_input',
    'server_tool_use_block',
    'web_search_config',
    'web_search_error_block',
    'web_search_result_item',
    'web_search_tool_result_block',
]
