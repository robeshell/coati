# 协议矩阵契约 v1（设计基线）

状态：本轮有限功能契约已验收，见[功能收尾验收](final-functional-acceptance.md)；真实历史迁移与发布交付尚未完成。代码：`apps/api/src/modules/gateway/protocol/`。沿用现有 `openai` / `responses` / `anthropic` 协议标识，分别代表 Chat Completions / Responses / Messages；不把供应商品牌作为路由协议。

## 当前推理与工具契约

默认推理策略preserve；签名能够表达时原样保留，无法表达时明确拒绝。客户端显式`X-Coati-Reasoning-Policy: text-only`允许可读推理的签名丢失；redacted_thinking仍只走可保留内容的原生路径，不生成虚假可读文本。不保证不同供应商接受对方签名。JSON/SSE及历史回放对应规则已验证。

默认字段兼容策略python，严格拒绝未知/不可表达控制字段可用strict；这与推理签名策略是两个独立选项。所有入口，包括无需模型轮次的搜索快捷路径，都先验证策略值。多轮工具usage累计已报告值并通过coati_usage标明不完整字段；每轮账本保留原始来源。

## 实现决策

不采用 LiteLLM 或 pi-ai。Coati 自研入站解码、上游编码及返回协议编码，以 Python 协议桥和回归测试为兼容基线；先完整迁移，后做 Node 专项优化。现有转换/降级行为需逐项记录与回归，不因新抽象自行删减；必要的行为修正必须记录差异和理由。缓存读写分别记录，保留上游提供的期限明细与原始用量，缺失字段不能视为零。

## 请求与响应边界

入站适配器负责解码和向客户端编码。上游适配器负责向模型发请求并产出统一事件；Coati 拥有鉴权、能力检查、调度、超时、网络策略及结算。三种入站与三种上游组成九个组合，每组合需普通和 SSE 验收。目前按实际路由配置执行同协议透传或跨协议转换；基础矩阵通过不代表全部协议扩展能力都已验收。

统一消息保留 system/developer/user/assistant/tool 角色和有序内容块。工具参数保留字符串，流式增量不能在完整接收前当作合法 JSON。工具结果关联 callId；客户端工具不由适配器执行。上游模型名只存在调用上下文，对外使用公开模型名。

协议专属字段保存原协议、字段路径和值。保存扩展不代表可以发送到其他协议；每个扩展必须由适配器识别、显式转换或报错，不支持把整个未知对象盲目 spread 到上游。入站运行时字段校验由后续适配器实现，当前 TypeScript 类型不能替代校验。

## 历史设计草案（下表不覆盖当前实现）

下表为设计策略草案，不能覆盖 Python 已支持的功能。迁移时以核对后的 Python 行为为准补齐能力；表中暂不支持/拒绝项只有在旧版同样不支持，或已明确批准改变时才可作为最终版规则。

| 能力 | 原生路径 | 跨协议默认规则 | 验收要求 |
| --- | --- | --- | --- |
| 文本、流式文本 | 保留协议语义 | 统一内容块/事件 | 九组合普通/SSE、中文分片 |
| 工具定义、选择、调用/结果 | 保留声明与 ID | 保留关联、参数、结果及顺序；不支持的选择策略拒绝 | 多轮、并行、碎片参数、非法参数 |
| system/developer | 保留角色 | 合并或降级必须有显式规则；不得自动当 user | 角色与优先级样例 |
| 图片 | 保留协议允许的来源 | 目标模型必须声明支持；URL/base64 转换不隐式抓取外链 | 类型/大小/网络策略 |
| 推理、签名、加密块 | 同协议按模型能力保留 | 不将签名跨供应商复用，不默认把推理转为正文 | 不支持时报错；可追踪降级策略另行实现 |
| 缓存控制 | 校验供应商能力 | 不等价字段拒绝；不能声称缓存命中保证 | 缓存写入/读取分别核算 |
| 结构化输出/strict 工具 | 仅声明支持的模型 | 不将提示词模拟当成 strict 支持 | schema/strict 能力检查 |
| stop/temperature/top_p/输出上限 | 协议及模型校验 | 映射后仍需能力与范围校验 | 边界值、不支持参数 |
| 用量 | 保留原始口径以便诊断 | 统一 input 包含缓存读/写，reasoning 是 output 子集 | 缓存不重复累计；缺失标为 estimated |
| Responses store/previous_response_id/conversation/background | 当前预览不支持 | 第一阶段明确拒绝状态语义；完整会话由调用方提供 | 不能退化成无状态成功 |
| 音频/视频/文件、多个候选 | 当前不在第一阶段承诺内 | 明确拒绝；后续按能力扩展 | 不能无声裁剪为文本或首候选 |
| 供应商原生服务端工具 | 按现有能力边界 | P5 单独处理，不能伪装成客户端函数调用 | 执行/权限/计费契约 |
| 未知字段 | 仅在安全校验后的原生路径允许透传 | 默认拒绝，给出字段路径与 unsupported_capability | 各方向负向用例 |

## 流式与结算

正常序列：start → 内容块 start/delta/end（可交错）→ usage（可更新）→ finish。usage 是累计快照，不是增量。缺少上游用量不能报零用量；结算层估算并标明来源。

error 可在 start 前发生，也可终止尚未关闭的内容块；终止后不得追加 finish。连接 EOF 没有终止事件是截断错误。块索引不重复，delta 必须匹配已打开内容块的种类。终止事件必须在结算成功后发出；`EventGuard` 仅验证生命周期，结算与实际 SSE 编码仍由运行层实现。

统一失败区分 invalid_request、unsupported_capability、upstream_error、timeout、cancelled、truncated_stream、settlement_failed。retryable 只是分类信息，不能绕过 Coati 的重试阶段与次数限制。HTTP 状态/协议错误帧由入站编码器负责。

传输必须支持请求取消、整体和空闲超时、DNS/地址限制、重定向策略、有限缓冲与背压。普通响应也需要限制总大小；若从事件聚合 JSON，不能无限累计。

## 验收骨架与下一步

`gateway-protocol.test.ts` 包含可执行事件不变量测试，以及矩阵验收义务。文本与上游错误的 36 项已由 gateway-matrix.test.ts 替代，其余 180 项仍明确标为 TODO。这些 TODO 不证明互转已实现，也不替代现有原生转发测试。

下一步补齐缓存明细落库、扩展能力/SDK 用例和剩余生命周期边界；已有 JSON 转换与流式转换均已接入上游执行器。每完成一类能力，将对应 TODO 替换为实际断言。发布前必须消除发布范围内的 TODO，不得依靠默认测试进程退出码判定兼容性完成。

## Python 对照实现状态

`bridge.ts` 目前提供六个直接请求/响应转换器的分派和同协议路径。迁移阶段采用直接转换以保持 Python 可观察行为，避免提前引入会丢失协议专属字段的统一中间对象；前面的统一契约仍用于生命周期和后续执行边界设计。service 已按上游协议选择转换器，并保持入站协议的返回格式。

运行 `python3 scripts/export-protocol-fixtures.py --check` 可重放 43 个原测试，核对确定性 JSON 样例与流式轨迹。运行 `pnpm --filter @coati/api test gateway-python-parity` 可验证 Node 对照结果。修改 Python 基线后必须审查差异，不能为让 Node 测试通过而直接覆盖期望值。


## Cache-usage matrix acceptance — 2026-09-26

Added 54 wire/database cases: every one of nine protocol pairs, JSON and SSE, with full cache/reasoning detail, explicitly reported zero, and absent usage. Assertions cover input/output totals, read/write/miss, 5m/1h creation buckets, reasoning, source provenance and persisted counters; unreported wire counters remain absent rather than fabricated zero, and database totals are explicitly estimated when unavailable. Explicit zero remains zero. Existing unit tests cover invalid counters, cumulative snapshot merging, reported/derived misses and inconsistent totals. The 18 usage-cache matrix TODOs are replaced by these real cases; 162 other obligations remain. Input cache-control directives/provider capability policy remain separate acceptance work.

The tests exposed three unknown-cache conversion failures plus synthetic Anthropic start totals. Runtime JSON and terminal SSE outputs now replace legacy-generated usage with normalized actual source usage, and Anthropic message_start uses only source counters known at that point. The frozen Python pure converters/fixtures are unchanged; this is an explicit runtime correction to comply with unknown-vs-zero accounting. Native source reports remain unchanged, including an explicit output zero in an Anthropic start event.


## Single-tool actual roundtrip acceptance — 2026-09-26

Added 18 wire-level roundtrips, one per protocol pair and JSON/SSE mode. The client extracts the actual emitted tool ID/name/JSON arguments (incrementally from stream deltas), computes a fixture result and submits that call/result history through the same gateway. The mock upstream checks the converted historical call and result linkage; both request rows must settle independently with source token totals. This supersedes the earlier test that submitted a preconstructed tool-result history without obtaining the first call.

The 18 tool-roundtrip TODOs are now covered, leaving 144 obligations. This acceptance covers one valid client function call and result across two turns. Parallel/interleaved calls, unsupported tool choices/strict schemas, malformed arguments and server-executed tools remain separate work and are not certified by this result. No live provider or SDK execution is implied.


## Parallel client-tool matrix acceptance — 2026-09-26

Added 18 two-call/two-turn cases across nine protocol pairs and JSON/SSE. Both tools intentionally share the same name but have distinct call IDs, cities and escaped arguments. Stream fixtures alternate one-character parameter fragments (including JSON escape boundaries), while transport splits UTF-8 bytes. The client reconstructs each call by protocol index/ID, sends results in reverse order and verifies the upstream receives both complete call histories and correctly linked reversed results. Each turn settles its own usage.

These cases replace the 18 parallel-tools obligations, leaving 126 matrix TODOs. Acceptance covers valid parallel client function calls; malformed argument behavior, tool-choice/strict-schema capabilities and server tools remain separate. The focused matrix now has 184 passing cases; no runtime implementation change was needed for this slice.


## Settlement failure across the matrix — 2026-09-26

All nine pairs in JSON/SSE are tested with a first-write exception and with a successful query that updates zero rows. A request is settled only after exactly one reserved ledger row is updated. Failure suppresses JSON success or the successful SSE terminal, emits settlement_failed with a safe message/request ID, and prevents subsequent error/finally paths from retrying settlement under a nonbillable failure status. This fixes a transient-write failure path that could previously overwrite a generated successful response as unbilled upstream_error.

Tests use the real API handler and fail only the first update, so an unintended retry would execute real SQL and be detected. They assert one update attempt, retained reservation on the simulated pre-write failures, no upstream lease and no private database error disclosure. In an ambiguous real database commit, persisted state is retained as-is; it is not reset to reserved. Recovery/reconciliation policy remains separate. The 18 settlement-failure TODO obligations are replaced by 36 cases, leaving 108 other obligations.


## Truncated upstream responses — 2026-09-26

Added 18 native/converted JSON/SSE cases with an available backup account. JSON is cut before a complete object; SSE omits its source terminal. The gateway must return 502 for unreadable JSON or a protocol error event without a success terminal after SSE starts, record the request/error and one upstream HTTP-200 attempt, release its lease and make exactly one upstream call despite the backup. Request IDs correlate the client error with the ledger.

The tests exposed missing attempt records for JSON read/parse failures. The bounded-read, JSON-object validation and usage-observation error path now records a safe/redacted attempt error before propagating failure. No raw parser excerpt is persisted. The 18 truncated-stream obligations are now represented by these tests (JSON truncation is the nonstreaming counterpart), leaving 90 other matrix TODOs. Cancellation and slow-consumer acceptance remain separate.


## Real client cancellation matrix — 2026-09-26

Added 18 tests through a listening gateway and real HTTP fetch client for all protocol pairs/modes. JSON upstreams begin a deliberately unfinished body; the client cancels while the gateway awaits completion. SSE upstreams emit initial content without a terminal; the client cancels after receiving a first chunk. Tests await the actual upstream generator closing, require exactly one upstream call, no reserved row or account lease, and a client_error ledger record. HTTP status is null before a JSON response exists and 200 once SSE has started. Cleanup always cancels readers and waits for the client promise.

The 18 cancel obligations are now represented by these tests, leaving 72 matrix TODOs. This proves request-scoped cancellation propagation in the local HTTP fixture; application/process shutdown, cross-host recovery and slow-reader backpressure remain separate acceptance concerns. No runtime change was needed.


## Image wire baseline and uncovered automatic routing — 2026-09-26

Added 18 URL/base64 image cases across nine pairs and JSON/SSE. Each request carries text plus two image sources; assertions inspect both upstream image blocks/URLs/data URLs in order, require the local image endpoint to remain unfetched, and verify image_count=2 without persisting URL/base64 content in request context. This proves ordinary image transport/conversion, not actual model vision support or the full image acceptance obligation. All 18 image TODOs remain open (72 total matrix TODOs).

Source audit: Python gateway_service._body_has_image recognizes message/input image blocks, compatible source objects and data:image strings; _auto_target resolves public coati-auto to route.vision_model for images and route.upstream_model for text, rejecting missing configuration with 503. Node now stores nullable vision_model per account route (migration 0018) and selects it only for coati-auto image requests. The console can configure or clear it. Text uses upstream_model; missing auto routes or missing image targets return 503. Candidate selection filters missing image targets, and lease acquisition rechecks the locked route before creating either a lease or affinity binding. Unlike the single Python public-model configuration, Node keeps both target names on each account route; administrators must configure each eligible account explicitly. This is routing evidence, not a claim that the provider supports vision. The general Node request body limit is MAX_CONTENT_LENGTH (default 16 MiB); image-specific type/size boundary behavior still needs source comparison and tests. Do not introduce mandatory provider vision declarations solely from the original design draft: ordinary Python routing does not enforce them.


## Image migration acceptance — 2026-09-26

Python protocol_bridge._anthropic_image_part and _openai_image_to_anthropic preserve nonempty source data/media strings without decoding or a MIME allowlist. provider_adapters adds no image-specific validation. The migrated contract therefore preserves opaque data, delegates actual image validity/model vision support to the supplier, never fetches image URLs and applies MAX_CONTENT_LENGTH to the encoded request body (default 16 MiB), not decoded image bytes. This supersedes earlier proposed mandatory vision declarations and image-specific validation policies for the migration baseline.

Wire tests now cover all nine pairs and JSON/SSE with ordinary PNG input, coati-auto vision target selection, and opaque non-image MIME/base64 data retained exactly. Six additional endpoint/mode cases use a configured 2048-byte body limit: exactly 2048 bytes is accepted, 2049 returns 413 before a second supplier call, ledger row or lease. Together with automatic routing race/missing-target tests, these discharge the 18 image matrix obligations; 54 TODOs remain (reasoning, unsupported-field, slow-client). These tests certify gateway transport/routing behavior, not real model image interpretation. Empty/malformed content-field conversion remains part of general unsupported-field parity review.


## Reasoning JSON baseline and signature gaps — 2026-09-26

Nine JSON handler/replay cases now derive follow-up assistant history from actual gateway responses, checking thought/answer content, public model alias, supported opaque signature mapping and two successful ledger rows. Python Chat reasoning_content becomes ordinary text when targeting Messages because it has no Messages signature. Messages/Responses JSON responses preserve the signature/encrypted_content mapping; Responses-to-Messages request replay also does. However, Python anthropic_to_responses_body omits signature when encoding a thinking block as a reasoning item, and the Node port currently matches that omission. The fixture explicitly records that limitation rather than claiming full signature round-trip preservation.

Static audit also identifies the stream pipeline's Chat intermediate as unable to retain opaque signatures: Anthropic source handles thinking_delta but not signature_delta, and Responses target has no encrypted_content emission. Streaming content/replay and signature behavior are still unaccepted. All 18 reasoning TODOs remain open; before final acceptance, signature transport limitations need an explicit supported/rejected behavior rather than an unconditional compatibility claim. No opaque value in this fixture is a real credential or provider signature.


## Reasoning SSE wire/replay evidence — 2026-09-26

Nine additional handler cases split the full SSE byte stream at every byte, including multibyte thought/answer/signature text, reconstruct actual response history and replay it through the gateway. Assertions cover exact accumulated thought/answer content, one source-appropriate terminal, two settled requests, native signature preservation and the observed cross-protocol signature loss. Signed native Messages thinking/signature deltas and native Responses output encrypted_content survive; converted Messages currently exposes reasoning as text, and converted Responses has no encrypted_content. This is now runtime evidence rather than only static inspection.

These tests intentionally record the current Python-style conversion behavior, not approval of silent signature loss as the final contract. The 18 reasoning matrix TODOs remain open until the supported opaque-content boundary is explicit and enforced. Provider-issued signatures cannot be claimed portable merely because strings can be mapped between fields. No actual provider signatures or credentials are used in fixtures.


## Messages-to-Responses stream signature correction — 2026-09-26

The runtime bridge now carries Messages thinking blocks directly into Responses reasoning items instead of routing their signatures through Chat deltas. Initial thinking/signature values and fragmented signature_delta values are preserved as encrypted_content on output_item.done and the final response. Each sequential reasoning block has a distinct ID and independent buffers; empty-text signed blocks retain an empty summary and their opaque content. A missing thinking block stop cannot be hidden by a later message terminal. Raw transport bytes remain covered by the existing 16 MiB bridge bound and native source validation; settlement still controls successful terminal delivery.

The nine-pair SSE replay test now requires a Messages-sourced Responses response to preserve its signature and reconstruct it when replayed to Messages. Additional focused cases cover multiple blocks, signature-only content, initial block values, per-item completion consistency and missing block stop. This corrects a Python streaming limitation to match the already-supported JSON response mapping. It proves exact opaque data transport only, not supplier signature interoperability. Requests from Messages into Responses and the reverse streamed Responses-to-Messages mapping remain unresolved, as does the final unsupported-field policy; all reasoning TODOs remain open.


## Messages request signature correction — 2026-09-26

Messages thinking.signature now maps to the corresponding Responses reasoning.encrypted_content when encoding request history. This aligns the request direction with existing JSON response mapping and the corrected stream output, rather than reproducing Python's omission. Each thinking item retains its own signature, including empty-text items; unsigned items receive no fabricated opaque value. A direct request round trip back to Messages preserves signed blocks and retains the legacy unsigned-to-text rule without mutating the input.

Updated actual JSON replay matrix assertions and added multi-block/empty/unsigned/input-immutability coverage. The unchanged Python fixture file and source hash guards continue passing because its request cases did not contain signatures; the new test records this previously uncovered intentional correction. Reverse Responses-to-Messages streaming still loses opaque content and remains open, so no reasoning TODO is discharged by this request fix. Opaque field preservation is not supplier signature authentication or portability.


## Responses-to-Messages stream signature correction — 2026-09-26

Responses reasoning is now emitted at output_item.done, where summary and opaque encrypted_content are available together. The bridge emits a closed thinking block with signature for signed items and a plain text block for unsigned summaries, consistent with JSON conversion. If no item completion was emitted, final response.output can supply the completed reasoning item. Already emitted items are tracked by identity so the terminal response does not duplicate their content. An unfinished reasoning item absent from both item completion and final output causes truncated_stream rather than silent success.

Nine-pair wire replay now requires supported signatures to survive both Messages/Responses stream directions and return to the original supplier representation. Additional tests cover multiple items, signature-only items, unsigned summaries, item-plus-terminal duplication, terminal-only reasoning completion and unresolved source items; unknown initial usage remains unknown. This is opaque transport evidence, not cross-supplier cryptographic interoperability. Mixed output ordering when reasoning completion is delayed behind later content, overlapping block/index validation, and a complete unsupported-capability policy still require review before the reasoning obligation is closed. Existing byte/event/terminal bounds and settlement-before-success gates remain in force.


## Reasoning completion consistency — 2026-09-26

Responses-to-Messages conversion now records the text/signature pair emitted for each completed reasoning identity. Repeated completion with identical data stays idempotent; changed text, removed/changed signature or conflicting identity for an announced output index raises a safe invalid_response internally. The public SSE handler retains its established stream_error envelope, does not emit message_stop, records stream_error, and releases the lease. Neither the conflicting opaque value nor conflicting text is returned as a diagnostic.

Output-index aliases resolve reasoning events that omit item_id after an item has been announced. Tests cover text/signature/identity conflicts, index-only addressing and a full API failure path with one supplier call and no leaked lease. Mixed-content ordering with delayed completion and interleaved Messages thinking blocks still require acceptance; reasoning TODOs remain open.


## Delayed reasoning completion ordering — 2026-09-26

Responses-to-Messages streaming now holds later content behind an announced reasoning item until its completion carries the summary/signature. It emits that completed item before releasing queued text/tool events. A final response may supply the missing item completion; unresolved items still fail at EOF. Identical duplicate completions remain idempotent and conflicting ones still fail through the existing consistency checks.

The ordering layer counts original upstream frame bytes before buffering against the 16 MiB bridge limit. Synthesized item completions are not counted again as supplier bytes. Consumed queued frames are released; native event limits, cancellation and settlement-before-terminal remain in effect. This may delay subsequent content while waiting for an opaque signature, which is necessary to retain the signed block and source order.

Tests cover late item completion and terminal-only completion, actual HTTP-handler ledger success in both cases, thought/text/tool ordering with unchanged tool ID/arguments, and bounded waiting when a reasoning item never completes. Interleaved Messages thinking blocks and the final unsupported-capability policy remain open before full reasoning acceptance.


## Interleaved Messages reasoning — 2026-09-26

Messages-to-Responses conversion now serializes each thinking block by its source index while allowing that block's own deltas to stream immediately. Frames from other blocks wait until the active thinking block stops; queued thinking blocks then release their own text/signature fragments independently. This prevents adjacent or interleaved signed blocks from sharing the target adapter's buffers, including when a later block stops first and text is already queued.

Original upstream frame bytes are bounded before buffering by the same 16 MiB limit. Thinking indexes must be nonnegative integers; repeated thinking starts, signatures for unknown thinking indexes and signature fragments arriving after a source stop produce a safe invalid_response internally. Missing stops still cause truncated_stream. Tests cover separate block content/signatures, source order, malformed lifecycle rejection, and real handler success/error settlement with lease cleanup. Native same-protocol streams and ordinary Chat conversions are unchanged. The final unsupported-capability policy and unrepresented opaque provider blocks still need review before reasoning acceptance is closed.


## Redacted thinking capability boundary — 2026-09-26

Messages redacted_thinking is preserved on native Messages routes. The runtime cross-protocol bridge now rejects it explicitly because neither Chat nor Responses has an implemented equivalent for this opaque block. Request preflight excludes incompatible candidates; if none remain, the gateway returns 400 unsupported_feature with a zero-charge protocol_error ledger and no supplier call. JSON supplier responses containing it fail with 502 protocol_error. SSE fails through the existing stream_error envelope without a success terminal and releases the lease.

The check inspects actual message/response content and stream content-block starts (including initial message content), not arbitrary tool input/schema data. Safe diagnostics identify the unsupported block and recommend a native Messages route; opaque data is not copied into errors. Twelve native/cross-protocol JSON/SSE request/response cases and a tool-payload false-positive check cover this boundary. This is an intentional correction to legacy silent loss. Chat signature representation and other unsupported fields remain a separate open acceptance issue; no full reasoning-compatibility claim is made.


## Explicit Chat reasoning policy — 2026-09-26

Runtime request, JSON response and SSE conversion now default to preserving opaque reasoning. When Chat is the target and the source carries a Messages signature or Responses encrypted_content, conversion fails explicitly rather than silently dropping it. Clients may select X-Coati-Reasoning-Policy: text-only to retain available reasoning text while accepting opaque signature loss. This option does not bypass redacted_thinking restrictions. Native protocol paths retain original fields; Messages/Responses signature mappings remain transport mappings, not promises of cross-supplier validation.

The header accepts preserve or text-only, defaults to preserve, is not forwarded to the supplier, and is recorded as request_context.reasoning_policy. That field records selection, not an inferred loss counter. Default request refusal uses candidate preflight, 400 unsupported_feature and no supplier call; incompatible supplier JSON uses 502 protocol_error, while incompatible SSE uses stream_error and withholds successful terminals. The new tests also exposed standalone Responses reasoning being dropped before a user message; conversion now emits a separate assistant reasoning message in that case, while all original Python golden cases remain unchanged and pass.

Acceptance evidence combines all nine JSON/SSE reasoning/replay pairs, explicit text-only Chat paths, default strict request/response rejection, selection tracing, unknown policy rejection, redacted boundaries, fragmented signatures, multiple/empty/interleaved blocks, delayed content order, completion conflicts, byte bounds and lease/settlement assertions. The 18 reasoning placeholders are replaced by these tests; remaining matrix categories are unsupported-field and slow-client (36 TODOs). This does not close general protocol coverage, real SDK/provider validation or the overall migration goal.


## Stop and structured-output request fields — 2026-09-26

The runtime bridge now refuses explicit non-null Chat stop / Messages stop_sequences when targeting Responses, since the current converter has no corresponding mapping. Chat ↔ Messages mappings and native paths retain the supplied stop arrays. Rejection occurs during candidate preflight and is recorded as zero-charge protocol_error without supplier traffic when no compatible candidate remains.

Responses text.format now maps back to Chat response_format for json_object, text and json_schema. JSON schema name, description, schema and an explicitly false strict value are preserved without inventing defaults. Unknown format types are refused by that converter. Responses structured output targeting Messages is refused explicitly, matching the existing Chat-to-Messages boundary. Native routes keep their input format fields. This describes gateway request transport, not proof that a supplier obeys or supports a given schema.

Added 12 stop cases and 24 json_object/json_schema cases spanning JSON/SSE and relevant native/converted routes. Original Python golden cases still pass; these are corrections to previously untested silent field loss. Other unsupported fields and slow-client obligations remain open (36 matrix TODOs).


## Parallel tool-call controls — 2026-09-26

Explicit parallel_tool_calls now maps to the inverse of Messages tool_choice.disable_parallel_tool_use, and back, in runtime cross-protocol request conversion. Existing named tool selection is retained; when a parallel flag needs a Messages choice and none was provided, auto is used. A none choice stays none without an unsupported parallel subfield. Tool-less conversion does not invent tool_choice, and non-boolean explicit control values are refused rather than coerced. Native paths remain passthrough.

The mapping follows [Claude parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use) and [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling): disabling parallel calls constrains count, while named/required selection remains a separate constraint. Provider/model support is still the supplier's responsibility. Added 72 actual-handler cases across nine pairs, JSON/SSE, both boolean values and default/named choices, plus tool-less/none/invalid-value boundaries. This fixes legacy field loss without claiming all tool options are covered; unsupported-field and slow-client TODOs remain open.

## Explicit tool strict mode

Runtime cross-protocol conversion retains boolean tool `strict` values, including explicit false. Chat carries the field in `tools[].function.strict`; Responses and Messages carry it on the tool declaration. The legacy Responses `additional_tools` input is covered too. Missing controls stay absent; JSON Schema properties named `strict` are ordinary schema data. Invalid non-boolean controls and declarations without a unique converted tool match fail preflight rather than silently dropping the setting. Native routes retain their existing passthrough behavior.

This guarantees request-field transport, not upstream schema enforcement. Omitted defaults and supported schema subsets can differ by supplier. See [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) and [Claude Messages custom tool API](https://platform.claude.com/docs/en/api/typescript/messages). Other unsupported-field boundaries remain open.

## Content endings versus settlement completion

The settlement buffer treats allowlisted Responses content-block completion events separately from response-level completion. Content endings may flow before accounting commits; `response.completed`/`response.incomplete`, unknown events, and anything following a held event remain buffered in order until settlement succeeds. The allowlist covers text, content parts, output items, function arguments, reasoning-summary text/parts and refusals. Chat/Messages retain their prior settlement gating.

Each ending frame remains bounded to 1 MiB, and the aggregate held completion remains bounded to 1 MiB. Repeated full text in different content endings no longer consumes the aggregate completion allowance. This corrects the observed 512 KiB Chat/Messages -> Responses failure without raising either bound. A single oversized content/completion event still fails explicitly without response completion. The 16 MiB cross-protocol source bound remains unchanged; arbitrary-length legacy stream parity is not established.

## Timeout while a consumer is paused

Once streaming starts, idle/deadline abort and client cancellation settle and release admission even if the consumer never asks for the next event. Abort, normal completion and generator cleanup share one settlement promise. Client cancellation records client_error; idle/deadline interruption records stream_error. On resume, an aborted iterator cannot consume additional usage or publish success. This protects reservations/leases independently of downstream demand; it does not claim that the downstream TCP connection itself is forcibly closed at the deadline.

## Downstream write deadline

All JSON/SSE model POST routes install an HTTP response deadline after authentication: service timeout plus 1000ms grace. An unfinished response is destroyed at that deadline, so a client that stops reading cannot retain a response indefinitely. The existing response close hook aborts gateway work; previously settled timeout status is retained through the single settlement promise. Finish/close cancels the watchdog. Ordinary consumers can receive the usual error frame during the grace period, but stalled clients may only observe a transport close with partial content and no completion marker.


## 非便携控制参数与 Responses 状态边界 — 2026-09-26

Chat `logit_bias` 和 Messages `container` 在原生路径保留；非 null 值进入跨协议转换时返回 400 `unsupported_feature`，不静默删除参数。错误只包含字段名，不回显会话或容器标识。Responses 的非空 previous_response_id、非 null conversation、background:true、store:true 遵循现有无状态策略，在原生和转换路径都拒绝。实际发往 Responses 的请求强制 store:false；调用方必须传完整历史。n 仍由入口 schema 限定为 1，不宣称多候选响应支持。

新增 54 项隔离数据库、本地模拟上游的矩阵测试：36 项控制参数原生透传或拒绝、18 项 null/false 默认值可用。拒绝路径验证零上游调用、零尝试、零预留与计费用量、无遗留账号租约；原生接受只证明线上请求体转发到模拟上游，不代表真实供应商支持。unsupported-field 和 slow-client 共 36 项 TODO 保留，尚未以这些局部用例替代完整能力目录和可靠性验收。

## 第一轮协议收尾：慢客户端与参数丢失（2026-09-26）

原 36 个 TODO 是两类场景 × 九个协议方向 × JSON/SSE，并非 36 个缺失功能。

慢客户端 18 个占位已由现有证据收敛：九方向 SSE 的实际 HTTP 暂停/恢复、背压、取消和响应截止时间；JSON 使用共享响应截止时间的暂停 socket 检查，生产入口三种协议均安装该截止时间且非流式上游正文限制为 8 MiB。JSON 不是逐块转换流，不能把 SSE 的增量背压结论套给 JSON。针对性运行 68 项通过，没有增加慢客户端测试。

本轮修复桥接入口的静默字段丢失：Chat 的 seed、frequency_penalty、presence_penalty、logprobs、top_logprobs、prediction、audio、modalities 和 Messages 的 top_k，在当前无法保留语义的跨协议路径明确拒绝。同协议保持原值（包括 0/false）；拒绝在上游调用和配额预留前发生，保留零用量错误记录，不输出字段内容。原有 stop、结构化输出、并行工具、strict、状态型 Responses 控制仍按原契约处理。

验证：已有矩阵的相关控制检查 192 项通过；补一个同步回归逐字段验证，避免复合输入中一个拒绝字段掩盖其他字段的丢失。没有运行真实供应商或负载测试。

unsupported-field 的 18 个占位仍保留。上述修复不是任意扩展字段或嵌套字段完整性保证；下一轮需继续核对 thinking/reasoning 配置、内容块、工具定义和未知扩展字段的映射/拒绝边界，不能仅为清空 TODO 就把它们算作通过。

## 第二轮：嵌套请求控制（2026-09-26）

在运行时 bridgeRequest 入口补充 request-controls 校验，原生路径仍先返回原文，JSON Schema 属性与工具输入不递归扫描：

- Chat reasoning_effort ↔ Responses reasoning.effort 显式映射；不把 Messages thinking 预算/adaptive 配置默认为 medium，不支持的 thinking/output_config、reasoning.summary 和 text.verbosity 明确拒绝。
- Chat/Responses 图片 detail 保留；转 Messages 的非 auto detail 明确拒绝。
- 无法保留的文档/文件/音视频内容、缓存控制、工具结果图片和工具扩展控制（cache_control/defer_loading/allowed_callers/input_examples）明确拒绝，错误仅包含字段路径。
- Messages is_error 工具结果转换成带 is_error:true 的结构化文本，避免搜索失败被模型当作正常结果；不会因网关自己的失败工具结果打断已有 max-use/round-limit 处理。

验证复用了 Python fixture、签名推理及服务端搜索工具流程，并增加少量同步字段回归。最初的 is_error 拒绝方案导致两个既有服务端工具检查失败，已改为保留错误标记后修复通过。

18 个 unsupported-field 占位仍未关闭：本轮覆盖的是上述明确请求字段，不是未知扩展字段、所有嵌套类型或响应字段的完整性声明。现有纯 Python 转换函数仍保留原始对照语义；运行时入口的更严格策略以本节为准。

## 第三轮：未知扩展与响应内容保护（2026-09-26）

跨协议请求遇到未知的非 null 顶层扩展、未知内容块类型时明确拒绝；同协议继续透传。错误不回显扩展值，JSON Schema 和工具输入仍不作递归限制。

JSON 与 SSE 的转换入口均检查响应语义内容：未知内容/工具块、无法转换的非空引用、Chat 音频等扩展以及未知 Responses 事件不再静默丢弃。包络和用量元数据不在此保护范围；任意嵌套扩展字段的完整性仍不作保证。Responses reasoning_text 内容片段是合法推理事件，真实 DeepSeek 验证发现初版遗漏后已加入，并由现有推理转换策略处理。

定向验证：已有矩阵、搜索工具、协议用例 737 项通过；新增内容检查后协议/流式/工具定向 41 项通过；账号选择/配额/设备/会话 10 项通过。reasoning_text 修复后协议用例 19 项通过；API 类型检查通过。以上数字是多次定向运行结果，存在重叠，不相加充当独立用例数量。仍保留 18 个广义 unsupported-field 占位。

真实验收使用 apps/api/scripts/live-acceptance.ts，临时路由绑定既有账号、临时令牌、2 并发、20 秒批次、30 分钟持续窗口；逐次对照线上用量和数据库，失败阈值触发停止，结束撤销令牌并删除临时路由。真实运行报告另见 live-acceptance.md；长期稳定性与生产容量是不同结论。

## 当前字段兼容策略（2026-09-26，第五批；覆盖早期默认拒绝描述）

默认 `x-coati-compatibility-policy: python`（省略亦同）：跨协议按已有转换器生成字段，未知扩展可能被忽略，Messages thinking 到 Responses 仅作 medium 近似。`strict` 显式开启上文请求控制及响应内容保护；不可保留字段在请求侧拒绝，响应侧返回协议错误。原生同协议透传。策略写入请求上下文，也用于服务端工具内部转换。

该选择不关闭独立的 opaque 签名保护、工具 strict/并行设置校验或状态型 Responses 拒绝。`x-coati-reasoning-policy: text-only` 仍是独立有损推理选项。`python` 不保证所有嵌套字段、供应商扩展或旧端点行为一致。18 项广义 unsupported-field 占位保留。

## 第六批扩展字段验收（2026-09-26）

本节更新前面各历史阶段的 TODO 计数和 store 边界。当前没有剩余的矩阵 TODO 占位；这表示已声明场景均有具体用例，并不是供应商协议全集已验证。

18项九组合×JSON/SSE明确检查：未知请求 vendor_extension 原生保留、默认跨协议丢弃、strict跨协议400且没有上游请求；未知响应annotations/citations/未来事件原生保留，默认跨协议按现有转换降级，strict跨协议JSON502或已开始SSE的stream_error。检查私有标记不回显、结算状态及租约清理。既有嵌套控制、工具、图片、推理、慢客户端用例仍独立保留。第六批网关门禁这些矩阵全部通过，没有新增真实供应商负载。

默认python策略收到store:true时，按Python provider adapter强制store:false，而不是入口400；strict继续拒绝。非空previous_response_id继续拒绝；background/conversation默认按Python在原生路径透传，strict可选拒绝。此处更新前文早期预览的统一拒绝策略，不代表实现网关状态存储或查询。签名/opaque保护仍独立于python字段降级策略，见P05。

Messages搜索历史在没有新工具声明时也会恢复coati1正文；原生Messages流式请求先完成内部工具循环再输出最终SSE。详见batch-6-acceptance.md和server-tools.md。
