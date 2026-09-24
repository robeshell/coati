# -*- coding: utf-8 -*-
"""三套 LLM 协议之间的受控转换层。

网关对外提供 Chat Completions、Anthropic Messages、OpenAI Responses 三种入口。
跨协议请求/响应按显式矩阵转换，同协议原样转发；流式响应统一经过受控的
Chat 事件中间层，避免把某个协议的 SSE 字段直接冒充成另一个协议。
"""

import json
import re
import time
from uuid import uuid4


class ProtocolBridgeError(ValueError):
    """上游响应无法安全转换为客户端协议。"""


def _text_from_blocks(value):
    if value in (None, ''):
        return ''
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return str(value)
    parts = []
    for item in value:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict) and item.get('type') in {
            'text', 'input_text', 'output_text', 'summary_text', 'refusal',
        }:
            parts.append(item.get('text') or item.get('refusal') or '')
    return ''.join(parts)


def _anthropic_image_part(part):
    source = part.get('source') if isinstance(part, dict) else None
    if not isinstance(source, dict):
        return None
    if source.get('type') == 'url' and source.get('url'):
        return {'type': 'image_url', 'image_url': {'url': source['url']}}
    if source.get('type') == 'base64' and source.get('data'):
        media = source.get('media_type') or 'image/png'
        return {'type': 'image_url', 'image_url': {'url': f'data:{media};base64,{source["data"]}'}}
    return None


def anthropic_to_openai_body(body):
    body = dict(body or {})
    messages = []
    system = body.get('system')
    if system:
        messages.append({'role': 'system', 'content': _text_from_blocks(system)})
    for msg in body.get('messages') or []:
        if not isinstance(msg, dict):
            continue
        messages.extend(_anthropic_message_to_openai(msg))
    out = {
        'model': body.get('model'),
        'messages': messages,
        'stream': bool(body.get('stream')),
    }
    if body.get('max_tokens') is not None:
        out['max_tokens'] = body['max_tokens']
    if body.get('temperature') is not None:
        out['temperature'] = body['temperature']
    if body.get('top_p') is not None:
        out['top_p'] = body['top_p']
    if body.get('stop_sequences'):
        out['stop'] = body['stop_sequences']
    user_id = _end_user_id(body)
    if user_id:
        out['user'] = user_id
    tools = []
    for tool in body.get('tools') or []:
        if not isinstance(tool, dict) or tool.get('name') in (None, ''):
            continue
        tools.append({
            'type': 'function',
            'function': {
                'name': tool.get('name'),
                'description': tool.get('description') or '',
                'parameters': tool.get('input_schema') or {'type': 'object', 'properties': {}},
            },
        })
    if tools:
        out['tools'] = tools
        choice = body.get('tool_choice')
        if isinstance(choice, dict):
            if choice.get('type') == 'none':
                out['tool_choice'] = 'none'
            elif choice.get('type') == 'auto':
                out['tool_choice'] = 'auto'
            elif choice.get('type') == 'any':
                out['tool_choice'] = 'required'
            elif choice.get('type') == 'tool' and choice.get('name'):
                out['tool_choice'] = {'type': 'function', 'function': {'name': choice['name']}}
    return out


def _json_object(value, message):
    if isinstance(value, dict):
        return value
    if value in (None, ''):
        return {}
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except (TypeError, ValueError) as exc:
        raise ProtocolBridgeError(message) from exc
    if not isinstance(parsed, dict):
        raise ProtocolBridgeError(message)
    return parsed


def _openai_image_to_anthropic(part):
    image = part.get('image_url') if isinstance(part, dict) else None
    image = image.get('url') if isinstance(image, dict) else image
    if not image:
        return None
    if str(image).startswith('data:') and ';base64,' in str(image):
        header, data = str(image).split(';base64,', 1)
        return {
            'type': 'image',
            'source': {
                'type': 'base64',
                'media_type': header[5:] or 'image/png',
                'data': data,
            },
        }
    return {'type': 'image', 'source': {'type': 'url', 'url': str(image)}}


def _openai_content_to_anthropic(content):
    if isinstance(content, str):
        return [{'type': 'text', 'text': content}] if content else []
    if not isinstance(content, list):
        return [{'type': 'text', 'text': _text_from_blocks(content)}]
    blocks = []
    for part in content:
        if isinstance(part, str):
            blocks.append({'type': 'text', 'text': part})
            continue
        if not isinstance(part, dict):
            continue
        kind = part.get('type')
        if kind in ('text', 'input_text', 'output_text'):
            blocks.append({'type': 'text', 'text': part.get('text') or ''})
        elif kind in ('image_url', 'input_image', 'image'):
            image = _openai_image_to_anthropic(part)
            if image:
                blocks.append(image)
    return blocks


def _openai_message_to_anthropic(msg):
    if not isinstance(msg, dict):
        return []
    role = msg.get('role') or 'user'
    if role == 'system':
        return []
    if role == 'tool':
        return [{
            'role': 'user',
            'content': [{
                'type': 'tool_result',
                'tool_use_id': msg.get('tool_call_id') or '',
                'content': msg.get('content') or '',
            }],
        }]

    content = _openai_content_to_anthropic(msg.get('content'))
    if role == 'assistant':
        reasoning = msg.get('reasoning_content')
        if reasoning:
            # thinking 块必须带 signature（ThinkingBlockParam 的必填字段），而
            # OpenAI 的 reasoning_content 没有对应物，合成一个签名不出来的
            # thinking 块会被上游判成非法。降级成普通文本，内容不丢。
            content.insert(0, {'type': 'text', 'text': str(reasoning)})
        for call in msg.get('tool_calls') or []:
            if not isinstance(call, dict):
                continue
            fn = call.get('function') or {}
            arguments = _json_object(
                fn.get('arguments'),
                'OpenAI 工具调用参数不是有效 JSON，无法转换为 Anthropic tool_use',
            )
            content.append({
                'type': 'tool_use',
                'id': call.get('id') or '',
                'name': fn.get('name') or '',
                'input': arguments,
            })
    if not content:
        # Anthropic 不接受空 content 数组；OpenAI 端的空串/None 消息很常见。
        return []
    return [{'role': role, 'content': content}]


def openai_to_anthropic_body(body):
    """把 OpenAI Chat 请求转换为原生 Anthropic Messages 请求。"""
    body = dict(body or {})
    try:
        candidate_count = int(body.get('n') or 1)
    except (TypeError, ValueError) as exc:
        raise ProtocolBridgeError('OpenAI 的 n 参数必须是整数') from exc
    if candidate_count != 1:
        raise ProtocolBridgeError(
            'Anthropic Messages 不支持 OpenAI 的多候选 n 参数，请将 n 设置为 1',
        )

    system_parts = []
    messages = []
    for msg in body.get('messages') or []:
        if not isinstance(msg, dict):
            continue
        if (msg.get('role') or '').strip() in ('system', 'developer'):
            system_parts.extend(_openai_content_to_anthropic(msg.get('content')))
        else:
            messages.extend(_openai_message_to_anthropic(msg))
    if isinstance(body.get('web_search_options'), dict):
        # Anthropic 的联网搜索是 server tool，需要一整套服务端闭环，而 Chat 入站
        # 没有。硬映射过去会退化成「转发一个没人执行的工具」——正是要避免的坑。
        raise ProtocolBridgeError(
            'Anthropic Messages 不支持 Chat 的 web_search_options，'
            '请路由到 OpenAI 兼容账号，或改用 Anthropic 的 web_search server tool',
        )
    response_format = body.get('response_format')
    if isinstance(response_format, dict) and response_format.get('type') not in (None, '', 'text'):
        # Anthropic Messages 没有对应的结构化输出参数。静默丢弃会让客户端拿到
        # 散文而不是 JSON，且毫无提示；按本模块既有约定明确报错，让调度换到
        # 支持该参数的账号，或让调用方看到真正的原因。
        raise ProtocolBridgeError(
            f'Anthropic Messages 不支持 response_format='
            f'{response_format.get("type")}，请路由到 OpenAI 兼容账号',
        )
    out = {
        'model': body.get('model'),
        # OpenAI 每个 tool 结果是一条独立 tool 消息，转换后会变成多条连续的
        # user 消息；Anthropic 要求角色交替，必须先合并。并行工具调用一定会
        # 命中这条。
        'messages': _merge_anthropic_messages(messages),
        'stream': bool(body.get('stream')),
        'max_tokens': body.get('max_tokens', body.get('max_completion_tokens')) or 4096,
    }
    if system_parts:
        out['system'] = system_parts
    user_id = _end_user_id(body)
    if user_id:
        out['metadata'] = {'user_id': user_id}
    if body.get('temperature') is not None:
        out['temperature'] = body['temperature']
    if body.get('top_p') is not None:
        out['top_p'] = body['top_p']
    stop = body.get('stop')
    if stop:
        out['stop_sequences'] = stop if isinstance(stop, list) else [stop]
    tools = []
    for tool in body.get('tools') or []:
        if not isinstance(tool, dict):
            continue
        fn = tool.get('function') if isinstance(tool.get('function'), dict) else tool
        if not fn.get('name'):
            continue
        tools.append({
            'name': fn['name'],
            'description': fn.get('description') or '',
            'input_schema': fn.get('parameters') or {'type': 'object', 'properties': {}},
        })
    if tools:
        out['tools'] = tools
        # tool_choice 不能脱离 tools 单独出现，否则上游判非法请求。
        choice = body.get('tool_choice')
        if choice in ('none', 'auto'):
            out['tool_choice'] = {'type': choice}
        elif choice in ('required', 'any'):
            out['tool_choice'] = {'type': 'any'}
        elif isinstance(choice, dict):
            fn = choice.get('function') if isinstance(choice.get('function'), dict) else choice
            if fn.get('name'):
                out['tool_choice'] = {'type': 'tool', 'name': fn['name']}
    return out


def openai_to_responses_body(body):
    """把 OpenAI Chat 请求转换为原生 OpenAI Responses 请求。"""
    body = dict(body or {})
    try:
        candidate_count = int(body.get('n') or 1)
    except (TypeError, ValueError) as exc:
        raise ProtocolBridgeError('OpenAI 的 n 参数必须是整数') from exc
    if candidate_count != 1:
        raise ProtocolBridgeError(
            'Responses 不支持 OpenAI Chat 的多候选 n 参数，请将 n 设置为 1',
        )
    instructions = []
    incoming = []
    for msg in body.get('messages') or []:
        if not isinstance(msg, dict):
            continue
        role = msg.get('role') or 'user'
        if role in ('system', 'developer'):
            instructions.append(_text_from_blocks(msg.get('content')))
            continue
        if role == 'tool':
            incoming.append({
                'type': 'function_call_output',
                'call_id': msg.get('tool_call_id') or '',
                'output': msg.get('content') or '',
            })
            continue
        content = msg.get('content')
        if isinstance(content, str):
            content = [{'type': _responses_input_text_type(role), 'text': content}]
        else:
            converted = []
            for part in content or []:
                if isinstance(part, str):
                    converted.append({'type': 'input_text', 'text': part})
                elif isinstance(part, dict):
                    kind = part.get('type')
                    if kind == 'image_url':
                        image = part.get('image_url')
                        image = image.get('url') if isinstance(image, dict) else image
                        converted.append({'type': 'input_image', 'image_url': image})
                    elif kind in ('text', 'input_text', 'output_text'):
                        converted.append({
                            'type': _responses_input_text_type(role),
                            'text': part.get('text') or '',
                        })
            content = converted
        if role == 'assistant':
            reasoning = msg.get('reasoning_content')
            if reasoning:
                incoming.append({
                    'type': 'reasoning',
                    'summary': [{'type': 'summary_text', 'text': reasoning}],
                })
        if content:
            incoming.append({'type': 'message', 'role': role, 'content': content})
        if role == 'assistant':
            for call in msg.get('tool_calls') or []:
                if not isinstance(call, dict):
                    continue
                fn = call.get('function') or {}
                arguments = fn.get('arguments') or '{}'
                if not isinstance(arguments, str):
                    arguments = json.dumps(arguments, ensure_ascii=False)
                incoming.append({
                    'type': 'function_call',
                    'call_id': call.get('id') or '',
                    'name': fn.get('name') or '',
                    'arguments': arguments,
                })
    out = {
        'model': body.get('model'),
        'input': incoming,
        'stream': bool(body.get('stream')),
    }
    if instructions:
        out['instructions'] = '\n'.join(item for item in instructions if item)
    user_id = _end_user_id(body)
    if user_id:
        out['user'] = user_id
    metadata = _passthrough_metadata(body)
    if metadata:
        out['metadata'] = metadata
    limit = body.get('max_output_tokens', body.get('max_completion_tokens', body.get('max_tokens')))
    if limit is not None:
        out['max_output_tokens'] = limit
    if body.get('temperature') is not None:
        out['temperature'] = body['temperature']
    if body.get('top_p') is not None:
        out['top_p'] = body['top_p']
    tools = []
    for tool in body.get('tools') or []:
        if not isinstance(tool, dict):
            continue
        fn = tool.get('function') if isinstance(tool.get('function'), dict) else tool
        if fn.get('name'):
            tools.append({
                'type': 'function',
                'name': fn['name'],
                'description': fn.get('description') or '',
                'parameters': fn.get('parameters') or {'type': 'object', 'properties': {}},
            })
    search_options = body.get('web_search_options')
    if isinstance(search_options, dict):
        # Responses 有内置 web_search，两边字段能一一对上，忠实映射即可。
        native = {'type': 'web_search'}
        if search_options.get('search_context_size'):
            native['search_context_size'] = search_options['search_context_size']
        location = search_options.get('user_location')
        if isinstance(location, dict):
            approximate = location.get('approximate')
            picked = approximate if isinstance(approximate, dict) else location
            trimmed = {
                key: picked[key] for key in ('city', 'region', 'country', 'timezone')
                if str(picked.get(key) or '').strip()
            }
            if trimmed:
                native['user_location'] = trimmed
        tools.append(native)
    if tools:
        out['tools'] = tools
    if body.get('parallel_tool_calls') is not None:
        out['parallel_tool_calls'] = body['parallel_tool_calls']
    if body.get('response_format') is not None:
        response_format = body['response_format']
        if isinstance(response_format, dict):
            if response_format.get('type') == 'json_schema':
                schema = response_format.get('json_schema') or {}
                out['text'] = {'format': {
                    'type': 'json_schema',
                    'name': schema.get('name') or 'response_schema',
                    'description': schema.get('description'),
                    'schema': schema.get('schema') or {},
                    'strict': schema.get('strict', True),
                }}
            elif response_format.get('type'):
                out['text'] = {'format': {'type': response_format['type']}}
    if tools and body.get('tool_choice') is not None:
        # tool_choice 不能脱离 tools 单独出现，否则上游判非法请求。
        choice = body['tool_choice']
        if isinstance(choice, str):
            out['tool_choice'] = choice
        elif isinstance(choice, dict):
            fn = choice.get('function') if isinstance(choice.get('function'), dict) else choice
            if choice.get('type') in ('function', 'tool') and fn.get('name'):
                out['tool_choice'] = {'type': 'function', 'name': fn['name']}
    return out


def _merge_anthropic_messages(messages):
    """合并连续同角色消息，满足 Anthropic Messages 的交替角色要求。"""
    merged = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get('role') or 'user'
        content = message.get('content') or []
        if not isinstance(content, list):
            content = [{'type': 'text', 'text': str(content)}]
        if merged and merged[-1].get('role') == role:
            merged[-1].setdefault('content', []).extend(content)
        else:
            merged.append({'role': role, 'content': list(content)})
    return merged


def _responses_content_to_anthropic(content):
    if isinstance(content, str):
        return [{'type': 'text', 'text': content}]
    if not isinstance(content, list):
        return []
    converted = []
    for part in content:
        if isinstance(part, str):
            converted.append({'type': 'text', 'text': part})
            continue
        if not isinstance(part, dict):
            continue
        kind = part.get('type')
        if kind in ('input_text', 'output_text', 'text'):
            converted.append({'type': 'text', 'text': part.get('text') or ''})
        elif kind == 'refusal':
            # Anthropic has no refusal content-part type.  Preserve the visible
            # refusal as text instead of returning a blank successful message.
            refusal = part.get('refusal') or part.get('text') or ''
            if refusal:
                converted.append({'type': 'text', 'text': str(refusal)})
        elif kind in ('input_image', 'image_url', 'image'):
            image = part.get('image_url') or part.get('url')
            if isinstance(image, dict):
                image = image.get('url')
            if image:
                if str(image).startswith('data:') and ';base64,' in str(image):
                    header, data = str(image).split(';base64,', 1)
                    converted.append({
                        'type': 'image',
                        'source': {
                            'type': 'base64',
                            'media_type': header[5:] or 'image/png',
                            'data': data,
                        },
                    })
                else:
                    converted.append({
                        'type': 'image',
                        'source': {'type': 'url', 'url': str(image)},
                    })
    return converted


def _responses_input_to_anthropic(items):
    messages = []
    system_parts = []
    pending_reasoning = []
    pending_assistant = []

    def flush_assistant():
        nonlocal pending_reasoning, pending_assistant
        if not pending_reasoning and not pending_assistant:
            return
        blocks = list(pending_reasoning)
        blocks.extend(pending_assistant)
        if blocks:
            messages.append({'role': 'assistant', 'content': blocks})
        pending_reasoning = []
        pending_assistant = []

    for item in items or []:
        if isinstance(item, str):
            flush_assistant()
            messages.append({'role': 'user', 'content': [{'type': 'text', 'text': item}]})
            continue
        if not isinstance(item, dict):
            continue
        kind = item.get('type')
        if kind == 'reasoning':
            text, _images = _responses_content_parts(item.get('summary') or item.get('content'))
            encrypted = item.get('encrypted_content')
            if text or encrypted:
                if encrypted:
                    pending_reasoning.append({
                        'type': 'thinking',
                        'thinking': text,
                        'signature': encrypted,
                    })
                elif text:
                    # Responses reasoning has no Anthropic signature to replay.
                    # Downgrade it to text; an unsigned thinking block is rejected
                    # by Anthropic Messages-compatible upstreams.
                    pending_reasoning.append({'type': 'text', 'text': text})
            continue
        if kind in ('function_call', 'custom_tool_call'):
            arguments = _json_object(
                item.get('arguments'),
                'Responses 工具调用参数不是有效 JSON，无法转换为 Anthropic tool_use',
            )
            pending_assistant.append({
                'type': 'tool_use',
                'id': item.get('call_id') or item.get('id') or '',
                'name': item.get('name') or '',
                'input': arguments,
            })
            continue
        if kind == 'function_call_output':
            flush_assistant()
            output = item.get('output')
            messages.append({
                'role': 'user',
                'content': [{
                    'type': 'tool_result',
                    'tool_use_id': item.get('call_id') or '',
                    'content': output if isinstance(output, (str, list)) else str(output or ''),
                }],
            })
            continue
        role = item.get('role') or 'user'
        if role in ('developer', 'system'):
            flush_assistant()
            text, _images = _responses_content_parts(item.get('content'))
            if text:
                system_parts.append(text)
            continue
        if role in ('assistant', 'model'):
            pending_assistant.extend(_responses_content_to_anthropic(item.get('content')))
            continue
        flush_assistant()
        messages.append({
            'role': role,
            'content': _responses_content_to_anthropic(item.get('content')),
        })
    flush_assistant()
    return _merge_anthropic_messages(messages), system_parts


def _responses_tools_to_anthropic(tools):
    result = []
    for tool in tools or []:
        if not isinstance(tool, dict):
            raise ProtocolBridgeError('Responses 工具声明格式无效，无法转换为 Anthropic')
        if tool.get('type') not in (None, 'function'):
            raise ProtocolBridgeError(
                f'Responses 内置工具 {tool.get("type") or "unknown"} '
                '无法转换为 Anthropic，请使用 Responses 原生上游',
            )
        name = tool.get('name')
        if not name:
            fn = tool.get('function') if isinstance(tool.get('function'), dict) else {}
            name = fn.get('name')
            tool = {**fn, **tool}
        if not name:
            raise ProtocolBridgeError('Responses function 工具缺少名称，无法转换为 Anthropic')
        result.append({
            'name': name,
            'description': tool.get('description') or '',
            'input_schema': tool.get('parameters') or tool.get('input_schema') or {
                'type': 'object', 'properties': {},
            },
        })
    return result


def _responses_declared_tools(body):
    """读取 Responses 请求中的完整工具声明。

    部分客户端会把扩展工具放在 input 的 additional_tools 项中，而不是
    顶层 tools。网关只把真正可转换的 function 工具交给目标协议，
    不把 Responses 专有的壳字段原样转发给 Chat/Anthropic 上游。
    """
    body = body if isinstance(body, dict) else {}
    tools = list(body.get('tools') or [])
    for item in body.get('input') or []:
        if not isinstance(item, dict) or item.get('type') != 'additional_tools':
            continue
        extra = item.get('tools')
        if isinstance(extra, list):
            tools.extend(extra)
    return tools


def _responses_instructions_text(value):
    """Normalize Responses ``instructions`` to Anthropic's text system field."""
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return _text_from_blocks(value)
    parts = []
    for item in value:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            value = item.get('content')
            if value is None:
                value = item.get('text')
            text, _images = _responses_content_parts(value)
            if text:
                parts.append(text)
    return ''.join(parts)


def responses_to_anthropic_body(body):
    """Responses 请求直接转换为 Anthropic，不经过 Chat 中间格式。"""
    body = dict(body or {})
    _responses_user_id = _end_user_id(body)
    incoming = body.get('input')
    if isinstance(incoming, str):
        messages = [{'role': 'user', 'content': [{'type': 'text', 'text': incoming}]}]
        input_system = []
    elif isinstance(incoming, list):
        messages, input_system = _responses_input_to_anthropic(incoming)
    else:
        messages = []
        input_system = []
    out = {
        'model': body.get('model'),
        'messages': messages,
        'stream': bool(body.get('stream')),
        'max_tokens': body.get('max_output_tokens', body.get('max_tokens')) or 4096,
    }
    instruction_text = _responses_instructions_text(body.get('instructions'))
    system_parts = [item for item in input_system if item]
    if instruction_text:
        system_parts.insert(0, instruction_text)
    if system_parts:
        out['system'] = '\n'.join(system_parts)
    if body.get('temperature') is not None:
        out['temperature'] = body['temperature']
    if body.get('top_p') is not None:
        out['top_p'] = body['top_p']
    if _responses_user_id:
        out['metadata'] = {'user_id': _responses_user_id}
    tools = _responses_tools_to_anthropic(_responses_declared_tools(body))
    if tools:
        out['tools'] = tools
    # tool_choice cannot be sent without tools; Anthropic rejects the otherwise
    # tempting ``{"type":"any"}`` on a tool-less request.
    if tools:
        choice = body.get('tool_choice')
        if choice in ('none', 'auto'):
            out['tool_choice'] = {'type': choice}
        elif choice == 'required':
            out['tool_choice'] = {'type': 'any'}
        elif isinstance(choice, dict):
            name = (choice.get('function') or {}).get('name') or choice.get('name')
            if name:
                out['tool_choice'] = {'type': 'tool', 'name': name}
    return out


# Responses 的输入内容只接受 input_text / input_image / input_file；output_text 是
# 输出侧类型，放进输入会被判非法。只有 assistant 的历史消息才允许 output_text。
# 另外 Anthropic 允许会话中途出现 role: system（Claude Code 用它下发操作指令），
# 而 Responses 侧的等价角色是 developer——实测上游只认后者，system 一律拒绝。
_RESPONSES_INPUT_ROLE = {'system': 'developer'}


def _responses_input_role(role):
    role = role or 'user'
    return _RESPONSES_INPUT_ROLE.get(role, role)


def _responses_input_text_type(role):
    return 'output_text' if role == 'assistant' else 'input_text'


def _anthropic_input_to_responses(content, role):
    result = []
    out_role = _responses_input_role(role)
    if isinstance(content, str):
        return [{'type': 'message', 'role': out_role, 'content': [{
            'type': _responses_input_text_type(role),
            'text': content,
        }]}]
    for part in content or []:
        if not isinstance(part, dict):
            continue
        kind = part.get('type')
        if kind == 'thinking':
            result.append({'type': 'reasoning', 'summary': [{
                'type': 'summary_text', 'text': part.get('thinking') or '',
            }]})
        elif kind == 'text':
            result.append({'type': 'message', 'role': out_role, 'content': [{
                'type': _responses_input_text_type(role),
                'text': part.get('text') or '',
            }]})
        elif kind == 'image':
            image = _anthropic_image_part(part)
            if image:
                result.append({'type': 'message', 'role': out_role, 'content': [{
                    'type': 'input_image', 'image_url': image['image_url']['url'],
                }]})
        elif kind == 'tool_use':
            result.append({
                'type': 'function_call',
                'call_id': part.get('id') or '',
                'name': part.get('name') or '',
                'arguments': json.dumps(part.get('input') or {}, ensure_ascii=False),
            })
        elif kind == 'tool_result':
            # Anthropic 的 tool_result.content 是一串 {'type': 'text'} 块，而
            # Responses 的 function_call_output.output 只认 input_text/input_image
            # /input_file 或纯字符串。原样塞过去会被判成非法类型，拍平成字符串
            # 与 openai→responses 那一侧的处理保持一致。
            output = part.get('content')
            result.append({
                'type': 'function_call_output',
                'call_id': part.get('tool_use_id') or '',
                'output': output if isinstance(output, str) else _text_from_blocks(output),
            })
    return result


def anthropic_to_responses_body(body):
    """Anthropic 请求直接转换为 Responses，不经过 Chat 中间格式。"""
    body = dict(body or {})
    incoming = []
    for msg in body.get('messages') or []:
        if not isinstance(msg, dict):
            continue
        role = msg.get('role') or 'user'
        incoming.extend(_anthropic_input_to_responses(msg.get('content'), role))
    out = {
        'model': body.get('model'),
        'input': incoming,
        'stream': bool(body.get('stream')),
        'max_output_tokens': body.get('max_tokens', body.get('max_output_tokens')) or 4096,
    }
    system = body.get('system')
    if system:
        out['instructions'] = _text_from_blocks(system)
    user_id = _end_user_id(body)
    if user_id:
        out['user'] = user_id
    if body.get('temperature') is not None:
        out['temperature'] = body['temperature']
    if body.get('top_p') is not None:
        out['top_p'] = body['top_p']
    tools = []
    for tool in body.get('tools') or []:
        if not isinstance(tool, dict) or not tool.get('name'):
            continue
        tools.append({
            'type': 'function',
            'name': tool['name'],
            'description': tool.get('description') or '',
            'parameters': tool.get('input_schema') or {'type': 'object', 'properties': {}},
        })
    if tools:
        out['tools'] = tools
        # tool_choice 不能脱离 tools 单独出现，否则上游判非法请求。
        choice = body.get('tool_choice')
        if isinstance(choice, dict):
            kind = choice.get('type')
            if kind in ('none', 'auto', 'any'):
                out['tool_choice'] = 'required' if kind == 'any' else kind
            elif kind == 'tool' and choice.get('name'):
                out['tool_choice'] = {'type': 'function', 'name': choice['name']}
    thinking = body.get('thinking')
    if isinstance(thinking, dict) and thinking.get('type') in ('enabled', 'adaptive'):
        out['reasoning'] = {'effort': 'medium'}
    return out


def _anthropic_message_to_openai(msg):
    role = msg.get('role')
    content = msg.get('content')
    if isinstance(content, str):
        return [{'role': role, 'content': content}]
    if not isinstance(content, list):
        return [{'role': role or 'user', 'content': _text_from_blocks(content)}]

    texts, images, thinking, tool_calls, results = [], [], [], [], []
    for part in content:
        if not isinstance(part, dict):
            continue
        kind = part.get('type')
        if kind == 'text':
            texts.append(part.get('text') or '')
        elif kind == 'thinking':
            thinking.append(part.get('thinking') or '')
        elif kind == 'image':
            converted = _anthropic_image_part(part)
            if converted:
                images.append(converted)
        elif kind == 'tool_use':
            arguments = part.get('input')
            if not isinstance(arguments, str):
                arguments = json.dumps(arguments or {}, ensure_ascii=False)
            tool_calls.append({
                'id': part.get('id') or '',
                'type': 'function',
                'function': {'name': part.get('name') or '', 'arguments': arguments},
            })
        elif kind == 'tool_result':
            results.append({
                'role': 'tool',
                'tool_call_id': part.get('tool_use_id') or '',
                'content': _text_from_blocks(part.get('content')),
            })

    if results and not texts and not tool_calls and not images and not thinking:
        return results

    converted = []
    if role == 'assistant':
        item = {'role': 'assistant', 'content': ''.join(texts) or ('' if tool_calls else None)}
        if thinking:
            item['reasoning_content'] = ''.join(thinking)
        if tool_calls:
            item['tool_calls'] = tool_calls
        converted.append(item)
    elif images:
        parts = []
        if texts:
            parts.append({'type': 'text', 'text': ''.join(texts)})
        parts.extend(images)
        converted.append({'role': role or 'user', 'content': parts})
    else:
        converted.append({'role': role or 'user', 'content': ''.join(texts)})
    # A tool result is the response to the immediately preceding assistant
    # tool call.  Keep it ahead of any residual user text/images; appending it
    # after that text produces ``assistant tool_call → user text → tool`` which
    # OpenAI-compatible upstreams reject.
    return results + converted if results else converted


def _openai_choice_to_anthropic(choice):
    choice = choice or {}
    message = choice.get('message') or {}
    blocks = []
    reasoning = message.get('reasoning_content')
    if reasoning:
        # OpenAI reasoning_content has no Anthropic signature equivalent.  Do
        # not synthesize an unsigned thinking block; Anthropic validates the
        # signature field as mandatory.  Text preserves the information.
        blocks.append({'type': 'text', 'text': str(reasoning)})
    text = message.get('content')
    if text:
        blocks.append({'type': 'text', 'text': text})
    for call in message.get('tool_calls') or []:
        if not isinstance(call, dict):
            continue
        fn = call.get('function') or {}
        raw = fn.get('arguments') or '{}'
        try:
            arguments = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except (TypeError, ValueError) as exc:
            raise ProtocolBridgeError(
                '上游工具调用参数不是有效 JSON，无法转换为 Anthropic tool_use',
            ) from exc
        if not isinstance(arguments, dict):
            raise ProtocolBridgeError(
                '上游工具调用参数必须是 JSON 对象，无法转换为 Anthropic tool_use',
            )
        blocks.append({
            'type': 'tool_use',
            'id': call.get('id') or '',
            'name': fn.get('name') or '',
            'input': arguments,
        })
    finish = choice.get('finish_reason')
    stop_reason = {'stop': 'end_turn', 'tool_calls': 'tool_use', 'length': 'max_tokens'}.get(finish, 'end_turn')
    return {
        'type': 'message',
        'role': 'assistant',
        'content': blocks,
        'stop_reason': stop_reason,
    }


def openai_to_anthropic_message(payload, client_model=None):
    payload = payload or {}
    choices = [choice for choice in (payload.get('choices') or [{}]) if isinstance(choice, dict)] or [{}]
    if len(choices) != 1:
        raise ProtocolBridgeError(
            'Anthropic Messages 不支持 OpenAI 的多候选响应，请将 n 设置为 1',
        )
    candidates = [_openai_choice_to_anthropic(choice) for choice in choices]
    primary = candidates[0]
    usage = payload.get('usage') or {}
    result = {
        'id': payload.get('id') or 'msg_coati',
        'type': primary['type'],
        'role': primary['role'],
        'model': client_model or payload.get('model') or '',
        'content': primary['content'],
        'stop_reason': primary['stop_reason'],
        'usage': {
            'input_tokens': int(usage.get('prompt_tokens') or usage.get('input_tokens') or 0),
            'output_tokens': int(usage.get('completion_tokens') or usage.get('output_tokens') or 0),
        },
    }
    return result


def anthropic_to_openai_message(payload, client_model=None):
    """把 Anthropic Messages 响应转换为 OpenAI Chat 响应。"""
    payload = payload or {}
    texts, reasoning, tool_calls = [], [], []
    for block in payload.get('content') or []:
        if not isinstance(block, dict):
            continue
        kind = block.get('type')
        if kind == 'text':
            texts.append(block.get('text') or '')
        elif kind == 'thinking':
            reasoning.append(block.get('thinking') or '')
        elif kind == 'tool_use':
            tool_calls.append({
                'id': block.get('id') or '',
                'type': 'function',
                'function': {
                    'name': block.get('name') or '',
                    'arguments': json.dumps(block.get('input') or {}, ensure_ascii=False),
                },
            })
    stop_reason = payload.get('stop_reason')
    finish_reason = {
        'end_turn': 'stop',
        'stop_sequence': 'stop',
        'tool_use': 'tool_calls',
        'max_tokens': 'length',
    }.get(stop_reason, 'stop')
    usage = payload.get('usage') or {}
    message = {
        'role': 'assistant',
        'content': ''.join(texts) or ('' if tool_calls else None),
    }
    if reasoning:
        message['reasoning_content'] = ''.join(reasoning)
    if tool_calls:
        message['tool_calls'] = tool_calls
    return {
        'id': payload.get('id') or 'chatcmpl_coati',
        'object': 'chat.completion',
        'model': client_model or payload.get('model') or '',
        'choices': [{
            'index': 0,
            'message': message,
            'finish_reason': finish_reason,
        }],
        'usage': _chat_usage_from_anthropic(usage),
    }


# Anthropic 强制要求 server tool 的 id 匹配 ^srvtoolu_[a-zA-Z0-9_]+$——比普通
# tool_use 更严，连字符都不允许。上游给的 id（Chat 的 call_abc-123、Responses 的
# ws_00112233）都不满足，原样透传会被严格校验的客户端拒掉。
_SERVER_TOOL_ID_PREFIX = 'srvtoolu_'
_SERVER_TOOL_ID_INVALID = re.compile(r'[^a-zA-Z0-9_]')


def server_tool_use_id(raw):
    """把任意上游 id 归一成合法的 server tool id；幂等。

    仅用于面向客户端的块。回喂上游的 tool_result 必须继续用上游原本的 id，
    两者不能混用。
    """
    body = str(raw or '').strip()
    if body.startswith(_SERVER_TOOL_ID_PREFIX):
        body = body[len(_SERVER_TOOL_ID_PREFIX):]
    body = _SERVER_TOOL_ID_INVALID.sub('_', body)
    if not body:
        body = uuid4().hex[:16]
    return _SERVER_TOOL_ID_PREFIX + body


def _end_user_id(body):
    """取出终端用户标识。

    三套协议叫法不同：Chat/Responses 是顶层 user，Anthropic 是 metadata.user_id。
    上游用它做滥用检测与按用户归因，跨协议时不该丢。
    """
    body = body if isinstance(body, dict) else {}
    direct = str(body.get('user') or '').strip()
    if direct:
        return direct
    meta = body.get('metadata')
    if isinstance(meta, dict):
        return str(meta.get('user_id') or '').strip()
    return ''


def _passthrough_metadata(body):
    """Chat 与 Responses 共用同一个 metadata 形状，可以原样带过去。"""
    meta = (body or {}).get('metadata')
    return meta if isinstance(meta, dict) else None


def encode_sse(event, payload):
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode('utf-8')


class OpenAIToAnthropicStream:
    """把上游 Chat Completions SSE 收成 Claude Code 要的 Anthropic SSE。"""

    def __init__(self, client_model=None):
        self.client_model = client_model or ''
        self.started = False
        self.finished = False
        self.thinking_open = False
        self.text_index = None
        self.next_index = 0
        # 上游 tool_calls[index] 与 Anthropic content_block index 不是同一空间；
        # 必须固定映射，后续分片不能随着 next_index 改投到别的 block。
        self.tool_blocks = {}
        self.msg_id = 'msg_coati'

    def start(self):
        if self.started:
            return b''
        self.started = True
        return encode_sse('message_start', {
            'type': 'message_start',
            'message': {
                'id': self.msg_id,
                'type': 'message',
                'role': 'assistant',
                'model': self.client_model,
                'content': [],
                # Anthropic 的 message_start 携带的是一个完整 Message 骨架。
                # ZCode / AI SDK 会按官方 schema 严格校验这些字段；缺少 usage
                # 时即使 HTTP/SSE 已成功建立，也会在客户端被包装成 500。
                # Chat Completions 通常要到流末才返回真实 usage，因此起始事件
                # 先使用合法的零值，最终 output_tokens 仍在 message_delta 更新。
                'stop_reason': None,
                'stop_sequence': None,
                'usage': {
                    'input_tokens': 0,
                    'output_tokens': 0,
                },
            },
        })

    def _ensure_thinking(self):
        chunks = []
        if not self.thinking_open:
            chunks.append(encode_sse('content_block_start', {
                'type': 'content_block_start',
                'index': self.next_index,
                # Chat reasoning_content has no Anthropic signature.  Represent
                # it as a separate text block so the upstream schema remains
                # valid and no opaque content is lost.
                'content_block': {'type': 'text', 'text': ''},
            }))
            self.thinking_open = True
            self.next_index += 1
        return chunks

    def _close_thinking(self):
        if not self.thinking_open:
            return []
        index = self.next_index - 1
        self.thinking_open = False
        return [encode_sse('content_block_stop', {'type': 'content_block_stop', 'index': index})]

    def _ensure_text(self):
        chunks = self._close_thinking()
        if self.text_index is None:
            self.text_index = self.next_index
            chunks.append(encode_sse('content_block_start', {
                'type': 'content_block_start',
                'index': self.text_index,
                'content_block': {'type': 'text', 'text': ''},
            }))
            self.next_index += 1
        return chunks

    def feed(self, obj):
        if not isinstance(obj, dict):
            return b''
        if obj.get('id'):
            self.msg_id = obj['id']
        out = [self.start()] if not self.started else []
        choice = (obj.get('choices') or [{}])[0] or {}
        delta = choice.get('delta') or {}
        reasoning = delta.get('reasoning_content')
        if reasoning:
            out.extend(self._ensure_thinking())
            out.append(encode_sse('content_block_delta', {
                'type': 'content_block_delta',
                'index': self.next_index - 1,
                'delta': {'type': 'text_delta', 'text': reasoning},
            }))
        content = delta.get('content')
        if content:
            out.extend(self._ensure_text())
            out.append(encode_sse('content_block_delta', {
                'type': 'content_block_delta',
                'index': self.text_index,
                'delta': {'type': 'text_delta', 'text': content},
            }))
        for call in delta.get('tool_calls') or []:
            if not isinstance(call, dict):
                continue
            index = call.get('index', 0)
            out.extend(self._close_thinking())
            if self.text_index is not None:
                out.append(encode_sse('content_block_stop', {
                    'type': 'content_block_stop', 'index': self.text_index,
                }))
                self.text_index = None
            block_index = self.tool_blocks.get(index)
            if block_index is None:
                block_index = self.next_index
                fn = call.get('function') or {}
                out.append(encode_sse('content_block_start', {
                    'type': 'content_block_start',
                    'index': block_index,
                    'content_block': {
                        'type': 'tool_use',
                        'id': call.get('id') or f'tool_{index}',
                        'name': fn.get('name') or '',
                        'input': {},
                    },
                }))
                self.tool_blocks[index] = block_index
                self.next_index = block_index + 1
            args = (call.get('function') or {}).get('arguments')
            if args:
                if not isinstance(args, str):
                    args = json.dumps(args, ensure_ascii=False)
                out.append(encode_sse('content_block_delta', {
                    'type': 'content_block_delta',
                    'index': block_index,
                    'delta': {'type': 'input_json_delta', 'partial_json': args},
                }))
        usage = obj.get('usage')
        finish = choice.get('finish_reason')
        if finish or (usage and not delta):
            out.extend(self.finish(finish, usage))
        return b''.join(out)

    def finish(self, finish_reason=None, usage=None):
        if self.finished:
            return []
        self.finished = True
        chunks = [self.start()] if not self.started else []
        chunks.extend(self._close_thinking())
        if self.text_index is not None:
            chunks.append(encode_sse('content_block_stop', {
                'type': 'content_block_stop', 'index': self.text_index,
            }))
            self.text_index = None
        for block_index in self.tool_blocks.values():
            chunks.append(encode_sse('content_block_stop', {
                'type': 'content_block_stop', 'index': block_index,
            }))
        self.tool_blocks.clear()
        stop_reason = {'stop': 'end_turn', 'tool_calls': 'tool_use', 'length': 'max_tokens'}.get(
            finish_reason, 'end_turn' if finish_reason else 'end_turn',
        )
        payload = {
            'type': 'message_delta',
            'delta': {'stop_reason': stop_reason, 'stop_sequence': None},
        }
        # RawMessageDeltaEvent.usage.output_tokens is mandatory in the
        # Anthropic schema.  Providers that omit usage in streaming responses
        # still get a valid terminal event with a deterministic zero value.
        payload['usage'] = {
            'output_tokens': int((usage or {}).get('completion_tokens') or (usage or {}).get('output_tokens') or 0),
        }
        chunks.append(encode_sse('message_delta', payload))
        chunks.append(encode_sse('message_stop', {'type': 'message_stop'}))
        return chunks


def _responses_content_parts(content):
    if isinstance(content, str):
        return content, []
    if not isinstance(content, list):
        return _text_from_blocks(content), []
    texts, images = [], []
    for item in content:
        if isinstance(item, str):
            texts.append(item)
            continue
        if not isinstance(item, dict):
            continue
        kind = item.get('type')
        if kind in ('input_text', 'output_text', 'text', 'summary_text'):
            texts.append(item.get('text') or '')
        elif kind == 'refusal':
            texts.append(str(item.get('refusal') or item.get('text') or ''))
        elif kind in ('input_image', 'image_url', 'image'):
            image = item.get('image_url') or item.get('url')
            if isinstance(image, dict):
                image = image.get('url')
            source = item.get('source')
            if not image and isinstance(source, dict):
                if source.get('type') == 'url':
                    image = source.get('url')
                elif source.get('type') == 'base64' and source.get('data'):
                    media = source.get('media_type') or 'image/png'
                    image = f'data:{media};base64,{source["data"]}'
            if image:
                images.append({'type': 'image_url', 'image_url': {'url': image}})
    return ''.join(texts), images


def _responses_tool_arguments(value):
    if isinstance(value, str):
        return value
    return json.dumps(value or {}, ensure_ascii=False)


def _responses_usage(usage):
    """Return a complete Responses usage object.

    Unlike Chat usage, the Responses SDK treats the nested detail objects and
    ``total_tokens`` as required whenever ``usage`` is present.  Compatible
    upstreams often only report input/output counts, so fill the detail fields
    deterministically instead of emitting a shape that strict clients reject.
    """
    usage = usage if isinstance(usage, dict) else {}
    input_tokens = int(usage.get('input_tokens') or usage.get('prompt_tokens') or 0)
    output_tokens = int(usage.get('output_tokens') or usage.get('completion_tokens') or 0)
    input_details = usage.get('input_tokens_details')
    if not isinstance(input_details, dict):
        input_details = {
            'cache_write_tokens': int(usage.get('cache_creation_input_tokens') or 0),
            'cached_tokens': int(usage.get('cache_read_input_tokens') or 0),
        }
    else:
        input_details = {
            'cache_write_tokens': int(
                input_details.get('cache_write_tokens')
                or input_details.get('cache_creation_input_tokens')
                or 0
            ),
            'cached_tokens': int(input_details.get('cached_tokens') or 0),
        }
    output_details = usage.get('output_tokens_details')
    if not isinstance(output_details, dict):
        output_details = {'reasoning_tokens': int(usage.get('reasoning_tokens') or 0)}
    else:
        output_details = {'reasoning_tokens': int(output_details.get('reasoning_tokens') or 0)}
    return {
        'input_tokens': input_tokens,
        'input_tokens_details': input_details,
        'output_tokens': output_tokens,
        'output_tokens_details': output_details,
        'total_tokens': int(usage.get('total_tokens') or input_tokens + output_tokens),
    }


def _responses_output_text(text):
    if not isinstance(text, str):
        text = _text_from_blocks(text)
    return {
        'type': 'output_text',
        'text': text or '',
        'annotations': [],
    }


def _responses_response(response_id, model, output=None, status='completed', usage=None,
                        created_at=None, incomplete_details=None):
    """Build a Responses response skeleton accepted by strict OpenAI SDKs."""
    result = {
        'id': response_id or 'resp_coati',
        'object': 'response',
        'created_at': int(created_at if created_at is not None else time.time()),
        'status': status,
        'error': None,
        'incomplete_details': incomplete_details,
        'instructions': None,
        'model': model or '',
        'output': list(output or []),
        'parallel_tool_calls': True,
        'tool_choice': 'auto',
        'tools': [],
        'usage': _responses_usage(usage) if usage is not None else None,
    }
    return result


def responses_to_openai_body(body):
    body = dict(body or {})
    messages = []
    instructions = body.get('instructions')
    if instructions:
        messages.append({'role': 'system', 'content': _text_from_blocks(instructions)})
    incoming = body.get('input')
    if isinstance(incoming, str):
        messages.append({'role': 'user', 'content': incoming})
    elif isinstance(incoming, list):
        messages.extend(_responses_input_to_messages(incoming))
    out = {
        'model': body.get('model'),
        'messages': messages,
        'stream': bool(body.get('stream')),
    }
    limit = body.get('max_output_tokens', body.get('max_tokens'))
    if limit is not None:
        out['max_tokens'] = limit
    if body.get('temperature') is not None:
        out['temperature'] = body['temperature']
    if body.get('top_p') is not None:
        out['top_p'] = body['top_p']
    user_id = _end_user_id(body)
    if user_id:
        out['user'] = user_id
    metadata = _passthrough_metadata(body)
    if metadata:
        out['metadata'] = metadata
    tools = []
    for tool in _responses_declared_tools(body):
        if not isinstance(tool, dict):
            raise ProtocolBridgeError('Responses 工具声明格式无效，无法转换为 Chat Completions')
        if tool.get('type') not in (None, 'function'):
            raise ProtocolBridgeError(
                f'Responses 内置工具 {tool.get("type") or "unknown"} '
                '无法转换为 Chat Completions，请使用 Responses 原生上游',
            )
        fn = tool.get('function') if isinstance(tool.get('function'), dict) else tool
        name = fn.get('name')
        if not name:
            raise ProtocolBridgeError('Responses function 工具缺少名称，无法转换为 Chat Completions')
        tools.append({
            'type': 'function',
            'function': {
                'name': name,
                'description': fn.get('description') or '',
                'parameters': fn.get('parameters') or {'type': 'object', 'properties': {}},
            },
        })
    if tools:
        out['tools'] = tools
        choice = body.get('tool_choice')
        if choice in ('none', 'auto', 'required'):
            out['tool_choice'] = choice
        elif isinstance(choice, dict):
            name = (choice.get('function') or {}).get('name') or choice.get('name')
            if choice.get('type') in ('function', 'tool') and name:
                out['tool_choice'] = {'type': 'function', 'function': {'name': name}}
    return out


def _responses_input_to_messages(items):
    messages = []
    pending_calls = []
    pending_reasoning = []

    def flush_calls():
        if not pending_calls:
            return
        item = {'role': 'assistant', 'content': '', 'tool_calls': list(pending_calls)}
        if pending_reasoning:
            item['reasoning_content'] = ''.join(pending_reasoning)
            pending_reasoning.clear()
        messages.append(item)
        pending_calls.clear()

    for item in items:
        if isinstance(item, str):
            flush_calls()
            messages.append({'role': 'user', 'content': item})
            continue
        if not isinstance(item, dict):
            continue
        kind = item.get('type')
        if kind == 'reasoning':
            text, _images = _responses_content_parts(item.get('summary') or item.get('content'))
            if text:
                pending_reasoning.append(text)
            continue
        if kind == 'function_call':
            pending_calls.append({
                'id': item.get('call_id') or item.get('id') or '',
                'type': 'function',
                'function': {
                    'name': item.get('name') or '',
                    'arguments': _responses_tool_arguments(item.get('arguments')),
                },
            })
            continue
        if kind == 'function_call_output':
            flush_calls()
            output = item.get('output')
            messages.append({
                'role': 'tool',
                'tool_call_id': item.get('call_id') or '',
                'content': output if isinstance(output, str) else _text_from_blocks(output),
            })
            continue
        role = item.get('role') or 'user'
        flush_calls()
        text, images = _responses_content_parts(item.get('content'))
        if images:
            parts = [{'type': 'text', 'text': text}] if text else []
            parts.extend(images)
            converted = {'role': role, 'content': parts}
        else:
            converted = {'role': role, 'content': text}
        if role == 'assistant' and pending_reasoning:
            converted['reasoning_content'] = ''.join(pending_reasoning)
            pending_reasoning.clear()
        messages.append(converted)
    flush_calls()
    if pending_reasoning and messages and messages[-1].get('role') == 'assistant':
        messages[-1]['reasoning_content'] = ''.join(pending_reasoning)
    return messages


def _openai_choice_to_responses_output(choice, response_id, choice_index=0):
    choice = choice or {}
    message = choice.get('message') or {}
    output = []
    reasoning = message.get('reasoning_content')
    if reasoning:
        output.append({
            'id': f'rs_{response_id}_{choice_index}',
            'type': 'reasoning',
            'summary': [{'type': 'summary_text', 'text': reasoning}],
        })
    text = message.get('content')
    if text:
        output.append({
            'id': f'msg_{response_id}_{choice_index}',
            'type': 'message',
            'status': 'completed',
            'role': 'assistant',
            'content': [_responses_output_text(text)],
        })
    for call_index, call in enumerate(message.get('tool_calls') or []):
        if not isinstance(call, dict):
            continue
        fn = call.get('function') or {}
        call_id = call.get('id') or f'fc_{choice_index}_{call_index}'
        output.append({
            'id': call_id,
            'type': 'function_call',
            'call_id': call_id,
            'name': fn.get('name') or '',
            'arguments': fn.get('arguments') or '{}',
        })
    return output


def openai_to_responses_message(payload, client_model=None):
    payload = payload or {}
    choices = [choice for choice in (payload.get('choices') or [{}]) if isinstance(choice, dict)] or [{}]
    if len(choices) != 1:
        raise ProtocolBridgeError(
            'Responses 不支持 OpenAI Chat 的多候选响应，请将 n 设置为 1',
        )
    response_id = payload.get('id') or 'resp_coati'
    output = []
    output.extend(_openai_choice_to_responses_output(choices[0], response_id, 0))
    usage = payload.get('usage') or {}
    finish = choices[0].get('finish_reason')
    status = 'incomplete' if finish == 'length' else 'completed'
    return _responses_response(
        response_id,
        client_model or payload.get('model') or '',
        output,
        status=status,
        usage=usage,
        incomplete_details={'reason': 'max_output_tokens'} if status == 'incomplete' else None,
    )


def responses_to_openai_message(payload, client_model=None):
    """把原生 Responses 响应转换为 OpenAI Chat 响应。"""
    payload = payload or {}
    outputs = payload.get('output') or []
    reasoning, texts, tool_calls = [], [], []
    for item in outputs:
        if not isinstance(item, dict):
            continue
        kind = item.get('type')
        if kind == 'reasoning':
            text, _images = _responses_content_parts(item.get('summary') or item.get('content'))
            if text:
                reasoning.append(text)
        elif kind == 'message':
            text, _images = _responses_content_parts(item.get('content'))
            if text:
                texts.append(text)
        elif kind == 'function_call':
            tool_calls.append({
                'id': item.get('call_id') or item.get('id') or '',
                'type': 'function',
                'function': {
                    'name': item.get('name') or '',
                    'arguments': _responses_tool_arguments(item.get('arguments')),
                },
            })
    message = {
        'role': 'assistant',
        'content': ''.join(texts) or ('' if tool_calls else None),
    }
    if reasoning:
        message['reasoning_content'] = ''.join(reasoning)
    if tool_calls:
        message['tool_calls'] = tool_calls
    usage = payload.get('usage') or {}
    return {
        'id': payload.get('id') or 'chatcmpl_coati',
        'object': 'chat.completion',
        'model': client_model or payload.get('model') or '',
        'choices': [{
            'index': 0,
            'message': message,
            'finish_reason': 'tool_calls' if tool_calls else (
                'length' if payload.get('status') == 'incomplete' else 'stop'
            ),
        }],
        'usage': {
            'prompt_tokens': int(usage.get('input_tokens') or usage.get('prompt_tokens') or 0),
            'completion_tokens': int(usage.get('output_tokens') or usage.get('completion_tokens') or 0),
        },
    }


def anthropic_to_responses_message(payload, client_model=None):
    payload = payload or {}
    output = []
    for block in payload.get('content') or []:
        if not isinstance(block, dict):
            continue
        kind = block.get('type')
        if kind == 'thinking':
            item = {
                'id': block.get('id') or 'rs_coati',
                'type': 'reasoning',
                'summary': [{'type': 'summary_text', 'text': block.get('thinking') or ''}],
            }
            if block.get('signature'):
                item['encrypted_content'] = block['signature']
            output.append(item)
        elif kind == 'text':
            output.append({
                'id': 'msg_coati',
                'type': 'message',
                'status': 'completed',
                'role': 'assistant',
                'content': [_responses_output_text(block.get('text') or '')],
            })
        elif kind == 'tool_use':
            call_id = block.get('id') or 'fc_coati'
            output.append({
                'id': call_id,
                'type': 'function_call',
                'call_id': call_id,
                'name': block.get('name') or '',
                'arguments': json.dumps(block.get('input') or {}, ensure_ascii=False),
            })
    usage = payload.get('usage') or {}
    read = int(usage.get('cache_read_input_tokens') or 0)
    write = int(usage.get('cache_creation_input_tokens') or 0)
    input_tokens = int(usage.get('input_tokens') or 0) + read + write
    response_usage = {
        'input_tokens': input_tokens,
        'output_tokens': int(usage.get('output_tokens') or 0),
        'input_tokens_details': {
            'cache_write_tokens': write,
            'cached_tokens': read,
        },
        'output_tokens_details': {'reasoning_tokens': int(usage.get('reasoning_tokens') or 0)},
        'total_tokens': input_tokens + int(usage.get('output_tokens') or 0),
    }
    status = 'incomplete' if payload.get('stop_reason') == 'max_tokens' else 'completed'
    response = _responses_response(
        payload.get('id') or 'resp_coati',
        client_model or payload.get('model') or '',
        output,
        status=status,
        usage=response_usage,
        incomplete_details={'reason': 'max_output_tokens'} if status == 'incomplete' else None,
    )
    return response


def _web_search_queries(action):
    """Responses action 里单数的 query 字段已废弃，正式字段是复数的 queries 数组。"""
    queries = action.get('queries')
    if isinstance(queries, list):
        picked = [str(item).strip() for item in queries if str(item or '').strip()]
        if picked:
            return picked
    single = str(action.get('query') or '').strip()
    return [single] if single else []


def _web_search_call_to_anthropic(item):
    """Responses 的 web_search_call → Anthropic 的 server_tool_use + 结果块。

    客户端按官方形状期待的是成对出现：只给 server_tool_use 而没有紧跟着的
    web_search_tool_result，看起来就是「搜了但什么都没搜到」。来源需要请求里
    带 include: web_search_call.action.sources 才会回来。
    """
    action = item.get('action') if isinstance(item.get('action'), dict) else {}
    call_id = server_tool_use_id(item.get('id'))
    queries = _web_search_queries(action)
    blocks = [{
        'type': 'server_tool_use',
        'id': call_id,
        'name': 'web_search',
        'input': {'query': queries[0] if queries else ''},
    }]
    if item.get('status') == 'failed':
        # server tool 出错不是 HTTP 错误：content 从列表变成单个错误对象。
        blocks.append({
            'type': 'web_search_tool_result',
            'tool_use_id': call_id,
            'content': {'type': 'web_search_tool_result_error', 'error_code': 'unavailable'},
        })
        return blocks
    results = []
    for source in action.get('sources') or []:
        if not isinstance(source, dict):
            continue
        url = str(source.get('url') or '').strip()
        if not url:
            continue
        results.append({
            'type': 'web_search_result',
            'url': url,
            'title': str(source.get('title') or '').strip() or url,
        })
    blocks.append({
        'type': 'web_search_tool_result',
        'tool_use_id': call_id,
        'content': results,
    })
    return blocks


def responses_to_anthropic_message(payload, client_model=None):
    payload = payload or {}
    content = []
    has_tool_use = False
    for item in payload.get('output') or []:
        if not isinstance(item, dict):
            continue
        kind = item.get('type')
        if kind == 'reasoning':
            text, _images = _responses_content_parts(item.get('summary') or item.get('content'))
            encrypted = item.get('encrypted_content')
            if encrypted:
                content.append({
                    'type': 'thinking',
                    'thinking': text,
                    'signature': encrypted,
                })
            elif text:
                # Responses summary text is not an Anthropic thinking signature.
                # Keep it visible as ordinary text so the request remains valid.
                content.append({'type': 'text', 'text': text})
        elif kind == 'message':
            text, _images = _responses_content_parts(item.get('content'))
            if text:
                content.append({'type': 'text', 'text': text})
        elif kind in ('function_call', 'custom_tool_call'):
            has_tool_use = True
            content.append({
                'type': 'tool_use',
                'id': item.get('call_id') or item.get('id') or 'fc_coati',
                'name': item.get('name') or '',
                'input': _json_object(
                    item.get('arguments'),
                    'Responses 工具调用参数不是有效 JSON，无法转换为 Anthropic tool_use',
                ),
            })
        elif kind == 'web_search_call':
            # 服务端工具：搜索已经由上游解决，客户端拿不出 tool_result。这里不能
            # 置 has_tool_use，否则 stop_reason 会变成 tool_use，让客户端傻等一个
            # 永远不会来的结果。只有 function_call / custom_tool_call 才该置位。
            content.extend(_web_search_call_to_anthropic(item))
    usage = payload.get('usage') or {}
    details = usage.get('input_tokens_details') or {}
    read = int(details.get('cached_tokens') or usage.get('cache_read_input_tokens') or 0)
    write = int(
        usage.get('cache_creation_input_tokens')
        or details.get('cache_write_tokens')
        or 0
    )
    total_input = int(usage.get('input_tokens') or 0)
    input_tokens = max(0, total_input - read - write)
    stop_reason = 'tool_use' if has_tool_use else (
        'max_tokens' if payload.get('status') == 'incomplete' else 'end_turn'
    )
    anthropic_usage = {
        'input_tokens': input_tokens,
        'output_tokens': int(usage.get('output_tokens') or 0),
    }
    if read:
        anthropic_usage['cache_read_input_tokens'] = read
    if write:
        anthropic_usage['cache_creation_input_tokens'] = write
    return {
        'id': payload.get('id') or 'msg_coati',
        'type': 'message',
        'role': 'assistant',
        'model': client_model or payload.get('model') or '',
        'content': content,
        'stop_reason': stop_reason,
        'usage': anthropic_usage,
    }


def _chat_sse_chunk(chunk_id, model, delta=None, finish_reason=None, usage=None):
    payload = {
        'id': chunk_id,
        'object': 'chat.completion.chunk',
        'model': model or '',
        'choices': [{
            'index': 0,
            'delta': delta or {},
            'finish_reason': finish_reason,
        }],
    }
    if usage is not None:
        payload['usage'] = usage
    return ('data: ' + json.dumps(payload, ensure_ascii=False) + '\n\n').encode('utf-8')


def _chat_sse_done():
    return b'data: [DONE]\n\n'


def _chat_usage_from_anthropic(usage):
    usage = usage if isinstance(usage, dict) else {}
    input_tokens = int(usage.get('input_tokens') or 0)
    cache_read = int(usage.get('cache_read_input_tokens') or 0)
    cache_write = int(usage.get('cache_creation_input_tokens') or 0)
    result = {
        'prompt_tokens': input_tokens + cache_read + cache_write,
        'completion_tokens': int(usage.get('output_tokens') or 0),
    }
    if cache_read:
        result['prompt_tokens_details'] = {'cached_tokens': cache_read}
    if cache_write:
        result['cache_creation_input_tokens'] = cache_write
    return result


def _chat_usage_from_responses(usage):
    usage = usage if isinstance(usage, dict) else {}
    details = usage.get('input_tokens_details') or {}
    cached = int(details.get('cached_tokens') or usage.get('cache_read_input_tokens') or 0)
    created = int(
        usage.get('cache_creation_input_tokens')
        or details.get('cache_write_tokens')
        or 0
    )
    result = {
        'prompt_tokens': int(usage.get('input_tokens') or 0),
        'completion_tokens': int(usage.get('output_tokens') or 0),
    }
    if cached:
        result['prompt_tokens_details'] = {'cached_tokens': cached}
    if created:
        result['cache_creation_input_tokens'] = created
    return result


class _SseEventBridge:
    """为需要读取 event/data 两行的上游 SSE 提供统一解析。"""

    def __init__(self):
        self._pending_event = None

    def feed_line(self, line):
        line = line or ''
        if line.startswith('event:'):
            self._pending_event = line[6:].strip()
            return b''
        if not line.startswith('data:'):
            if not line.strip():
                self._pending_event = None
            return b''
        raw = line[5:].strip()
        event = self._pending_event
        self._pending_event = None
        if raw in ('', '[DONE]'):
            return self.finish() if raw == '[DONE]' else b''
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError):
            return b''
        return self.feed(payload, event=event)


def stream_error_message(payload):
    """识别 Anthropic / Responses SSE 中的显式失败事件。"""
    if not isinstance(payload, dict):
        return None
    kind = str(payload.get('type') or '')
    response = payload.get('response') if isinstance(payload.get('response'), dict) else {}
    status = str(response.get('status') or payload.get('status') or '')
    if kind not in {'error', 'response.error', 'response.failed'} and status != 'failed':
        return None
    error = payload.get('error')
    if not isinstance(error, dict):
        error = response.get('error') if isinstance(response.get('error'), dict) else {}
    message = error.get('message') or payload.get('message') or response.get('message')
    error_type = error.get('type') or kind or 'stream_error'
    return str(message or f'上游流式响应失败（{error_type}）')


class AnthropicToOpenAIStream(_SseEventBridge):
    """将 Anthropic Messages SSE 直接归一为 OpenAI Chat SSE。"""

    def __init__(self, client_model=None):
        super().__init__()
        self.client_model = client_model or ''
        self.chat_id = 'chatcmpl_coati'
        self.started = False
        self.finished = False
        self.finish_sent = False
        self.tool_indexes = {}
        self.next_tool_index = 0
        self.tool_calls_seen = False
        self.usage = {}

    def _start(self, message=None):
        if self.started:
            return b''
        self.started = True
        message = message if isinstance(message, dict) else {}
        self.chat_id = message.get('id') or self.chat_id
        if not self.client_model:
            self.client_model = message.get('model') or ''
        return _chat_sse_chunk(
            self.chat_id, self.client_model,
            {'role': 'assistant', 'content': ''},
        )

    @staticmethod
    def _finish_reason(reason):
        return {
            'end_turn': 'stop',
            'stop_sequence': 'stop',
            'tool_use': 'tool_calls',
            'max_tokens': 'length',
        }.get(reason, 'stop')

    def _emit_finish(self, reason=None, usage=None):
        if self.finish_sent:
            return b''
        self.finish_sent = True
        if isinstance(usage, dict):
            self.usage.update({key: value for key, value in usage.items() if value is not None})
        return _chat_sse_chunk(
            self.chat_id, self.client_model, {},
            self._finish_reason(reason),
            _chat_usage_from_anthropic(self.usage) if self.usage else None,
        )

    def feed(self, obj, event=None):
        if not isinstance(obj, dict) or self.finished:
            return b''
        kind = event or obj.get('type') or ''
        error = stream_error_message(obj)
        if error:
            raise ProtocolBridgeError(error)
        out = b''
        if kind == 'message_start':
            message = obj.get('message') if isinstance(obj.get('message'), dict) else {}
            if isinstance(message.get('usage'), dict):
                self.usage.update({
                    key: value for key, value in message['usage'].items()
                    if value is not None
                })
            out += self._start(message)
        elif kind == 'content_block_start':
            out += self._start()
            block = obj.get('content_block') or {}
            if block.get('type') == 'tool_use':
                source_index = obj.get('index', self.next_tool_index)
                tool_index = self.tool_indexes.get(source_index)
                if tool_index is None:
                    tool_index = self.next_tool_index
                    self.next_tool_index += 1
                    self.tool_indexes[source_index] = tool_index
                self.tool_calls_seen = True
                out += _chat_sse_chunk(self.chat_id, self.client_model, {
                    'tool_calls': [{
                        'index': tool_index,
                        'id': block.get('id') or f'call_{tool_index}',
                        'type': 'function',
                        'function': {
                            'name': block.get('name') or '',
                            'arguments': '',
                        },
                    }],
                })
        elif kind == 'content_block_delta':
            out += self._start()
            delta = obj.get('delta') or {}
            delta_type = delta.get('type')
            if delta_type == 'text_delta' and delta.get('text'):
                out += _chat_sse_chunk(self.chat_id, self.client_model, {
                    'content': delta['text'],
                })
            elif delta_type == 'thinking_delta' and delta.get('thinking'):
                out += _chat_sse_chunk(self.chat_id, self.client_model, {
                    'reasoning_content': delta['thinking'],
                })
            elif delta_type == 'input_json_delta' and delta.get('partial_json'):
                source_index = obj.get('index', 0)
                tool_index = self.tool_indexes.setdefault(source_index, self.next_tool_index)
                self.next_tool_index = max(self.next_tool_index, tool_index + 1)
                self.tool_calls_seen = True
                out += _chat_sse_chunk(self.chat_id, self.client_model, {
                    'tool_calls': [{
                        'index': tool_index,
                        'function': {'arguments': delta['partial_json']},
                    }],
                })
        elif kind == 'message_delta':
            delta = obj.get('delta') or {}
            reason = delta.get('stop_reason')
            if reason or obj.get('usage'):
                if self.tool_calls_seen and reason is None:
                    reason = 'tool_use'
                out += self._emit_finish(reason, obj.get('usage'))
        elif kind == 'message_stop':
            out += self._emit_finish('tool_use' if self.tool_calls_seen else 'end_turn')
            out += _chat_sse_done()
            self.finished = True
        return out

    def finish(self):
        if self.finished:
            return b''
        out = self._start()
        out += self._emit_finish('tool_use' if self.tool_calls_seen else 'end_turn')
        out += _chat_sse_done()
        self.finished = True
        return out


class ResponsesToOpenAIStream(_SseEventBridge):
    """将 OpenAI Responses SSE 直接归一为 OpenAI Chat SSE。"""

    def __init__(self, client_model=None):
        super().__init__()
        self.client_model = client_model or ''
        self.chat_id = 'chatcmpl_coati'
        self.started = False
        self.finished = False
        self.finish_sent = False
        self.tool_indexes = {}
        self.next_tool_index = 0
        self.tool_calls_seen = False
        self.refusal_buf = []

    def _start(self, response=None):
        if self.started:
            return b''
        self.started = True
        response = response if isinstance(response, dict) else {}
        self.chat_id = response.get('id') or self.chat_id
        if not self.client_model:
            self.client_model = response.get('model') or ''
        return _chat_sse_chunk(
            self.chat_id, self.client_model,
            {'role': 'assistant', 'content': ''},
        )

    def _emit_finish(self, status=None, usage=None):
        if self.finish_sent:
            return b''
        self.finish_sent = True
        reason = 'tool_calls' if self.tool_calls_seen else ('length' if status == 'incomplete' else 'stop')
        return _chat_sse_chunk(
            self.chat_id, self.client_model, {}, reason,
            _chat_usage_from_responses(usage) if usage is not None else None,
        )

    def feed(self, obj, event=None):
        if not isinstance(obj, dict) or self.finished:
            return b''
        kind = event or obj.get('type') or ''
        error = stream_error_message(obj)
        if error:
            raise ProtocolBridgeError(error)
        out = b''
        if kind == 'response.created':
            out += self._start(obj.get('response'))
        elif kind == 'response.output_item.added':
            out += self._start()
            item = obj.get('item') or {}
            if item.get('type') in ('function_call', 'custom_tool_call'):
                source_index = obj.get('output_index', self.next_tool_index)
                tool_index = self.tool_indexes.get(source_index)
                if tool_index is None:
                    tool_index = self.next_tool_index
                    self.next_tool_index += 1
                    self.tool_indexes[source_index] = tool_index
                self.tool_calls_seen = True
                out += _chat_sse_chunk(self.chat_id, self.client_model, {
                    'tool_calls': [{
                        'index': tool_index,
                        'id': item.get('call_id') or item.get('id') or f'call_{tool_index}',
                        'type': 'function',
                        'function': {
                            'name': item.get('name') or '',
                            'arguments': '',
                        },
                    }],
                })
        elif kind == 'response.output_text.delta':
            out += self._start()
            if obj.get('delta'):
                out += _chat_sse_chunk(self.chat_id, self.client_model, {
                    'content': obj['delta'],
                })
        elif kind == 'response.refusal.delta':
            out += self._start()
            if obj.get('delta'):
                refusal = str(obj['delta'])
                self.refusal_buf.append(refusal)
                out += _chat_sse_chunk(self.chat_id, self.client_model, {
                    'content': refusal,
                })
        elif kind == 'response.refusal.done':
            # Some compatible Responses servers omit refusal.delta and only
            # send the terminal event.  Emit it once so clients never see a
            # blank successful assistant message.
            if not self.refusal_buf and obj.get('refusal'):
                out += self._start()
                refusal = str(obj['refusal'])
                self.refusal_buf.append(refusal)
                out += _chat_sse_chunk(self.chat_id, self.client_model, {
                    'content': refusal,
                })
        elif kind in ('response.reasoning_summary_text.delta', 'response.reasoning_text.delta'):
            out += self._start()
            if obj.get('delta'):
                out += _chat_sse_chunk(self.chat_id, self.client_model, {
                    'reasoning_content': obj['delta'],
                })
        elif kind in ('response.function_call_arguments.delta', 'response.custom_tool_call_input.delta'):
            out += self._start()
            source_index = obj.get('output_index', 0)
            tool_index = self.tool_indexes.setdefault(source_index, self.next_tool_index)
            self.next_tool_index = max(self.next_tool_index, tool_index + 1)
            self.tool_calls_seen = True
            if obj.get('delta'):
                out += _chat_sse_chunk(self.chat_id, self.client_model, {
                    'tool_calls': [{
                        'index': tool_index,
                        'function': {'arguments': obj['delta']},
                    }],
                })
        elif kind in ('response.completed', 'response.incomplete', 'response.done'):
            response = obj.get('response') if isinstance(obj.get('response'), dict) else obj
            out += self._emit_finish(response.get('status'), response.get('usage'))
            out += _chat_sse_done()
            self.finished = True
        return out

    def finish(self):
        if self.finished:
            return b''
        out = self._start()
        out += self._emit_finish('completed')
        out += _chat_sse_done()
        self.finished = True
        return out


class ProtocolStreamPipeline:
    """源协议 SSE → Chat 中间事件 → 目标协议 SSE。"""

    def __init__(self, source, target):
        self.source = source
        self.target = target

    @property
    def finished(self):
        return bool(
            getattr(self.source, 'finished', False)
            and getattr(self.target, 'finished', False)
        )

    @staticmethod
    def _as_bytes(value):
        if isinstance(value, bytes):
            return value
        if isinstance(value, list):
            return b''.join(item for item in value if isinstance(item, bytes))
        return b''

    def _feed_chat_output(self, raw):
        result = b''
        for line in self._as_bytes(raw).decode('utf-8', errors='replace').splitlines():
            if not line.startswith('data: '):
                continue
            data = line[6:].strip()
            if data == '[DONE]':
                result += self._as_bytes(self.target.finish())
                continue
            try:
                payload = json.loads(data)
            except (TypeError, ValueError):
                continue
            result += self._as_bytes(self.target.feed(payload))
        return result

    def feed_line(self, line):
        return self._feed_chat_output(self.source.feed_line(line))

    def finish(self):
        result = self._feed_chat_output(self.source.finish())
        if not getattr(self.target, 'finished', False):
            result += self._as_bytes(self.target.finish())
        return result


class OpenAIToResponsesStream:
    """把上游 Chat Completions SSE 收成 Codex 要的 Responses SSE。"""

    def __init__(self, client_model=None):
        self.client_model = client_model or ''
        self.response_id = 'resp_coati'
        self.created_at = int(time.time())
        self.sequence_number = 0
        self.started = False
        self.finished = False
        self.output_index = 0
        self.text_open = False
        self.reasoning_open = False
        self.refusal_open = False
        self.tool_started = {}
        self.tool_output_indices = {}
        self.text_buf = []
        self.reasoning_buf = []
        self.refusal_buf = []
        self.output = []

    def _event(self, event, payload):
        """Encode a Responses event with the mandatory monotonic sequence number."""
        body = dict(payload or {})
        body.setdefault('type', event)
        body['sequence_number'] = self.sequence_number
        self.sequence_number += 1
        return encode_sse(event, body)

    def start(self):
        if self.started:
            return b''
        self.started = True
        skeleton = _responses_response(
            self.response_id,
            self.client_model,
            status='in_progress',
            created_at=self.created_at,
        )
        return self._event('response.created', {'response': skeleton}) + self._event(
            'response.in_progress', {'response': dict(skeleton)},
        )

    def _open_reasoning(self):
        if self.reasoning_open:
            return []
        item = {'id': 'rs_coati', 'type': 'reasoning', 'summary': []}
        chunks = [self._event('response.output_item.added', {
            'output_index': self.output_index, 'item': item,
        }), self._event('response.reasoning_summary_part.added', {
            'item_id': item['id'],
            'output_index': self.output_index,
            'summary_index': 0,
            'part': {'type': 'summary_text', 'text': ''},
        })]
        self.reasoning_open = True
        return chunks

    def _close_reasoning(self):
        if not self.reasoning_open:
            return []
        text = ''.join(self.reasoning_buf)
        item = {
            'id': 'rs_coati',
            'type': 'reasoning',
            'summary': [{'type': 'summary_text', 'text': text}] if text else [],
        }
        self.output.append(item)
        chunks = [
            self._event('response.reasoning_summary_text.done', {
                'item_id': item['id'],
                'output_index': self.output_index,
                'summary_index': 0,
                'text': text,
            }),
            self._event('response.reasoning_summary_part.done', {
                'item_id': item['id'],
                'output_index': self.output_index,
                'summary_index': 0,
                'part': {'type': 'summary_text', 'text': text},
            }),
            self._event('response.output_item.done', {
                'output_index': self.output_index, 'item': item,
            }),
        ]
        self.reasoning_open = False
        self.output_index += 1
        return chunks

    def _open_text(self):
        chunks = self._close_reasoning() + self._close_refusal()
        if self.text_open:
            return chunks
        item = {
            'id': 'msg_coati',
            'type': 'message',
            'status': 'in_progress',
            'role': 'assistant',
            'content': [_responses_output_text('')],
        }
        chunks.append(self._event('response.output_item.added', {
            'output_index': self.output_index,
            'item': item,
        }))
        chunks.append(self._event('response.content_part.added', {
            'item_id': item['id'],
            'output_index': self.output_index,
            'content_index': 0,
            'part': _responses_output_text(''),
        }))
        self.text_open = True
        return chunks

    def _close_text(self):
        if not self.text_open:
            return []
        text = ''.join(self.text_buf)
        item = {
            'id': 'msg_coati',
            'type': 'message',
            'status': 'completed',
            'role': 'assistant',
            'content': [_responses_output_text(text)],
        }
        self.output.append(item)
        chunks = [
            self._event('response.output_text.done', {
                'item_id': item['id'],
                'output_index': self.output_index,
                'content_index': 0,
                'text': text,
                'logprobs': [],
            }),
            self._event('response.content_part.done', {
                'item_id': item['id'],
                'output_index': self.output_index,
                'content_index': 0,
                'part': _responses_output_text(text),
            }),
            self._event('response.output_item.done', {
                'output_index': self.output_index,
                'item': item,
            }),
        ]
        self.text_open = False
        self.output_index += 1
        return chunks

    def _open_refusal(self):
        chunks = self._close_reasoning() + self._close_text()
        if self.refusal_open:
            return chunks
        item = {
            'id': 'msg_coati',
            'type': 'message',
            'status': 'in_progress',
            'role': 'assistant',
            'content': [{'type': 'refusal', 'refusal': ''}],
        }
        chunks.extend([
            self._event('response.output_item.added', {
                'output_index': self.output_index, 'item': item,
            }),
            self._event('response.content_part.added', {
                'item_id': item['id'],
                'output_index': self.output_index,
                'content_index': 0,
                'part': {'type': 'refusal', 'refusal': ''},
            }),
        ])
        self.refusal_open = True
        return chunks

    def _close_refusal(self):
        if not self.refusal_open:
            return []
        refusal = ''.join(self.refusal_buf)
        item = {
            'id': 'msg_coati',
            'type': 'message',
            'status': 'completed',
            'role': 'assistant',
            'content': [{'type': 'refusal', 'refusal': refusal}],
        }
        self.output.append(item)
        chunks = [
            self._event('response.refusal.done', {
                'item_id': item['id'],
                'output_index': self.output_index,
                'content_index': 0,
                'refusal': refusal,
            }),
            self._event('response.content_part.done', {
                'item_id': item['id'],
                'output_index': self.output_index,
                'content_index': 0,
                'part': {'type': 'refusal', 'refusal': refusal},
            }),
            self._event('response.output_item.done', {
                'output_index': self.output_index, 'item': item,
            }),
        ]
        self.refusal_open = False
        self.refusal_buf = []
        self.output_index += 1
        return chunks

    def feed(self, obj):
        if not isinstance(obj, dict):
            return b''
        if obj.get('id'):
            self.response_id = obj['id']
        out = [self.start()] if not self.started else []
        choice = (obj.get('choices') or [{}])[0] or {}
        delta = choice.get('delta') or {}
        reasoning = delta.get('reasoning_content')
        if reasoning:
            out.extend(self._open_reasoning())
            self.reasoning_buf.append(str(reasoning))
            out.append(self._event('response.reasoning_summary_text.delta', {
                'item_id': 'rs_coati',
                'output_index': self.output_index,
                'summary_index': 0,
                'delta': str(reasoning),
            }))
        refusal = delta.get('refusal')
        if refusal:
            out.extend(self._open_refusal())
            self.refusal_buf.append(str(refusal))
            out.append(self._event('response.refusal.delta', {
                'item_id': 'msg_coati',
                'output_index': self.output_index,
                'content_index': 0,
                'delta': str(refusal),
            }))
        content = delta.get('content')
        if content:
            if not isinstance(content, str):
                content = _text_from_blocks(content)
            out.extend(self._open_text())
            self.text_buf.append(content)
            out.append(self._event('response.output_text.delta', {
                'item_id': 'msg_coati',
                'output_index': self.output_index,
                'content_index': 0,
                'delta': content,
                'logprobs': [],
            }))
        for call in delta.get('tool_calls') or []:
            if not isinstance(call, dict):
                continue
            out.extend(self._close_reasoning())
            out.extend(self._close_text())
            out.extend(self._close_refusal())
            index = call.get('index', 0)
            if index not in self.tool_started:
                fn = call.get('function') or {}
                call_id = call.get('id') or f'fc_{index}'
                item = {
                    'id': call_id,
                    'type': 'function_call',
                    'call_id': call_id,
                    'name': fn.get('name') or '',
                    'arguments': '',
                }
                self.tool_started[index] = item
                self.tool_output_indices[index] = self.output_index
                self.output_index += 1
                out.append(self._event('response.output_item.added', {
                    'output_index': self.tool_output_indices[index],
                    'item': item,
                }))
            fn = call.get('function') or {}
            if fn.get('name'):
                self.tool_started[index]['name'] = fn['name']
            args = (call.get('function') or {}).get('arguments')
            if args:
                if not isinstance(args, str):
                    args = json.dumps(args, ensure_ascii=False)
                self.tool_started[index]['arguments'] += args
                out.append(self._event('response.function_call_arguments.delta', {
                    'item_id': self.tool_started[index]['id'],
                    'output_index': self.tool_output_indices[index],
                    'delta': args,
                }))
        usage = obj.get('usage')
        finish = choice.get('finish_reason')
        if finish or (usage and not delta):
            out.extend(self.finish(finish, usage))
        return b''.join(out)

    def finish(self, finish_reason=None, usage=None):
        if self.finished:
            return []
        self.finished = True
        chunks = [self.start()] if not self.started else []
        chunks.extend(self._close_reasoning())
        chunks.extend(self._close_text())
        chunks.extend(self._close_refusal())
        for index in sorted(self.tool_started):
            item = self.tool_started[index]
            self.output.append(item)
            chunks.append(self._event('response.function_call_arguments.done', {
                'item_id': item['id'],
                'output_index': self.tool_output_indices[index],
                'name': item.get('name') or '',
                'arguments': item.get('arguments') or '',
            }))
            chunks.append(self._event('response.output_item.done', {
                'output_index': self.tool_output_indices[index],
                'item': item,
            }))
        self.tool_started.clear()
        self.tool_output_indices.clear()
        status = 'incomplete' if finish_reason == 'length' else 'completed'
        response = _responses_response(
            self.response_id,
            self.client_model,
            list(self.output),
            status=status,
            usage=usage,
            created_at=self.created_at,
            incomplete_details={'reason': 'max_output_tokens'} if status == 'incomplete' else None,
        )
        event_name = 'response.incomplete' if status == 'incomplete' else 'response.completed'
        chunks.append(self._event(event_name, {'response': response}))
        return chunks


# 只有以下三种协议进入网关的统一转换层。上游协议名称与 constants.py 保持一致，
# 这里集中维护矩阵，避免 gateway_service 再出现一组不对称的 if/elif。
_REQUEST_BRIDGES = {
    ('openai', 'anthropic-messages'): openai_to_anthropic_body,
    ('openai', 'openai-responses'): openai_to_responses_body,
    ('anthropic', 'openai-chat'): anthropic_to_openai_body,
    ('anthropic', 'openai-responses'): anthropic_to_responses_body,
    ('responses', 'openai-chat'): responses_to_openai_body,
    ('responses', 'anthropic-messages'): responses_to_anthropic_body,
}

_RESPONSE_BRIDGES = {
    ('openai-chat', 'anthropic'): openai_to_anthropic_message,
    ('openai-chat', 'responses'): openai_to_responses_message,
    ('anthropic-messages', 'openai'): anthropic_to_openai_message,
    ('anthropic-messages', 'responses'): anthropic_to_responses_message,
    ('openai-responses', 'openai'): responses_to_openai_message,
    ('openai-responses', 'anthropic'): responses_to_anthropic_message,
}


def bridge_request_body(body, inbound_protocol, upstream_protocol):
    """按协议矩阵转换请求；同协议返回浅拷贝，避免污染客户端原始 body。"""
    native = {
        'openai': 'openai-chat',
        'anthropic': 'anthropic-messages',
        'responses': 'openai-responses',
    }
    if native.get(inbound_protocol) == upstream_protocol:
        return dict(body or {})
    converter = _REQUEST_BRIDGES.get((inbound_protocol, upstream_protocol))
    if converter is None:
        raise ProtocolBridgeError(
            f'暂不支持 {inbound_protocol} → {upstream_protocol} 请求转换',
        )
    return converter(body)


def bridge_response_body(payload, upstream_protocol, inbound_protocol, client_model=None):
    """按协议矩阵转换非流式响应。"""
    native = {
        'openai': 'openai-chat',
        'anthropic': 'anthropic-messages',
        'responses': 'openai-responses',
    }
    if native.get(inbound_protocol) == upstream_protocol:
        return payload
    converter = _RESPONSE_BRIDGES.get((upstream_protocol, inbound_protocol))
    if converter is None:
        raise ProtocolBridgeError(
            f'暂不支持 {upstream_protocol} → {inbound_protocol} 响应转换',
        )
    return converter(payload, client_model)


def build_stream_bridge(upstream_protocol, inbound_protocol, client_model=None):
    """创建流式转换器；同协议路径返回 None，代表原样透传。"""
    native = {
        'openai': 'openai-chat',
        'anthropic': 'anthropic-messages',
        'responses': 'openai-responses',
    }
    if native.get(inbound_protocol) == upstream_protocol:
        return None
    if upstream_protocol == 'openai-chat' and inbound_protocol == 'anthropic':
        return OpenAIToAnthropicStream(client_model)
    if upstream_protocol == 'openai-chat' and inbound_protocol == 'responses':
        return OpenAIToResponsesStream(client_model)
    if upstream_protocol == 'anthropic-messages' and inbound_protocol == 'openai':
        return AnthropicToOpenAIStream(client_model)
    if upstream_protocol == 'openai-responses' and inbound_protocol == 'openai':
        return ResponsesToOpenAIStream(client_model)
    if upstream_protocol == 'anthropic-messages' and inbound_protocol == 'responses':
        return ProtocolStreamPipeline(
            AnthropicToOpenAIStream(client_model),
            OpenAIToResponsesStream(client_model),
        )
    if upstream_protocol == 'openai-responses' and inbound_protocol == 'anthropic':
        return ProtocolStreamPipeline(
            ResponsesToOpenAIStream(client_model),
            OpenAIToAnthropicStream(client_model),
        )
    raise ProtocolBridgeError(
        f'暂不支持 {upstream_protocol} → {inbound_protocol} 流式转换',
    )
