# 服务端工具迁移

## 已实现：独立搜索服务适配层

`search-provider.ts`迁移Python search_providers.py中的Tavily search/extract请求契约。只向部署者配置的供应商端点发HTTP请求；用户目标网页URL作为extract请求体发送，不在网关本机直接抓取。

搜索支持query（1–400字符）、limit（1–20，默认5）、域名白名单和黑名单。过滤再次在返回结果上执行，阻止example.com匹配evil-example.com，去重并限制数量；保留标题、摘要和发布日期。支持裸域名或 URL/路径过滤：域名允许子域，路径按完整片段匹配。允许/阻止同时配置时取交集；阻止路径只做结果过滤，不向供应商扩大成整个域名阻止。

抓取接受HTTP(S)网页，拒绝凭证URL、localhost（含尾点）、已知私网/保留IP字面值及非HTTP协议。结果可采用供应商返回的跳转后URL，但仍需满足访问范围。网关不解析/连接目标网页域名，供应商负责实际抓取访问控制。正文默认最多50000字符，可设1–200000，返回truncated。供应商响应最多2MiB；标题、摘要等字段分别有上限。

适配层使用现有GatewayTransport，采用平台上游的出站策略，保持TLS验证、取消、超时和不自动跟随供应商HTTP重定向。超时默认15秒，允许3–60秒；鉴权、限流、无效JSON/结构、空正文分别返回稳定错误码，不透出供应商响应原文及密钥。

## 已实现：管理配置

控制台 `/gateway/web-search` 支持 Tavily、API Key、HTTP(S) 代理、3–60 秒超时。菜单权限 `gateway_websearch`，保存、恢复和检查要求 `gateway_websearch_edit`。管理 API 为 `/api/admin/gateway/web-search`（另有 `/api/admin/agent/web-search` 别名）：GET 读取、PUT 保存、DELETE 恢复环境配置、POST `/test` 检查已保存配置。

0036 迁移增加单行配置表。数据库逐字段覆盖环境变量：`AGENT_WEBSEARCH_PROVIDER`、`AGENT_WEBSEARCH_API_KEY`、`AGENT_WEBSEARCH_PROXY_URL`、`AGENT_WEBSEARCH_TIMEOUT_SECONDS`。未覆盖的字段读取环境变量；默认不启用、超时15秒。Key 和代理地址加密保存，读取只返回是否配置与脱敏代理提示。编辑留空保留值；显式清除存储空值，不回退环境变量；恢复环境配置删除全部覆盖值。未设置搜索服务专用代理时仍遵循平台出站策略。

读取、保存、恢复均不发起搜索。检查按钮明确提示会执行一次真实搜索，使用已保存配置，忽略未保存表单内容；请求取消和超时会传递至供应商。开发验证仅使用本地模拟供应商，没有执行真实检查。

## Direct search API contract (2026-09-26)

POST `/v1/web-search` and `/api/agent/v1/web-search` accept `{ "query": "search text", "max_results": 5 }`. Trimmed query length is 1-400; max_results follows Python integer conversion and clamps to 1–8, defaulting to 5 for null/omission. Malformed strings return 400. Requires a valid token with chat scope and model permission `*` or `web-search`. Returns query/sources/truncated and X-Request-Id/X-Agent-Request-Id. Missing configuration returns 503; provider errors remain sanitized. Provider failure may delegate to an explicit native capability route or, when none is configured, the platform capability pool.

Uses the existing atomic owner/key daily budget, RPM and concurrent-request reservation shared with model calls. Reserves the query estimate plus 4096 output units. Oversized sources are shortened (snippets first, then result count) and marked truncated. Estimates use serialized UTF-8 bytes divided by 3, rounded up. Success settles returned content; failure/cancellation releases reservations with zero local token charge, which does not imply zero supplier cost. Request protocol/model is web-search, usage_source is estimated, and cache fields remain unknown. raw_usage records provider search attempts and successful result count, not supplier-reported model tokens. Query text and page bodies are not persisted.

Saved provider timeout still applies, with a 65-second outer search deadline and client-disconnect cancellation. Failed settlement leaves the reservation for existing expiry recovery; process interruption may temporarily charge the reserved estimate and requires reconciliation. This is request-level search audit; multi-round child requests retain the parent request ID.

## Model delegation and multi-round runtime (2026-09-26)

A failed/unconfigured independent search uses an explicit `web-search` route first, or eligible platform Responses/Messages accounts when no explicit route exists. A disabled explicit route prevents automatic fallback. Normal model permissions, quota admission, leases, account health and reported usage apply. The failed provider request is settled before delegation; the model request links to it through request_context.parent_request_id. Only native search result/citation fields count as sources; model prose URLs are not accepted. Cancellation and timeouts do not trigger another paid attempt. For OpenAI accounts explicitly marked DeepSeek, the legacy same-origin Messages endpoint is derived; other undeclared protocols/endpoints are not guessed.

The model API now recognizes web_search*/web_fetch* declarations. A native-compatible account is preferred. Messages completes the internal non-streaming tool loop before emitting final SSE; native Responses retains live SSE. Otherwise a bounded fallback converts server tools into ordinary function calls, executes provider search/extract, supplies results and continues the model. Client tools are returned to the caller; they are not executed by the gateway. Each round uses normal model accounting; independent tool calls reserve against the same authorized public model and owner/key limits, with parent attribution in raw_usage. Reported counters are summed across model rounds. usage.coati_usage records rounds and partial_fields (canonical Messages field paths) whenever a counter was not reported in every round; entirely unreported fields remain absent. Per-round ledger entries retain the original evidence.

Fallback limits: max_uses defaults to 5, permits 0 and values above 8; model rounds use min(10,max(2,min(max_uses)+2)), one deadline (including native attempts),1MiB model history and bounded arguments/results. Domain/path filters apply before fetch and after provider redirects. Location hints are appended to provider search queries. max_content_tokens uses a conservative UTF-8-byte cap for extraction because Tavily has no model tokenizer; the content also remains within the local12,000-character ceiling. Native provider declarations retain their fields.

Explicit unsupported web_search/web_fetch errors before streaming can fall back to function tools. A native ordinary tool response is reused without issuing a duplicate first round. Search/extract provider failure may delegate through authorized web-search/web-fetch public routes; extraction accepts only actual native fetch-result documents. Chat/Responses fallback carries server evidence as explicitly labeled text, avoiding silent source loss and fabricated provider-native citations.

Fallback SSE is buffered: tool/model work settles before the final response is emitted as protocol events. Native Responses continues live streaming; Messages is buffered even on a native account. This does not claim incremental multi-round tool progress. Messages results include paired server_tool_use/results and an explicitly Coati-formatted replay envelope (base64url, not cryptographic encryption). A client disconnect cancels ongoing work; no automatic replay is performed.

Five real-DB/local-HTTP workflows cover search+fetch rounds, cache accumulation and child logs, native Messages SSE shape, restricted-domain zero extraction, max-use/round bounds and public API dispatch. The delegated-search test additionally checks native citations and provider-to-model lineage. This evidence does not replace all nine protocol/tool combinations or real-provider acceptance.

## 真实 Tavily 验收（2026-09-26）

用户配置搜索服务后，读取已保存的 Tavily 配置执行了小量真实验收：

- 抓取 TypeScript 官方 narrowing 文档成功，3000 字符上限生效并报告 truncated。
- `/v1/web-search` 返回 200 和 3 个带标题/URL 的真实来源。
- Messages 入口经 DeepSeek Chat 上游执行搜索、网页抓取、模型继续回答；返回 200，包含两种 server_tool_use、对应结果块及文本回答。
- 本轮 5 条请求账本全部为 ok；两轮模型用量来自 upstream，搜索/抓取标为 estimated，工具子记录关联父请求。模型合计输入3317（含缓存读取256）、输出436；Messages wire input3061 加 cache_read256 与账本总输入一致。
- 临时访问令牌已撤销，临时路由已删除，用户搜索及模型服务配置未修改。

这是独立搜索、提取与一个真实 Messages → Chat 工具循环的验收，不代表九种协议组合、流式工具循环或长时间稳定性已全部通过。供应商搜索费用未做账单对账。

### Historical replay repair

Messages history is normalized even without a new tool declaration. Search coati1 envelopes (including Python URL-safe Base64 padding) restore the original body, and fetch documents become readable text. No historical URL is fetched again. The final replay envelope uses Python-compatible padding. A local HTTP regression verifies both bodies reach the upstream and no search/extract call occurs.


## 第六批继续对齐

未确认会执行原生工具的账号默认走普通函数闭环。原生委托收到真实来源/抓取正文后记录进程内能力；按账号连接配置作指纹隔离，观察上限10000，不持久化、不据厂商名称猜测。只允许已确认账号接收原生声明，运行时仍重新核对允许账号集合。Responses不能表达max_uses/blocked_domains/native fetch，出现这些约束时在网关执行。

搜索工具接受query、queries、q、search_query、search_queries及列表/JSON列表，去重后每条查询单独计数，每条产生server_tool_use/result；空输入与超限产生明确工具错误。Messages usage.server_tool_use包含尝试次数。历史回放与count_tokens共享归一化逻辑。

委托优先使用显式web-search/web-fetch路由，无配置时使用平台能力池；仅派生旧版已知的DeepSeek同源端点。内部工具继承原模型授权，并检查真实父记录属于同一令牌和模型，直接能力API仍要求对应授权。尚存边界：多轮usage缺失字段不虚构完整总量；跨协议引用以文本证据保留，不能当作任意供应商原生citation格式保证。


## 第七批：纯搜索与失败切换

Messages单消息、唯一搜索工具且以Python固定引导语开头时，直接执行一次搜索并返回结果，省去普通模型轮次；普通问答不触发。`AGENT_WEB_SEARCH_SHORTCUT_ENABLED=false`可关闭，Compose传入API/worker。成功用实际已结算receipt的usage生成JSON/SSE，不重复估算；模型委托的reported缓存量经协议转换保留。未配置/失败/空结果继续普通闭环；取消、期限、准入和结算错误停止。

原生能力账号的HTTP鉴权/限流失败允许切换下一个候选，调用者鉴权/限额错误不允许。不会把普通4xx失败永久记为“不支持原生工具”。本轮隔离验证包含首账号401、后续账号成功及失败账本；没有新付费请求。

此为第七批当时状态：Node曾仅输出每轮都有的汇总字段。最终收尾已改为累计已报告值，并用coati_usage标注不完整字段；各轮原始计数完整留账。跨协议文本证据不伪装供应商原生citation。


## 第八批：预算与独立能力

独立搜索及工具子请求预留沿用AGENT_QUOTA_RESERVATION_TTL_SECONDS；默认3600秒，网络期限不随之延长。原生抓取回退与Tavily共享显式UTF-8字节预算，不切断码点，并保留上游已有截断标记。原生能力确认分别存储搜索和抓取，一个能力的失败不屏蔽另一个；多工具原生请求需要各项能力均确认。详见batch-8-acceptance.md。

## 最终功能契约（2026-09-26）

工具调用按[功能收尾验收](final-functional-acceptance.md)完成。usage.coati_usage示例：`{"aggregation":"sum_reported","rounds":3,"partial_fields":["cache_read_input_tokens"]}`。partial_fields使用Messages规范化字段路径，不随客户端协议变化。这里缓存累计是已报告轮次之和，不是缺失轮次按零补齐的完整总量。JSON及三入口SSE均携带该元数据。

推理/兼容策略在所有入口及纯搜索快捷路径统一校验，非法策略返回400且不发起工具调用。后续模型轮次保留根关联，搜索/抓取关联实际发起它的轮次；每轮模型记录真实客户端协议。未知供应商未来扩展不作为无终点的开发待办。
