# -*- coding: utf-8 -*-
"""Agent 域共享常量。"""

# 自动路由模型名：网关按请求内容（含图→视觉模型、纯文本→文本目标）自动选择上游，
# 由「模型网关 → 模型路由」中 model_name=coati-auto 的一行路由配置驱动。
AUTO_ROUTE_MODEL = 'coati-auto'

# 账号声明的是「网关如何调用这个上游」，而不是笼统的厂商名称。入站协议由
# API 路径自动识别；调度前先确认该上游协议存在对应的请求/响应桥接，原生路径
# 原样转发，跨协议路径走 protocol_bridge 的显式矩阵。
UPSTREAM_OPENAI_CHAT = 'openai-chat'
UPSTREAM_ANTHROPIC_MESSAGES = 'anthropic-messages'
UPSTREAM_OPENAI_RESPONSES = 'openai-responses'

UPSTREAM_PROTOCOLS = {
    UPSTREAM_OPENAI_CHAT: {
        'code': UPSTREAM_OPENAI_CHAT,
        'label': 'OpenAI Chat Completions',
        'description': '适用于提供 /chat/completions 的上游；其他入口协议由网关转换后调用。',
        'endpoint_suffix': '/chat/completions',
        'model_discovery': True,
        'accepted_inbound': ('openai', 'anthropic', 'responses'),
    },
    UPSTREAM_ANTHROPIC_MESSAGES: {
        'code': UPSTREAM_ANTHROPIC_MESSAGES,
        'label': 'Anthropic Messages',
        'description': '适用于提供 /v1/messages 的上游，例如 DashScope Anthropic 兼容入口；其他入口协议由网关转换。',
        'endpoint_suffix': '/v1/messages',
        # Anthropic 官方有 GET /v1/models，兼容入口则不一定提供。这里不预判：
        # 去试一次，上游没有就返回空清单，管理员再手动填。写死成 False 只会
        # 把本来能自动拉取的账号（例如 DeepSeek）也一起挡掉。
        'model_discovery': True,
        # 但 /models 通了并不能证明 /v1/messages 能用——两个端点未必同源。
        # 所以这条协议的模型发现只用来填清单，不作为健康判据。
        'model_discovery_verifies_health': False,
        'accepted_inbound': ('openai', 'anthropic', 'responses'),
    },
    UPSTREAM_OPENAI_RESPONSES: {
        'code': UPSTREAM_OPENAI_RESPONSES,
        'label': 'OpenAI Responses',
        'description': '适用于提供 /responses 的上游；其他入口协议由网关转换。',
        'endpoint_suffix': '/responses',
        'model_discovery': True,
        'accepted_inbound': ('openai', 'anthropic', 'responses'),
    },
}


def legacy_upstream_protocol(provider=None, base_url=None):
    """为旧账号选择最接近原转发行为的单一上游接口。"""
    provider = str(provider or '').strip().lower()
    base_url = str(base_url or '').strip().lower()
    # 旧 DeepSeek Adapter 的确额外提供了一个 Anthropic Messages 入口，
    # 但历史账号的主路径是 OpenAI Chat；升级时必须保住原有 Chat 客户端。
    # 只有地址明确是 Anthropic 入口，或厂商本身就是 Anthropic，才迁到 Messages。
    if '/anthropic' in base_url or provider == 'anthropic':
        return UPSTREAM_ANTHROPIC_MESSAGES
    # 旧 OpenAI Adapter 同时支持 Chat 与 Responses，无法从 provider 判断实际
    # 用法。其余旧账号统一回落 Chat：它可承接三种入站协议并由网关转换。
    return UPSTREAM_OPENAI_CHAT


def credential_upstream_protocol(credential):
    value = str(getattr(credential, 'upstream_protocol', '') or '').strip().lower()
    if value in UPSTREAM_PROTOCOLS:
        return value
    return legacy_upstream_protocol(
        getattr(credential, 'provider', None), getattr(credential, 'base_url', None),
    )


def upstream_accepts_inbound(upstream_protocol, inbound_protocol):
    item = UPSTREAM_PROTOCOLS.get(str(upstream_protocol or '').strip().lower())
    return bool(item and inbound_protocol in item['accepted_inbound'])


def upstream_protocol_catalog():
    return [
        {**item, 'accepted_inbound': list(item['accepted_inbound'])}
        for item in UPSTREAM_PROTOCOLS.values()
    ]

# 计入配额与用量统计的计费状态（成功、流式中断、客户端中断仍计费）
BILLABLE_USAGE_STATUSES = ('ok', 'stream_error', 'client_error')
