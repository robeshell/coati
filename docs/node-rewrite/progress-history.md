# 历史执行记录（非当前待办）

以下保留各批次的实现顺序与当时限制，当前状态以 [roadmap.md](roadmap.md) 为准。

# Coati Node 重写：剩余目标与交付计划

更新时间：2026-09-25。代码核对基线：`fa1c840`。本文是后续交付计划，不代表所列能力已实现。

## 已确认的方向

- 产品：可自行部署的企业级模型网关与管理控制台，项目名称 Coati，Apache-2.0。
- 技术基础：castor-kit；Node.js / TypeScript / Fastify / Drizzle / PostgreSQL，React / shadcn/ui。
- 不开源、不纳入本次重写：desktop、CLI、Agent 插件、本地运行环境安装器、公司专属服务。允许最小 SDK / 设备授权演示。
- 不采用 LiteLLM 或 pi-ai。协议兼容核心由 Coati 自行实现，以保留的 Python 实现与测试作为迁移基线。
- 网关是协议矩阵：入站协议与上游协议独立选择，响应必须返回入站协议。路由到任何受支持组合，不意味着目标模型具备所有源协议能力。
- Python 稳定版与 Node 预览使用独立数据库。完成验收前不替换稳定版本，不直接升级 Python 数据库。
- 先完整迁移到可验收的 Node 最终版，再做 Node 专项优化。迁移期以 Python 开源网关现有功能与可观察行为为基线，不以架构简化或性能为由删减能力。
- 不预设 Node 比 Python 更快；性能结论来自相同条件下的测量。性能测量与可靠性检查可以贯穿迁移，专项调优放在完整迁移验收之后。

## 已有基础与证据边界

已有登录/RBAC、模型服务、模型路由、访问密钥、设备授权接口、请求及尝试日志；三种协议的同协议 JSON/SSE 转发；按密钥的原子预算预留、RPM/并发控制；有限的流前故障转移；容器初始化与独立数据库迁移。

这些是开发预览能力。现有自动化主要使用真实隔离数据库与模拟上游；尚未完成真实供应商、完整客户端、跨副本、持续负载和迁移切换验收。既有详细记录见 [validation.md](validation.md)，旧版接口清单见 [contracts.md](contracts.md)。TagsView 关闭问题已在基线提交修复。

## P0 — 固化产品范围、契约与验收清单

- [ ] 逐项核对 Python 功能与 API，标记对应实现、兼容别名和验收用例；仅排除已确认的私有客户端范围，不自行退役网关能力。
- [ ] 定义统一请求、响应、流式事件、错误、用量契约；保留协议专属扩展，避免只取三种协议最小交集。
- [ ] 将客户端入站协议、上游协议、公开模型、上游模型、模型能力分离建模。
- [ ] 明确统一错误码、请求 ID、参数校验和不支持能力的处理规则；默认明确拒绝，降级需显式配置且可追踪。
- [ ] 固化矩阵测试用例、典型多轮会话与旧版回归样例，约定发布门槛。

验收：开源范围内的每个 Python 能力都有对应 Node 实现计划与回归用例；内部结构可适配 Node，但接口与业务行为优先保持兼容。

## P1 — 完整双向协议矩阵（核心优先级）

| 入站 / 上游 | Chat Completions | Responses | Messages |
| --- | --- | --- | --- |
| Chat Completions | 原生路径完善 | 转换 | 转换 |
| Responses | 转换 | 原生路径完善 | 转换 |
| Messages | 转换 | 转换 | 原生路径完善 |

- [ ] 架构：入站解码 → 统一请求 → 路由与能力检查 → 上游编码；上游响应 → 统一事件 → 入站响应编码。同协议允许原生保真路径。
- [ ] 对照 Python 协议桥逐项实现文本、图片、工具、推理、流式事件、取消、错误与用量；复用 Coati 受控传输，验证自定义模型、URL、请求级凭证和网络安全策略。
- [ ] 协议适配器统一服从 Coati 的重试、配额与凭证生命周期；避免隐式重试产生重复请求与计费。
- [ ] 打通九个组合的普通与流式响应，先文本，再多轮工具与复杂内容；工具执行仍由客户端负责，服务端工具是独立后续能力。
- [ ] 处理工具 ID、并行调用、参数增量、工具结果、多内容块、停止原因和公开模型名映射。
- [ ] 定义推理内容/签名、图片与多模态、缓存控制/缓存用量、结构化输出、系统提示等差异；不能映射时不静默丢弃。
- [ ] 保留普通输入、输出、缓存读取、缓存写入及上游提供的缓存期限/推理明细；区分原始用量与统一口径、字段缺失与真实零值，避免子项重复计费。
- [ ] Responses 的状态续接、存储、后台任务及其他特殊能力逐项定案：实现、仅指定原生路径支持或明确拒绝；不宣称全量兼容。
- [ ] 覆盖任意分片/UTF-8、背压、断流、客户端取消、超时、流中错误和结算失败，不伪造正常结束事件。
- [ ] 补齐模型目录与能力信息、Messages count_tokens、旧路径别名及不支持接口的稳定错误行为。

验收：3×3×普通/流式基础用例通过；工具多轮、取消、错误、用量有独立断言；能力差异表与实现一致。模拟上游通过后再进入授权的真实客户端/供应商验收。

## P2 — 企业级上游与调度

- [ ] 梳理供应商、账号/凭证池、模型能力配置、公开模型与候选路由的关系，完成数据模型及管理界面。
- [ ] 支持同一公开模型跨供应商/协议路由、账号选择、优先级/权重、账号并发与限额。
- [ ] 区分鉴权失败、限流、容量不足、网络故障、模型不支持；实现冷却、恢复探测与健康状态。
- [ ] 明确故障转移和重试边界，流已开始后不自动切换；限制尝试次数并记录每次选择原因。
- [ ] 会话亲和与缓存亲和；亲和不能越过权限、账号停用或预算约束。
- [ ] 个人渠道的所有权、可见性、凭证隔离与路由范围；补齐模型配置和缓存验证能力。

验收：账号停用、限流、故障、恢复及并发竞争行为可复现；诊断能解释为什么选中、跳过或切换某个账号。

## P3 — 用户治理、预算与凭证生命周期

- [ ] 在现有每密钥限制之上增加用户共享预算，防止通过多个密钥绕过限制；账号限制与用户限制分开核算。
- [ ] 明确预算周期、时区、输入/输出/缓存用量口径；金额预算如纳入发布范围，必须有版本化价格和估算标识。
- [ ] 覆盖预留、结算、释放、崩溃恢复与幂等；实际用量和估算用量可区分，异常预留可追查。
- [ ] 密钥创建、更新、轮换、吊销、过期、模型授权及旧 PAT API 兼容策略；设备授权权限不能默认超出用户权限。
- [ ] 定义权限撤销对新请求与在途请求的行为，并验证跨副本一致性。
- [ ] 完善上游凭证加密密钥轮换、重加密、备份恢复和脱敏；凭证按请求隔离。
- [ ] 将设备授权防滥用限制从进程内扩展到多副本一致控制。

验收：多密钥、多副本并发不能绕过共享额度；重复结算不重复扣量；撤销与轮换行为有测试和操作说明。

## P4 — 控制台与接入闭环

- [ ] 按完整业务流程完善页面：配置上游 → 发布模型/路由 → 授权 → 调用 → 排障；展示模型能力和协议转换限制。
- [ ] 运维视图覆盖路由命中、账号健康、冷却、请求尝试、首响应/总耗时、Token 与缓存用量、错误分类和估算来源。
- [ ] 区分个人与管理员的日志、预算、渠道视图，验证 RBAC 和数据范围隔离。
- [ ] 补齐设备授权开始、登录返回、确认/拒绝、轮询、单次兑换、过期和撤销；明确授权对象、权限、期限。
- [ ] 提供最小可运行设备授权示例、标准 SDK 接入示例及协议矩阵说明，不发布私有 CLI。
- [ ] 补齐适用的 `/me`、PAT 管理兼容接口；验证 OpenAI/Anthropic SDK 及选定实际客户端。
- [ ] 检查空态、错误恢复、长列表、窄屏和关键操作反馈；补齐请求关联标识与脱敏诊断。

验收：新用户能通过文档完成首个请求；管理员能定位一次路由失败；普通用户不能读取其他用户的凭证或请求记录。

## P5 — 服务端工具与旧版能力收口

- [ ] 重建网页搜索、网页抓取以及跨协议工具表达，明确客户端工具和网关执行工具的边界。
- [ ] 工具调用继承权限、网络访问限制、超时、取消、资源上限和审计，不绕过网关治理。
- [ ] 核对工具结果、工具错误、流式顺序及用量归属，验证各支持协议的多轮行为。
- [ ] 逐条关闭旧版契约清单：模型配置、个人渠道、缓存测试及管理接口等，记录对应实现与验收结果；不能以退役替代完整迁移。

验收：旧版保留能力无未归属项；工具成功、失败、取消和受限网络访问均有回归证据。

## P6 — 数据迁移与部署整理

- [ ] 只读导出旧数据；新库导入提供 dry-run、数量校验、源 ID 映射、幂等重跑和失败报告。
- [ ] 覆盖用户、角色权限、模型/账号/渠道、凭证、配额及需保留的历史用量；避免将私有客户端内容带入开源数据模型。
- [ ] 明确密码与旧访问令牌能否安全兼容；不能迁移的凭证提供重新签发流程，不承诺旧令牌直接可用。
- [ ] 上游凭证解密/重加密通过受控过程完成，日志和导出不泄漏明文；迁移后核对权限与用量归属。
- [ ] 制定历史日志保留、分页索引、清理策略，移除基础模板遗留的无用示例表和残留配置。
- [ ] 完善全新安装、版本升级、备份恢复、密钥管理、健康检查、优雅停机及 SSE 反向代理配置。
- [ ] 演练迁移后的新增数据如何处理及回滚窗口，不能仅恢复代理路由而忽略数据变化。

验收：脱敏样本迁移可重复，数量/关联/权限对账通过；新库安装、已有 Node 库升级、备份恢复与回滚均经过演练。

## P7 — 完整迁移的兼容性、可靠性与基线验收

- [ ] Python/Node 使用相同硬件配额、数据库、上游行为、客户端负载和功能开关；负载发生器独立运行。
- [ ] 分别测试原生/转换、普通/流式、短/长上下文、工具、多用户/密钥和不同并发。
- [ ] 测量首事件与总耗时 p50/p95/p99、吞吐、错误率、CPU、RSS、数据库连接和队列等待，记录适配层额外成本。
- [ ] 持续负载、慢客户端、背压、超长流与取消风暴；验证内存和连接有界、停止请求后资源回收。
- [ ] 多副本预算竞争、进程终止、数据库中断、上游故障、部署重启和在途请求恢复。
- [ ] 在显式授权的凭证、账号和费用范围内开展真实供应商/客户端验收；测试默认仍使用隔离库和模拟上游。
- [ ] 根据基线确定并冻结目标负载及延迟/资源阈值，再进行发布验收，不用短时跑分代替容量承诺。

验收：输出可复现报告与已知限制；关键正确性门禁全部通过，达到约定负载指标，性能结论注明条件。

## P8 — 开源发布与切换

- [ ] 更新 README、架构、API/矩阵说明、部署升级文档、示例、故障排查、变更日志及许可证/依赖声明。
- [ ] 检查公司标识、私有模块、内部地址和秘密信息未进入发布内容；检查最终产物和公开差异。
- [ ] CI 覆盖类型、测试、构建、全新/升级迁移、协议矩阵与容器基本流程；完整执行发布所需检查。
- [ ] 明确 Python 稳定版到 Node 版的版本/兼容策略；保留可取得的 Python 回滚版本，验收后决定主线中旧目录的处理。
- [ ] 更新当前草稿 PR 的最终范围与验证记录；仅在发布门槛满足后进入合并、版本和镜像发布流程。
- [ ] 先隔离客户端，再小范围切换并观察错误/用量/延迟，最后扩大；不复制真实计费请求做影子流量。

验收：发布包可按文档全新部署；选定用户完成接入；迁移对账与回滚演练通过；剩余限制公开可见。

## P9 — 完整迁移验收后的 Node 专项优化

仅在 P0–P8 完成、开源范围内旧能力逐项验收后启动。基于 P7 数据定位瓶颈，再考虑事件循环/CPU、连接池、数据库查询、缓冲与背压、内存和前端体积优化；每项优化必须复跑同一兼容性与用量回归集，提供同条件前后对比。不预先增加缓存、中间件、进程拆分或改写业务语义。

## 执行依赖与完成定义

主顺序：P0 → P1 → P2/P3 → P4/P5 → P6 → P7 → P8（完整迁移最终版）→ P9（Node 专项优化）。P4 随后端能力逐步完善，测试、迁移设计与文档贯穿各阶段，不能等到最后补做。

每阶段交付实现、契约/文档、适当自动化及必要的实际验证；新增迁移必须在隔离数据库真实执行并核对对象。明确区分模拟测试、浏览器验证、真实上游、部署和生产验收证据。上一阶段完成不自动代表允许切换生产。

近期交付从 P0 与 P1 的旧能力清单、统一协议类型、能力差异表、矩阵测试骨架推进到自研适配器。先将 Python 行为整理为独立 wire fixtures，再完成双向矩阵实现。

## 第一批进展 — 2026-09-25

已交付旧版 69 个方法/路径清单、协议契约与能力策略、独立 TypeScript 类型、事件生命周期检查、216 个显式待实现矩阵测试项。链接见本目录 README。P0/P1 尚未整体完成：wire fixtures、实际入站/返回编码与完整互转测试仍待实现。用户已决定不采用 pi-ai，隔离实验及其依赖已移除；后续按自研方案推进。

最终版的完成条件：开源范围内 Python 功能逐项闭环，九组合协议及工具/缓存用量回归通过，管理台和授权流程可用，数据迁移对账、部署升级、恢复与回滚验收完成；不能用预览页面可运行、少量单测或仅文本互转代替。迁移中必须修复的正确性、安全性与资源泄漏问题不延后到优化期。

## 目标执行进展 — 2026-09-25

迁移目标已启动。已运行原版协议桥 43 项测试并固化 70 条 JSON 转换样例；完成 Anthropic → Chat 的请求与普通响应转换，12 条 Python 对照样例通过。其余 58 条转换样例及 216 项矩阵验收义务仍待实现。当前尚未改变正式路由；下一步补齐其他方向及流式转换，再接入路由、结算与实际 HTTP 验证。

## 普通协议转换进展 — 2026-09-25

六个跨协议方向的请求/JSON 响应转换与九组合分派已实现。88 条 Python 对照样例全部通过，另有原始源码/测试哈希校验；输入不被修改。14 组流式方法轨迹已导出，尚未实现对应 Node 流式转换。当前剩余：流式实现、运行路由/受控传输接入、缓存明细完整记账、实际 HTTP/SDK 矩阵验收；216 项矩阵 TODO 仍保留。Python 某些转换路径缺失缓存子项的历史行为已记录在 validation.md，最终版需补齐，不能据此减少缓存统计范围。

## 流式与运行路由进展 — 2026-09-25

四个基础流式转换器通过 14 组 Python 方法轨迹；通过 Chat 事件衔接实现六个跨协议方向，已接入实际网关 service。JSON/SSE 路由按上游协议选择地址、请求头和用量解析，再转回入站协议。旧 Anthropic 路径别名已接入。完成基础九组合、工具参数/结果、长度上限、上游错误、跨协议截断、真实客户端取消、结算失败及候选能力筛选的集成测试。

此阶段不代表 P1 完成：缓存明细当前在请求内保留并参与总量计算，仍需持久化分项、诊断界面和完整 wire 用量映射；图片、推理、并行工具、慢客户端、所有 SDK 与剩余特性仍需验收。矩阵文本/上游错误的 36 项已替换为实际测试，剩余 180 项 TODO 不隐藏。

### 用量明细进度（2026-09-25）

已落实缓存读取/写入、5m/1h 写入、推理 Token、上游协议与原始用量的可空持久化字段，并实际迁移隔离开发库至 0004。统一口径区分未报告与零值，避免缓存/推理重复累计；九组合普通/流式返回与数据库结算中的缓存读写明细通过断言。此进度更新替代上一段中“仍需持久化分项与 wire 映射”的描述；诊断界面和更丰富的协议边界场景仍待完成。完整验证证据见 validation.md，P1 与最终版目标保持未完成。

### 控制台用量核对（2026-09-25）

请求详情已展示统一输入/输出、缓存读写和期限、推理子项、原始用量、入站/上游协议及估算标记。完成本地模拟记录的浏览器抽屉/展开核验与 46 项前端测试。账号池、配额、工具、多协议边界、数据迁移和部署验收仍按原计划推进；此处不将本地 UI 验证扩大为完整迁移验收。

### 调度行为核对（2026-09-25）

已补齐 Python 的 HTTP 重试分类（鉴权/欠费、408、429、5xx），在成功响应内容输出前选择下一候选，保留三次尝试上限和单次结算。新增普通 400/404/422 不切换、流截断不切换与上限回归。冷却持久化、探测、权重/亲和、账号并发和个人渠道仍未完成；差异与实施边界见 scheduling-parity.md。

### 账号健康持久化（2026-09-25）

0005 已增加共享健康/失败次数/冷却截止/观测时间/脱敏错误字段；HTTP 鉴权与欠费立即冷却 30 分钟，普通硬失败三次冷却 60 秒，429/切换软失败不触发硬冷却。成功 JSON/SSE 可清理健康状态；过时结果不能覆盖新观测，并发硬失败原子累计。新候选查询排除冷却中的账号，过期后放行。健康 UI、全冷却诊断、在途候选再校验、恢复探测租约、网络/流失败健康分类及完整账号池仍待补齐。

### 发送前状态核对（2026-09-25）

额度预留后、发送前重新读取候选账号与路由，跳过已停用/冷却对象，并采用最新凭证和协议；全部账号冷却返回 503 upstream_unavailable，不再误报 404。此读取仍是快照，账号原子租约与状态变更后的在途请求策略尚待实现。切换测试改用独立账号，避免同账号重复路由掩盖冷却行为。

### 账号并发租约（2026-09-25）

0006 增加账号并发上限与数据库租约。短事务同时校验路由、账号启停/冷却/容量并取得名额；请求结束、失败或切换释放，过期租约在下次取得名额时回收。满载候选不占三次实际尝试额度。未发送上游请求的拒绝不计估算 Token。并发管理 UI、进程崩溃实测、账号 RPM/预算及亲和仍待实现。

### 账号配置界面（2026-09-25）

模型服务页已显示账号健康、并发上限、冷却截止与可展开的最近错误；新增/编辑可设置并发上限。冷却过期显示待恢复验证，不冒充健康。修复 saveUpstream 未传递并发上限的遗漏并增加落库回归；刷新获取最新健康状态。探活、账号预算和亲和仍待完成。

### 权重排序（2026-09-25）

0007 增加账号权重，管理表单与保存接口已接入；无会话请求在同优先级中按权重选择。排序模块具备 Python SHA256 一致性评分并有对照，但尚未把该评分当作完整会话亲和上线：持久绑定、TTL、并发首写、失败重绑与初次负载平衡仍需补齐。

### 会话持久绑定（2026-09-25）

0008 接入显式会话标识、用户/模型隔离的 HMAC 绑定、一小时 TTL 与半周期续期。事务内绑定与账号租约一起取得，保证首次写入者优先；后续请求复用绑定，可重试 HTTP 失败按旧账号条件失效并重绑。相同提示词不会建立绑定。初次会话全局负载平衡、TTL 配置、网络失败重绑和诊断仍待迁移。

### 连接失败重绑（2026-09-25）

已接入响应头到达前的瞬时连接错误分类、账号切换、租约释放和会话绑定失效。取消/整体超时、策略校验和证书校验错误不触发切换；已开始响应的故障继续保持不切换。修复异常清理导致普通错误被误判为超时的问题。初次会话负载平衡、恢复探测、账号/用户预算仍待推进。

### 初次会话负载排序（2026-09-25）

新显式会话按模型全局有效绑定数与当前账号租约数计算权重负载，同分轮换；已有有效绑定仍优先。无会话请求只在有在途负载时平滑排序，否则维持权重随机。硬容量继续由账号租约控制；负载查询目前是快照，跨进程同时创建新会话的分布验收尚待完成。

### 用户共享限制（2026-09-25）

0009 增加用户级日 Token、并发、RPM 限制（0 表示不新增用户层限制，仍遵守密钥限制）。预留事务锁定用户策略并汇总其全部密钥，包括已吊销密钥的历史用量，避免多密钥并发绕过。管理读写接口分别要求 system_users/system_users_edit；网关 bearer key 不能修改。双密钥争抢与实际结算测试已接入；管理表单、跨日边界完整验收及生产多进程验证仍待补齐。


## User-limit administration form — 2026-09-25

User management now exposes an RBAC-gated gateway-limits dialog for daily tokens, concurrency and RPM across all keys owned by a user. The form documents UTC reset and zero semantics and keeps edits on save failure. English and Japanese translations are included. Three focused component tests verify numeric/zero submission, load-failure behavior and fractional validation with save-failure preservation; the web suite passes 51 tests and the production build passes (existing chunk warnings remain). This slice changes no database schema. Live browser inspection reached an expired login session, so authenticated visual acceptance is still pending. Changes remain local and unpublished; this is not final migration acceptance.


## UTC quota boundary correction — 2026-09-25

Fixed key-level rolling RPM dropping prior-day completed requests immediately after midnight. Key and shared-user daily totals exclude prior-day completed usage while retaining all outstanding reservations. Admission now samples the database clock after acquiring key/owner locks; both checks and the inserted created_at use that same instant rather than transaction-start time. A protected clock expression enables deterministic real-PostgreSQL boundary tests without changing host/database clocks.

Four new regression cases cover both scopes at 00:00:10 UTC, the 60-second RPM boundary, outstanding prior-day reservations, settlement and current-day reservations. pnpm typecheck, pnpm test (API 504 passed, 2 skipped, 180 TODO; web 51 passed), pnpm build and pnpm verify:gateway (296 passed, 180 TODO, migration/bootstrap checks) all pass. Existing build chunk warnings remain. No schema change or production write. Actual lock-wait midnight/recovery and full legacy parity remain unverified; changes are local and unpublished.


## Recovery-probe API slice — 2026-09-25

Added administrator-triggered saved-account recovery discovery with bounded GET transport, no redirect following, existing network restrictions and protocol-specific verification. OpenAI/Responses nonempty model lists may clear cooldown; Anthropic discovery only returns models and never verifies Messages health. Failed recovery probes are soft observations. Observation ordering plus credential/base/protocol/enabled guards prevent stale probe writes after account edits or newer traffic observations. See recovery-probes.md for endpoint semantics and the distinction from legacy manual hard-failure checks.

Added 11 tests using mock HTTP and isolated PostgreSQL. pnpm typecheck, pnpm test (API 515 passed, 2 skipped, 180 TODO; web 51 passed), pnpm build and pnpm verify:gateway (307 passed, 180 TODO plus migration/bootstrap) pass. No schema or production change, no real model calls, no publish. Periodic probing, durable claims/quiet windows, last-checked metadata, UI and provider-specific/legacy checks remain pending; P2 is not complete.


## Durable recovery worker — 2026-09-25

Manual/periodic probes now share database claims, 60-second lease expiry and fenced completion; stored last-start/outcome/latency supports diagnosis. The opt-in standalone worker scans five nonhealthy enabled accounts per minute with a ten-minute per-account quiet window. It prevents local overlapping batches and drains only its current probe on shutdown. Candidate claims recheck eligibility. API responses omit internal claim tokens. See recovery-probes.md for enablement and restart behavior.

Applied migration 0010_gateway_probe_claims to isolated coati_node_dev: prior ledger id 10 / 1790348467498, new head id 11 / 1790349444695. Verified all five new columns with psql. Database tests cover competing repository/service instances, lease expiry, old-token fencing, quiet-window expiry, newer traffic observations and configuration changes; runner tests cover no overlap, shutdown and retry after candidate-query failure. pnpm typecheck, pnpm test (API 520 passed, 2 skipped, 180 TODO; web 51 passed), pnpm build and pnpm verify:gateway pass, including fresh bootstrap. No production/provider traffic or publication. Actual OS process-kill acceptance, compose worker wiring, UI and provider-specific/legacy parity remain outstanding.


## Recovery console and Compose wiring — 2026-09-25

Added the RBAC-gated recovery action to model-service rows with separate discovery/recovery result wording and success/failure refresh. Added optional Compose recovery profile: worker shares API configuration, waits for healthy initialized API, exposes no port and replaces the HTTP entrypoint/healthcheck. Documentation describes enablement and explicit stopping. Fixture-only docker compose config JSON confirms the wiring; no containers were started and no provider was called. Web suite 54 tests and build pass; authenticated browser and actual container acceptance remain pending. This slice has no backend/schema changes and remains unpublished.


## Isolated Docker deployment and worker crash check — 2026-09-25

Built the current checkout using the repository Dockerfile as coati-node:recovery-validation. Started project coati-recovery-validation with its own PostgreSQL/app volumes, random disposable credentials and loopback port 18084. The default entrypoint initialized an empty production-configured database to all 11 migrations (head timestamp 1790349444695). API /health reported database connected; the recovery worker started only after API health passed. No existing deployment or developer database was used.

Added a temporary internal mock HTTP service, explicitly allowed private upstreams only in this disposable environment, and verified admin login/session/CSRF, creation of an encrypted saved credential, model discovery, health restoration and claim release through the built API. The model endpoint was a local fixture, not a real supplier.

For actual process recovery, changed the fixture to a ten-second model response, started a fresh probe, observed its persisted running claim, sent SIGKILL to the worker container and confirmed the claim survived. Advanced only the disposable probe_expires_at and last_probe_at timestamps to simulate lease/quiet-window expiry, restarted the worker, and verified the account became healthy with last_probe_status=verified and probe_token=NULL. This proves built-worker restart/reclaim behavior with a real killed process; it does not prove ten minutes of wall-clock waiting or high-load/cross-host failover.

Removed this test project's containers, network, volumes and temporary credential/configuration files after validation. The locally tagged build image remains available for repeat checks; nothing was published. Remaining acceptance includes authenticated visual QA, provider-specific and legacy check parity, real SDK/provider authorization, full data migration and upgrade/rollback.


## Personal key edit API — 2026-09-25

Added owner-scoped console PUT /api/admin/gateway/keys/:id with existing gateway_keys_edit permission and CSRF. It mirrors Python's valid-personal-key rules, supports 1–3650-day expiry or null/omitted for no expiry, locks before state/time validation, rejects revoked/expired/nonpersonal keys and keeps credential/scopes/limits/ledger unchanged. Unknown privilege fields are rejected. See key-lifecycle.md for scope and remaining creation/rotation/PAT/UI work.

Five added database/API tests pass. Full checks: typecheck; API 525 passed, 2 skipped, 180 TODO; web 54 passed; build; gateway gate 317 passed, 180 TODO including migration/bootstrap. No new schema or production writes. Changes remain local/unpublished; full key lifecycle parity is not claimed.


## Replacement-key rotation and quota continuity — 2026-09-25

Added owner-scoped POST /api/admin/gateway/keys/:id/rotate with console/CSRF and independent gateway_keys_rotate permission (incremental seed applied, English/Japanese menu catalogs updated). Rotation locks the original, inserts a replacement with copied policy/expiry, and revokes the old record in one transaction. Raw replacement tokens appear only in that response. A quota_group UUID and rotated_from_id history preserve per-key daily/RPM/concurrency across rotations while leaving independent keys separate; shared-user limits continue aggregating all keys.

Applied migration 0011_gateway_key_rotation to isolated coati_node_dev: prior head ledger 11 / 1790349444695, new head 12 / 1790350386740. Verified both columns, UUID default, lineage FK and group index using psql. Seven new regressions prove competing rotations, immediate old-token rejection, owner/expiry guards, all three quota types, in-flight settlement, repeated lineage, independent-key isolation and insertion rollback. Full checks pass: typecheck; API 532 passed, 2 skipped, 180 TODO; web 54 passed; build; gateway gate 324 passed, 180 TODO with fresh bootstrap. No production traffic or publication. Native console forms and legacy PAT/create compatibility remain outstanding; this is not full migration acceptance.


## Native key lifecycle console — 2026-09-25

Added permission-gated edit and rotation actions to the access-key list. Edit requires explicit new expiry; rotation confirms old-token invalidation and delivers the replacement to the existing one-time token dialog. Inactive keys cannot invoke actions and device keys cannot use the personal edit form. Fixed the new selector's uncontrolled transition and kept expiry-clock updates outside rendering. Web suite 57 tests, production build and new-component/test lint pass. ResourcePage's previously recorded load-effect lint issue is unchanged; authenticated visual acceptance is pending. No backend/schema change in this slice; changes remain local/unpublished.


## Legacy PAT scope prerequisite — 2026-09-25

Python PAT inspection found independent chat/profile scopes missing from Node keys. Added persisted scopes, restricted creation validation, model-call/discovery enforcement, rotation preservation and locked reservation-time scope/model rechecks. Profile-only keys cannot cause upstream calls or quota reservations. This is the authorization prerequisite for legacy PAT adaptation; the legacy endpoints/profile API and metadata remain open.

Applied migration 0012_gateway_key_scopes to coati_node_dev: prior ledger 12 / 1790350386740, head 13 / 1790350828064. Verified NOT NULL JSONB scopes with chat/profile default. Three added regression cases pass. Full checks pass: typecheck; API 535 passed, 2 skipped, 180 TODO; web 57 passed; build; gateway gate 327 passed, 180 TODO with fresh bootstrap. No production/provider traffic or publication. Existing creation defaults and full legacy shape still need migration.


## Python business-day timezone correction — 2026-09-25

Inspection for /api/agent/me found Python local_day_start_utc uses AGENT_TIMEZONE with Asia/Shanghai default, while Node admission/overview incorrectly fixed UTC. Corrected both owner/key quota day boundaries and overview aggregation to configured PostgreSQL business midnight; invalid timezone names fall back to Asia/Shanghai. Existing UTC cases now explicitly select UTC. Overview returns effective timezone, console copy no longer claims UTC, env examples and Compose pass the setting to API/worker. This supersedes earlier fixed-UTC default descriptions; preserve the source deployment timezone during migration.

Five new cases cover fallback/explicit UTC plus both key and user budgets at Shanghai midnight and New York's spring DST transition. Full checks pass: typecheck; API 540 passed, 2 skipped, 180 TODO; web 57 passed; build; gateway gate 332 passed, 180 TODO. Compose JSON confirms explicit UTC propagation. No schema/production change or publication. Profile response and default-quota policy remain pending; implementing a superficially matching /me response before fixing its accounting semantics was deferred.


## Default user policy and legacy profile — 2026-09-25

Added AGENT_DAILY_TOKEN_QUOTA with fail-closed integer validation; nullable daily_limit means inherit, explicit zero remains unlimited. Admission and quota summary share this policy. Existing preview numeric rows are preserved (including earlier automatic zero rows whose intent is unknowable); an administrator must explicitly clear them to adopt a nonzero default. The user-limit form accepts that clear operation. Added /api/agent/me with safe role/menu user serialization, profile-scope enforcement, settled daily quota fields, Bearer/X-Api-Key/Api-Key extraction and legacy missing/invalid/scope error shapes. PAT CRUD adapters remain pending.

Applied migration 0013_gateway_default_quota to coati_node_dev: prior ledger 13 / 1790350828064, head 14 / 1790351294575. Verified daily_limit is nullable with no default. Added default/zero/null admission tests, profile/auth contract tests, config validation and a UI inheritance test. Checks pass: typecheck; API 544 passed, 2 skipped, 180 TODO; web 58 passed; build; gateway gate 336 passed, 180 TODO including bootstrap. No production/provider traffic or publication. The first full run caught missing error translations; the corrected full rerun passed.


## Legacy PAT CRUD/list and metadata — 2026-09-26

Added console-session/CSRF legacy PAT creation/list/update/rotation/revocation routes, legacy metadata serialization, scoped search/filter/pagination and settled seven-day statistics. Creation defaults to unlimited expiry and no additional per-key caps; user/account limits continue applying. Notes survive rotation, revocation timestamps are stable across repeated deletion, and successful bearer authentication tracks last use best-effort. Existing unknown metadata remains null. See key-lifecycle.md for incomplete normalization/error/permission-import parity and the still-missing PAT usage endpoint.

Applied 0014_gateway_pat_metadata to isolated coati_node_dev: prior ledger 14 / 1790351294575, head 15 / 1790351644509. Verified nullable note, revoked_at and last_used_at columns using psql. Three new API/database regressions cover metadata/defaults/rotation/history, seven-day reservation exclusion and owner isolation, plus bearer-only/invalid-scope rejection. Typecheck, API 547 passed (2 skipped, 180 TODO), web 58 passed, production build and gateway gate 339 passed (180 TODO, migration/bootstrap included) all pass. git diff --check is clean. Changes remain local/uncommitted/unpublished; no real provider or production writes. Full migration is still in progress.


## Cache miss accounting prerequisite — 2026-09-26

PAT usage comparison exposed a missing Python ledger dimension: cache_miss_tokens. Migration 0015 adds nullable cache_miss_tokens and cache_miss_source. Explicit reported counters (including zero) win; with a reported cache dimension, OpenAI/Responses derive uncached input as total minus cache reads/writes, while Anthropic uses its disjoint input count. Absent dimensions and contradictory negative remainders remain unknown. Derived counters do not add to billed totals. Conversions preserve miss count/source, repeated SSE usage snapshots recompute derived values without summing counters, and the console labels derived values. Historical rows remain null; no fabricated backfill. Provider-specific aliases beyond the supported spellings still require the full adapter parity audit.

Applied to isolated coati_node_dev: prior ledger 15 / 1790351644509, head 16 / 1790352107074. Verified both nullable columns through psql. Added 11 normalization/conversion/snapshot tests and one UI test; extended all existing three-protocol JSON/SSE accounting matrix cases to assert persisted miss count/source. Typecheck, API 558 passed (2 skipped, 180 TODO), web 59 passed, production build, scoped usage/UI lint and gateway gate 350 passed (180 TODO, fresh migration/bootstrap included) all pass. This is a prerequisite fix; the PAT usage endpoint itself remains pending along with request-context metadata capture and legacy personal-response redaction. No production calls or publication.


## PAT usage and safe context recording — 2026-09-26

Implemented owner-scoped GET /api/agent/auth/pat/:id/usage with pagination, time/model/status filters, explicit reservation visibility, historical rotation records and personal field projection. Added context shape/trace capture without storing prompt/tool-result bodies, HMAC log correlation independent of session affinity, and legacy fallback-trace redaction. See key-lifecycle.md for implemented contract and explicit remaining UUID/event-ID, parent lineage, detailed error classification, final HTTP status and normalization/import differences.

Applied 0016_gateway_request_context to isolated coati_node_dev: prior ledger 16 / 1790352107074, head 17 / 1790352322878; verified nullable JSONB request_context via psql. Three context unit cases and two database/API cases added. First full test run exposed Drizzle stripping correlation qualifiers in raw SELECT subqueries; explicitly qualified static SQL fixed the request-id/attempt-id comparison and focused rerun passed. Corrected full suite: API 563 passed, 2 skipped, 180 TODO; web 59 passed. Typecheck, production build, scoped new-module lint and gateway gate (355 passed, 180 TODO, fresh migration/bootstrap included) pass. Changes remain local/unpublished, with no provider or production calls.

Follow-up audit item: legacy PAT seven-day token statistics currently sum every nonreserved Node row; Python sums only billable ok/stream_error/client_error rows. Align this alongside richer execution status capture rather than treating all settled failures as billable.


## Consistent billable-status aggregation — 2026-09-26

Corrected the preceding PAT statistics audit item across all consumers, not only that endpoint. A shared billable predicate now drives PAT seven-day token totals, settled user quota summaries, owner/key-group admission accounting and overview totals. Nonbillable failures retain logs and RPM impact but no longer consume daily token budgets; partial stream/client output remains billable. Active reservations still consume admission capacity without appearing in settled totals. Existing provisional interrupted-worker charging is unchanged and remains an explicitly documented recovery-parity acceptance item.

Two real-database regressions exercise both user and key quota paths across ten statuses, deliberately large nonbillable estimates, per-PAT/overview/profile consistency, exact remaining-budget admission and outstanding reservation exclusion from settled totals. Checks pass: typecheck; API 565 passed, 2 skipped, 180 TODO; web 59 passed; build; gateway gate 357 passed, 180 TODO including migration/bootstrap; git diff --check. No schema change, production traffic or publication. Next: execution failure categories/final HTTP status and admission-failure ledger capture, then remaining source behavior gaps.


## Execution status and downstream HTTP evidence — 2026-09-26

Replaced new generic error/cancelled execution records with explicit upstream_error/protocol_error/routing_error/client_error categories while retaining stream_error. Added nullable request-level http_status, separate from each attempt's upstream status. PAT usage uses this final gateway status and no longer guesses old-row values from attempts. Started streams record HTTP 200 even when later failing; pre-response client cancellation remains unknown. Updated console labels/detail and English/Japanese translations. Legacy aliases remain supported without rewriting historical rows.

Applied 0017_gateway_http_status to isolated coati_node_dev: prior ledger 17 / 1790352322878, head 18 / 1790352901277; verified nullable integer http_status using psql. Four new API/database cases distinguish upstream 401/429/503 from final gateway responses and cover stream failure/unknown historical values. Existing routing, cancellation and matrix assertions now verify canonical categories. Typecheck, API 569 passed (2 skipped, 180 TODO), web 59 passed, build and gateway gate 361 passed (180 TODO, migration/bootstrap included) pass. No production/provider traffic or publication. Pre-reservation failure ledger capture, recovery parity and server-tool lineage remain pending.


## Correlated pre-admission rejection records — 2026-09-26

Added zero-charge, nonreserved ledger rows for known routing/cooldown, protocol/stateful-option and admission-limit refusals. Responses share their request ID with the persisted record; execution errors now do likewise. Rejected records have no upstream attempts, no active concurrency ownership and no recoverable reservation. Recording failure is reported without changing refusal or invoking an upstream. Authentication/scope/model-grant/schema failures remain outside this model-request ledger.

Five added API/database tests cover no-route/cooldown/quota/stateful rejection and unavailable logging persistence; the conversion matrix's unsupported-parameter test now verifies a zero-charge protocol-error row instead of expecting no audit evidence. Checks pass: typecheck; API 574 passed (2 skipped, 180 TODO); web 59 passed; build; gateway gate 366 passed (180 TODO, migration/bootstrap included); git diff --check. No schema change or production/provider calls; changes remain local/unpublished. Next work returns to remaining protocol-matrix acceptance obligations; these checks do not establish final migration readiness.


## Cache usage wire acceptance and unknown-counter correction — 2026-09-26

Added 54 full-matrix JSON/SSE cases covering complete cache/reasoning/TTL details, explicitly reported zero and absent usage. They assert both persisted counters and client-visible totals/details. Replaced the 18 usage-cache TODO obligations with these tests, leaving 162 other obligations. Tests exposed synthetic cache zeros in three conversion paths and synthetic Anthropic start totals; runtime wire output now uses actual normalized upstream snapshots rather than merging in legacy-fabricated values. Pure Python parity fixtures remain unchanged; the explicit runtime behavior correction is documented in protocol-contract.md.

The initial zero-profile failure was a mock's hardcoded Anthropic final output count, corrected to use the selected profile. Actual unknown-cache failures then reproduced and were fixed. Final full checks: API 628 passed, 2 skipped, 162 TODO; web 59 passed; typecheck, build, scoped service/stream lint and gateway gate (420 passed, 162 TODO, migration/bootstrap included) pass. No schema change, real provider traffic or publication. Cache-control input capability policy and other protocol scenarios remain incomplete; this is not final migration acceptance.


## Actual client-tool roundtrip matrix — 2026-09-26

Added 18 two-request roundtrips across all nine protocol pairs and JSON/SSE modes. Each case parses the first actual wire tool call (stream argument fragments where applicable), constructs the follow-up from that ID/name/arguments and verifies the mock upstream receives correctly linked call/result history. Both turns must have independently settled usage. Replaced the 18 tool-roundtrip TODOs, leaving 144; parallel tools and other tool capabilities remain explicitly unaccepted.

Focused matrix: 166 tests pass. Full typecheck, API 646 passed (2 skipped, 144 TODO), web 59 passed, build and gateway gate (438 passed, 144 TODO, migration/bootstrap included) pass. No runtime/schema change in this slice, no real provider calls or publication. The new evidence establishes single client-tool roundtrips, not server-tool execution or final migration readiness.


## Parallel tools with interleaved parameters — 2026-09-26

Added 18 full-pair/mode roundtrips using two same-name functions with distinct IDs and arguments. Parameter fragments alternate at individual-character granularity including Unicode/JSON escapes; results return in reverse order. Assertions reconstruct actual wire calls, compare both complete upstream histories and per-ID results, and require two independently settled request rows. All 184 focused matrix tests pass. The 18 parallel-tools TODOs are replaced by these cases, leaving 126.

Full typecheck, API 664 passed (2 skipped, 126 TODO), web 59 passed, build and gateway gate (456 passed, 126 TODO, migration/bootstrap included) pass. No runtime/schema change, live provider calls or publication. This establishes valid parallel client-tool conversion, not malformed-call handling, strict tool capability policy, server tools or final migration readiness.


## Settlement confirmation and no error-path rewrite — 2026-09-26

Full-matrix settlement testing found that a first-write exception could be followed by a successful error-handler update, converting generated usage into an unbilled upstream_error. Added a per-request failed-settlement guard, safe settlement_failed errors, and an exactly-one-updated-row check. JSON success and SSE successful terminals remain withheld when persistence cannot be confirmed; subsequent error/finally paths cannot rewrite the ledger. Upstream leases are released independently, while the simulated pre-write failures retain reservations for recovery. Ambiguous commits preserve whatever state actually persisted rather than forcing a rollback assertion.

Added 36 real-handler fault cases (nine pairs x JSON/SSE x exception/zero-row update), with only the first database call faulted to expose unintended retries. Tests check one attempted update, no fabricated success, correlated request IDs, no private error leakage, retained reservations and lease release. Replaced 18 settlement-failure TODOs, leaving 108. Typecheck, API 700 passed (2 skipped, 108 TODO), web 59 passed, build, scoped service/stream lint and gateway gate (492 passed, 108 TODO, migration/bootstrap included) pass. No schema change, production/provider calls or publication. Recovery reconciliation and remaining compatibility scope are still open.


## Truncated response audit and matrix acceptance — 2026-09-26

Added 18 all-pair JSON/SSE truncation tests with a configured backup: invalid partial JSON and missing SSE source terminals cannot produce success, do not trigger another account call, retain correlated request errors, record exactly one upstream attempt and release the lease. Initial focused tests exposed missing JSON attempt records in all nine JSON directions. Bounded read/parse/object validation/usage observation failures now record safe attempt diagnostics before propagating; no parser body excerpts are stored.

The 18 truncated-stream obligations are replaced by these real tests, leaving 90 matrix TODOs. The first full run passed functional cases but caught a missing translation for the new diagnostic; English/Japanese entries were added before rerunning validation. Corrected full run: API 718 passed (2 skipped, 90 TODO), web 59 passed; typecheck, build, scoped service lint and gateway gate (510 passed, 90 TODO, migration/bootstrap included) pass. No schema change, real provider calls or publication. Cancellation, slow-client behavior and other protocol/capability work remain open.


## Live HTTP cancellation across all pairs — 2026-09-26

Added 18 real-client JSON/SSE cancellation cases across nine protocol pairs. The JSON fixture leaves a body incomplete; SSE remains open after initial content. Tests cancel at those distinct stages and await upstream closure plus client_error settlement, checking one upstream request, no active reservation/account lease, and null-versus-200 HTTP evidence. The focused cases all pass; replaced 18 cancel TODOs, leaving 72. No runtime/schema change was needed.

Full typecheck, API 736 passed (2 skipped, 72 TODO), web 59 passed, build and gateway gate (528 passed, 72 TODO, migration/bootstrap included) pass. No production/provider calls or publication. Remaining matrix categories are image, reasoning, unsupported-field and slow-client, in addition to broader migration/acceptance work.


## Ordinary image transport baseline — 2026-09-26

Added 18 nine-pair JSON/SSE cases with URL and base64 PNG input. Tests verify exact image representation/order at the mock upstream, no gateway fetch of a local image URL, one model request, correct image_count and no raw URL/base64 persisted in context. Source comparison identified the missing coati-auto vision_model target selection; documented its Python detection rules and 503 behavior in protocol-contract.md. Ordinary Python routes do not enforce mandatory vision declarations, so the earlier draft must not invent that as migration behavior.

Focused 18 cases and full API 754 passed (2 skipped, 72 TODO), web 59 passed, typecheck, build and gateway gate (546 passed, 72 TODO, migration/bootstrap included) pass. Image TODOs remain open for automatic routing and type/size policy acceptance. No runtime/schema change, live provider calls or publication. Next: migrate vision_model and automatic model selection with console configuration and route revalidation.


## Automatic image target routing — 2026-09-26

Migrated Python coati-auto detection and nullable per-route vision_model. Text requests select upstream_model; image requests select vision_model; normal model names ignore this override. Missing auto routes or configured image targets return 503 before upstream traffic. The management route form exposes the optional field and allows clearing it. The repository rechecks image eligibility under the route lock before creating an account lease or session binding, preventing a concurrently removed target from silently invoking a text model.

Added 12 source-derived detection cases and six API/database cases covering target selection, public alias preservation, missing configuration, route editing/clearing and removal between candidate selection and acquisition. Development database applied 0018_gateway_vision_model, verified nullable text column and 19 migration entries (latest 1790355012819). Typecheck, build and scoped backend lint pass; full API 772 passed (2 skipped, 72 TODO), web 59 passed. Gateway gate passes with 564 tests and 72 TODOs, including clean-database migration/bootstrap; git diff --check passes. Image matrix TODOs remain open for type/size policy acceptance; no provider vision support is inferred. No live supplier calls or publication.


## Image boundary and automatic matrix acceptance — 2026-09-26

Compared Python protocol_bridge image helpers, provider adapters and MAX_CONTENT_LENGTH: the legacy gateway passes through nonempty MIME/base64 strings without decoding or image-specific validation, and bounds the encoded body at the global request limit. Expanded real-handler fixtures from 18 to 54 image cases, covering all pairs/modes with PNG, automatic vision routing, and opaque MIME/data preservation. Added six exact body-byte boundary cases (configured 2048 accepted, 2049 rejected with 413 before supplier traffic/new ledger/leases). Focused 60 cases pass. Removed 18 image TODO placeholders, leaving 54 (reasoning, unsupported-field, slow-client); malformed/empty field behavior belongs to the remaining field compatibility review.

Typecheck, full API 814 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 606 passed (54 TODO; clean migration/bootstrap included) pass. git diff --check passes. No runtime/schema change in this stage and no live supplier calls or publication. This verifies gateway image transport and selection, not real model vision quality. Next: reasoning content/signature round trips against Python, including unsigned Chat-to-Messages text representation and Responses encrypted-content handling; broad migration acceptance remains open.


## Reasoning JSON replay baseline — 2026-09-26

Added nine real-handler two-request tests: follow-up history is taken from the actual first JSON response and sent back through each protocol pair. Assertions cover thought and answer content, public model alias, supported signature/encrypted_content mapping, unsigned Chat-to-Messages text representation and two successful ledger rows. All nine focused tests pass. The audit also records two unresolved signature limitations: Python/Node Anthropic request encoding into Responses omits signatures, and the streaming Chat intermediate has no opaque signature transport. These are explicitly documented in protocol-contract.md; all 18 reasoning obligations remain open, and total matrix TODOs remain 54.

Full API 823 passed (2 skipped, 54 TODO), web 59 passed; typecheck passes. Build and gateway gate pass (615 passed, 54 TODO; clean migration/bootstrap included); git diff --check passes. No runtime/schema change, supplier traffic or publication. Next work must validate streaming reasoning and resolve the signature capability boundary before marking reasoning accepted.


## Reasoning SSE replay baseline — 2026-09-26

Added nine actual SSE handler/replay cases using one-byte transport fragmentation, including multibyte thought, answer and opaque signature text. Tests reconstruct client history from emitted deltas/terminal response items, replay it, and verify exact text, one terminal and two successful ledger rows. Native Messages/Responses preserve signature data. The tests now prove runtime cross-protocol signature loss as well as text preservation, matching the existing Python-style pipeline; this limitation is not accepted as the final capability contract. All 18 reasoning TODOs remain open (54 total).

Focused nine tests, typecheck, full API 832 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 624 passed (54 TODO, clean migration/bootstrap included) pass. git diff --check passes. No runtime/schema change, real supplier traffic or publication. Next: resolve opaque-signature handling consistently across request, JSON response and streaming conversion, with explicit capability boundaries; full migration remains incomplete.


## Messages-to-Responses stream signature fix — 2026-09-26

Implemented a direct signed-thinking path in the runtime stream bridge. Messages signature_delta fragments and initial thinking/signature fields now reach Responses encrypted_content on the corresponding completed item and final output. Sequential blocks receive separate IDs and independent text/signature buffers, including signature-only blocks. Unclosed thinking blocks cause truncated_stream even if a later message terminal arrives. This matches existing JSON mapping without inventing a Chat signature field or asserting supplier interoperability.

Updated the actual SSE matrix replay test to require signature preservation in this direction; added block/empty-summary/initial-value/missing-stop tests. Focused nine matrix tests and 17 signed-block/legacy-stream tests pass. Full typecheck, API 834 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 626 passed (54 TODO, clean migration/bootstrap included) pass; git diff --check passes. No schema change, real supplier traffic or publication. Reverse Responses-to-Messages streaming and Messages-to-Responses request signature behavior still need work; the 18 reasoning TODOs remain open and the overall migration is incomplete.


## Messages-to-Responses request signature fix — 2026-09-26

Request conversion now retains thinking.signature as reasoning.encrypted_content for each item, including empty-text signed blocks. Updated JSON wire replay assertions and added a direct multiple-block round trip, unsigned fallback and input-immutability test. This intentionally corrects Python's request omission and aligns request encoding with existing JSON response and corrected SSE mapping; no supplier signature portability is assumed. The original 88 golden cases and hash guard remain unchanged and pass because the old request samples lacked signatures.

Focused matrix/signed/golden suite: 426 passed. The first typecheck found unknown-field accesses in the new test; these were replaced with typed object/array helpers and typecheck then passed. Full API 835 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 627 passed (54 TODO; clean migration/bootstrap included) pass. git diff --check passes. No schema change, live supplier traffic or publication. Reverse Responses-to-Messages streaming remains unresolved; reasoning TODOs and broader migration acceptance remain open.


## Responses-to-Messages stream signature fix — 2026-09-26

Runtime stream conversion now emits completed Responses reasoning items directly as signed Messages thinking blocks or unsigned text blocks, bypassing the lossy Chat intermediate. Item completion retains encrypted_content; final output supplies items not completed earlier and does not duplicate completed identities. Pending reasoning absent from final output raises truncated_stream. Startup still uses the ordinary usage-normalizing path so missing initial usage is not changed into zero.

Updated all-pair SSE replay to require signature preservation across both Messages/Responses directions. Added multiple-item, signature-only, unsigned, duplicate-completion, terminal-only completion and missing-item tests. Focused nine matrix tests and 21 signed/legacy stream tests pass. Typecheck, API 838 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 630 passed (54 TODO, clean migration/bootstrap included) pass; git diff --check passes. No schema change, supplier traffic or publication. Mixed-content ordering with delayed reasoning completion, conflicting completion data and block/index edge cases remain to audit before closing reasoning obligations; overall migration remains incomplete.


## Reasoning completion conflict protection — 2026-09-26

Responses-to-Messages streaming now compares repeated completions against the emitted text/signature and verifies item identity for each output index. Conflicting text, removed/changed opaque data or a reassigned identity raises an internal invalid_response with a safe diagnostic. The external handler keeps its stream_error envelope, withholds message_stop, records stream_error, makes one supplier call and releases the account lease. Index-only reasoning events resolve through the announced item alias.

Added four focused content/signature/identity/index tests and one actual API error/ledger/lease case. Initial test issues were corrected: the fixture's shared item/final object needed independent cloning, and the API assertion needed the established stream_error code rather than the internal code. Retest: 345 passed. Typecheck, full API 843 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 635 passed (54 TODO; clean migration/bootstrap included) pass. git diff --check passes. No schema change, real supplier calls or publication. Mixed-content order and interleaved block boundaries remain open; all reasoning obligations and full migration goal remain active.


## Delayed reasoning/content ordering fix — 2026-09-26

Added a bounded ordering layer for Responses-to-Messages streams. Later text/tool frames wait behind an announced reasoning item until item completion or final output supplies its signature-bearing content. Completed reasoning is emitted before queued later content, preserving source order without manufacturing signatures. Original bytes are counted before buffering against the 16 MiB cap; synthesized completions do not consume the supplier-byte allowance a second time. Missing completions still fail and consumed queued frames are released.

Added delayed-item and terminal-only completion order tests, two actual handler/ledger cases, a thought/text/tool case preserving tool ID/arguments, and a bounded unresolved-item test. Focused matrix/signed suite: 351 passed. Typecheck, full API 849 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 641 passed (54 TODO; clean migration/bootstrap included) pass; git diff --check passes. No schema change, real supplier traffic or publication. Interleaved Messages reasoning blocks and final unsupported-capability behavior remain open; full migration goal is not complete.


## Interleaved Messages thinking fix — 2026-09-26

Added a bounded Messages thinking-order layer for the Responses target. Active-block deltas stream immediately; other blocks wait and then drain by source thinking index, keeping each block's text/signature separate when later blocks stop first. Unknown or late signature fragments, duplicate thinking starts and invalid thinking indexes fail explicitly. Native same-protocol paths are unaffected. Byte counting occurs before buffering and preserves the 16 MiB limit.

Added interleaved-two-block/text and malformed lifecycle tests, plus actual gateway success/failure ledger and lease checks. Initial focused suite: 355 passed. Full validation exposed a new fixture mode not wired into the upstream handler; fixed that test setup, and the gateway gate then passed 647 tests (54 TODO, clean migration/bootstrap included). Typecheck and build pass. Corrected full rerun: API 855 passed (2 skipped, 54 TODO), web 59 passed; git diff --check passes. No schema change, real supplier traffic or publication. Final opaque-content/unsupported-capability rules remain open; all reasoning TODOs and the broad migration goal remain active.


## Redacted thinking explicit boundary — 2026-09-26

The runtime bridge rejects Messages redacted_thinking on cross-protocol requests/responses/SSE, while native Messages retains the block unchanged. Requests with no compatible candidate return 400 unsupported_feature, zero-charge protocol_error and no supplier call; JSON response conversion returns 502 protocol_error; SSE returns stream_error without a success terminal and releases the lease. Checks target protocol content blocks, including initial stream message content, without inspecting tool inputs/schemas or leaking opaque data.

Added 12 handler cases across native/cross-protocol JSON/SSE request/response paths plus a tool-payload false-positive test. Initial assertions needed explicit numeric SQL casts; the first fix also touched two existing tool-test queries, which was corrected to affect only the new test. The corrected gateway gate passes 660 tests (54 TODO; clean migration/bootstrap included), with typecheck/build passing. Corrected full rerun passes: API 868 passed (2 skipped, 54 TODO), web 59 passed; git diff --check passes. No schema change, supplier traffic or publication. Chat signature capability and other unsupported-field behavior remain open; full migration is incomplete.


## Explicit reasoning policy and matrix acceptance — 2026-09-26

Added X-Coati-Reasoning-Policy (preserve by default, text-only by explicit selection). Runtime conversion refuses signed history/output when targeting Chat unless text-only is chosen; redacted_thinking remains forbidden across protocols in either mode. The policy is recorded in request_context and never forwarded upstream. Both candidate preflight and fresh route conversion, JSON and SSE use the same option. Native protocol data is preserved. Added strict/explicit request and response cases, policy tracing/non-forwarding, invalid policy rejection and the redacted exception.

New tests exposed standalone Responses reasoning disappearing before the next user message. Fixed it by flushing a separate assistant reasoning message while retaining normal assistant/tool grouping; original Python goldens still pass. Documented the intentional correction, protocol limitations and header usage in the Node README. Focused suite: 477 passed, followed by an additional standalone-history regression. The accumulated nine-pair JSON/SSE/replay, signature, ordering, conflict, lifecycle, policy and redacted evidence replaces the 18 reasoning TODOs. Remaining matrix categories: unsupported-field and slow-client, 36 TODOs.

Typecheck, full API 887 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 679 passed (36 TODO; clean migration/bootstrap included) pass; git diff --check passes. No schema change, real supplier traffic or publication. This is simulated-upstream gateway acceptance, not SDK/provider interoperability or completion of the full migration objective.


## Stop and structured-output field preservation — 2026-09-26

Audit found Chat/Messages stop sequences dropped when converting to Responses and Responses text.format dropped when converting to Chat/Messages. Added explicit Responses-route refusal for supplied non-null stop settings, retaining native and Chat/Messages stop mappings. Responses-to-Chat now maps json_object/text/json_schema formats and preserves schema/name/description/explicit strict:false. Current Messages conversion refuses structured-format requirements it cannot map, consistent with the existing Chat-to-Messages behavior. Native routes remain passthrough.

Added 12 stop and 24 structured-format handler cases covering JSON/SSE, preserved upstream fields, refusals and no upstream traffic on preflight failures. Focused matrix plus Python golden suite: 493 passed. Typecheck, full API 923 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 715 passed (36 TODO; clean migration/bootstrap included) pass; git diff --check passes. Public Node README and protocol contract describe these boundaries without claiming supplier output compliance. No schema change, real supplier calls or publication. Remaining unsupported-field cases and slow-client acceptance stay open; overall migration remains incomplete.


## Parallel tool-control preservation — 2026-09-26

Verified official Claude/OpenAI field semantics and added runtime cross-protocol mapping between parallel_tool_calls and the inverse Messages tool_choice.disable_parallel_tool_use. Named selection is retained, missing Messages choice defaults to auto only when needed for the explicit control, and none remains none without an unsupported parallel subfield. Tool-less requests do not gain a tool_choice; non-boolean explicit values are rejected. Existing native paths are unchanged.

Added 72 real-handler cases across nine pairs, JSON/SSE, both boolean settings and default/named choices, plus three boundary tests. Focused 72 cases pass. Typecheck, full API 998 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 790 passed (36 TODO; clean migration/bootstrap included) pass; git diff --check passes. Official references and mapping boundaries are recorded in protocol-contract.md. No schema change, real supplier traffic or publication. Other tool/unsupported fields and slow-client acceptance remain open, as does the complete migration goal.

## Tool strict-control preservation — 2026-09-26

Added explicit true/false tool strict preservation on all six runtime cross conversions, including legacy Responses additional_tools. Native routes remain passthrough. Missing strict is not defaulted, schema properties are not interpreted as controls, and non-boolean or ambiguous declarations fail conversion. Added 36 real-handler JSON/SSE matrix cases and eight boundary tests covering omission, false, schema identity, input immutability, invalid values, duplicate names and additional_tools. This validates transport through mock suppliers, not supplier schema enforcement. Unsupported-field and slow-client matrix categories remain open (36 TODO); full migration remains incomplete.

Typecheck, full API 1042 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 834 passed (36 TODO; clean migration/bootstrap included) pass; git diff --check passes. Logs: /tmp/coati-tool-strict-{focused,typecheck,tests,build,gate}.log. No schema change, real supplier traffic, commit or publication.

## Real HTTP slow-reader evidence — 2026-09-26

Added nine streaming matrix tests using Node HTTP responses deliberately left paused. A mock supplier can generate 256 MiB of text deltas, but production must plateau below 16 MiB while the client remains paused (two stable sampling windows), and the client readable buffer stays at most 128 KiB. Cancelling then must close the supplier, settle client_error, release the lease and avoid retries. These are observed pull/backpressure bounds in the local TCP setup, not process RSS bounds or a platform-independent socket memory budget.

Added nine 128 KiB slow-resume cases checking exact text deltas, success terminal, ok settlement and released leases. Initial 512 KiB resume experiments exposed the existing aggregate 1 MiB terminal buffer limit when Chat/Messages convert to Responses: repeated full-text terminal events exceed the cap. Two explicit regression cases retain that finding: stream_error, no completed terminal, released leases. Do not treat the smaller successful resume case as long-stream parity. Terminal-buffer sizing/parity remains an acceptance issue to resolve; do not simply remove its bound.

Focused 20 cases pass. All 36 matrix TODOs remain until remaining JSON/long-duration/timeout and unsupported-field obligations are covered. No runtime code changed in this stage; no supplier traffic or production writes.

Validation: typecheck, API 1062 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 854 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-slow-client-{focused,typecheck,tests,build,gate}.log. Changes remain local and uncommitted; full migration acceptance is incomplete.

## Settlement-buffer correction — 2026-09-26

Resolved the repeated-ending-buffer issue identified in the prior slow-reader stage. Added SettlementBuffer: only allowlisted Responses content endings bypass pending settlement; response-level completion and subsequent frames stay held in order. Individual frames and aggregate held completion remain capped at 1 MiB. This avoids counting repeated full text from multiple content endings against one aggregate terminal budget without removing the bound or exposing successful completion before accounting commits.

The two former 512 KiB bounded-error cases now require successful completion and ok accounting. Real HTTP slow-resume cases now use 512 KiB when the client is Responses, including native/cross suppliers. Added four long-response error cases for genuinely oversized single events and failed accounting, plus three buffer unit cases for per-event/aggregate limits and ordering. Focused runs passed 65 cases and 13 additional/updated boundary cases. Long-stream/JSON/timeout/load acceptance and all 36 existing matrix TODOs remain open.

Typecheck, API 1069 passed (2 skipped, 36 TODO), web 59 passed, build, and gateway gate 861 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-terminal-buffer-{focused,boundaries,typecheck,tests,build,gate}.log. No database schema changes, supplier traffic, production writes, commit or publication.

## Paused-consumer timeout accounting — 2026-09-26

Reproduced a suspended-generator cleanup defect: after the first yielded event, an idle timeout aborted transport but left the request reserved until the consumer pulled again. Added a stream abort listener that settles client_error (client cancellation) or stream_error (idle/deadline) independently of iteration. All finish paths share one promise, preventing concurrent abort/catch/finally paths from issuing multiple writes. Aborted streams check the signal before reading/converting more chunks and before sending successful completion. The listener is removed before normal final cleanup.

The original paused-idle reproduction failed before the fix. Four focused service cases pass afterward, plus 27 cases covering all nine protocol pairs and idle/deadline/client cancellation while no next()/return() is called. They require settled ledger state, no account lease, upstream closure, one settlement write, one supplier call and no later success terminal. These are service-consumer pause tests with actual loopback upstream sockets; prior real HTTP backpressure tests remain separate evidence. Downstream connection lifetime, sustained load/RSS, JSON slow readers and complete migration acceptance remain open.

Typecheck, full API 1099 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 891 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-paused-timeout-{before,focused,matrix,typecheck,tests,build,gate}.log. No schema change, real supplier traffic, production writes, commit or publication.

## Bounded downstream response lifetime — 2026-09-26

Added a response deadline to every model route/alias after bearer authentication. It bounds downstream writes to the configured service request timeout plus a 1-second error-flush grace period (currently 180s + 1s). An unfinished response is destroyed, triggering the existing close/cancellation chain. Finish and close both cancel the timer and detach listeners; timers are unref'ed. This complements supplier deadlines and the paused-iterator accounting fix without depending on a consumer reading again.

Three helper tests cover paused SSE/JSON HTTP readers and finished/disconnected timer cleanup. Nine real gateway HTTP tests use a shortened 500ms service deadline and production 1s grace, pause the client while a large supplier stream is backpressured, and require actual server response close, supplier close, stream_error ledger, no lease and no retry. The first matrix run exposed a test setup error (adding a Fastify hook after ready); the test now observes the underlying HTTP server's response close event, and all nine pass. No supplier/production traffic. Sustained-load/RSS, JSON gateway-level slow-reader matrix, and broader acceptance remain open; no matrix TODOs are removed by this stage.

Typecheck, full API 1111 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 903 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-response-deadline-{focused,matrix,typecheck,tests,build,gate}.log. No schema change, real supplier traffic, production writes, commit or publication.

## Messages count_tokens migration — 2026-09-26

Re-audited the main plan and selected an unimplemented legacy capability rather than continuing only stream edge cases. Ported the Python local count_tokens estimator: compact UTF-8 JSON bytes / 4 for messages, retained client tools, system and tool_choice; server-tool declarations are removed and search/fetch history is normalized, including gateway coati1 payload text. This is an estimate, not provider tokenization or billed usage. No model route is required, consistent with the Python endpoint.

Added the standard /v1/messages/count_tokens and both existing Python aliases with API-key authentication, chat scope and correlated request-ID headers. Added a reproducible Python-only fixture exporter that executes unchanged count_tokens/estimate_tokens methods and server-tool normalization without Flask/DB. Nineteen golden cases cover Unicode, tools and successful/failed search/fetch history; a source hash guard detects reference drift. Three handler cases cover aliases, authorization, scope, no supplier call and no ledger write. Focused 23 cases pass. The two count_tokens inventory entries now point to implementation/evidence; broader P1 model/capability and P5 server-tool execution tasks remain open.

Typecheck, full API 1134 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 926 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-count-tokens-{focused,typecheck,tests,build,gate}.log. No schema change, real supplier traffic, production writes, commit or publication.

## Device authorization decision transitions — 2026-09-26

Compared Python auth routes/service with Node. Added the legacy /api/agent/auth/device/confirm alias inside the session/CSRF/RBAC registration scope, alongside the existing admin route. Added corresponding deny endpoints for the planned explicit refusal flow. Decisions lock the device row, use database time after acquiring the lock, persist expiry and permit only pending -> approved/denied. Confirmation errors distinguish invalid code (404), expiry (410) and an already-decided request (409). Polling distinguishes unknown device (404), pending/expired/denied (400) and already-consumed (409); a consumed row remains consumed even after its original authorization expiry. Existing atomic single redemption remains in place. start now includes verification_uri_complete.

Four new endpoint tests plus the existing concurrent-redemption test pass. They cover both route families, normalized code, refusal, expiry, competing decisions, CSRF, single redemption and no key issuance for denied/expired requests. Initial CSRF test incorrectly passed a cookie value as the entire Cookie header; corrected to the test helper's named cookie, then passed. This stage covers API transitions, not the full device UX: deny UI, login return/query-prefill, legacy grant response/details, policy parity, distributed abuse controls and authenticated browser acceptance remain open.

Typecheck, full API 1138 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 930 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-device-decisions-{focused,typecheck,tests,build,gate}.log. No schema change, real supplier traffic, production writes, commit or publication.

## Shared device-start admission — 2026-09-26

Ported the Python create_device_code admission policy onto existing Node device rows without a schema change: PostgreSQL advisory transaction lock, old-row cleanup, expired-state updates, recent-start count and pending/approved capacity. Database time after lock acquisition governs counters and new 600-second grants. Cleanup commits even when admission refuses. Defaults are 60 starts/minute, 5000 active and 24h retention; env examples and Compose propagate the three legacy setting names. API rate errors include Retry-After: 60, and capacity errors return 503.

Three focused DB/handler tests pass: independent connection pools concurrently submit 12 starts under a global limit of 3 (exactly 3 created); approved requests count toward capacity, expiry frees capacity and retention removes old rows; changing client IP does not bypass the shared limit. Added a configuration fallback/override test. This proves shared database admission, not a deployed multi-replica load test. The existing per-IP process-local guard is retained; distributed polling control and complete device flow acceptance remain open.

Typecheck, full API 1142 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 934 passed (36 TODO; clean migration/bootstrap included). Compose config --quiet with disposable fixture values and git diff --check pass. Logs: /tmp/coati-device-admission-{focused,typecheck,tests,build,gate}.log. No schema change, real supplier traffic, production writes, commit or publication.

## Device authorization page closure — 2026-09-26

Applied ui-craft as a focused workflow correction, retaining the existing layout/components. The page now prefills user_code from verification_uri_complete without auto-submitting, shows the signed-in account, exposes explicit deny alongside confirm, normalizes input, blocks duplicate decisions while pending, preserves the code on failure and gives specific invalid/expired/already-handled feedback. Permission-less accounts see an explanation instead of action controls. Existing PrivateRoute/login return-path handling already preserves query state; added a regression for the full verification link. English/Japanese strings are included.

Five component tests cover query prefill/no auto-grant, denial, validation/error/retry, pending-state locking, permission handling and login redirect preservation. Browser evidence: localhost dev frontend (IPv6 localhost; 127.0.0.1 was not bound), existing authenticated admin session; 1280x720 invalid-code flow and 390x844 form layout; actual generated disposable device request denied in browser, followed by API polling 400 access_denied/no token. The temporary poll secret was removed and viewport reset. Successful confirmation and fresh-login return are component/API evidence, not new browser acceptance. Full device policy parity and distributed polling remain open.

Typecheck, API 1142 passed (2 skipped, 36 TODO), web 64 passed, build and gateway gate 934 passed (36 TODO; clean migration/bootstrap included). Scoped frontend lint first found the callback/ref analysis issue; moved handleSubmit construction into event callbacks, then scoped lint, all 64 web tests and web build passed again. Browser checks preceded that event-wrapper-only correction; final component tests cover the corrected callbacks. git diff --check passes. Logs: /tmp/coati-device-ui-{focused,typecheck,tests,build,gate,lint,web-final,build-final}.log. No schema change, supplier traffic, production writes, commit or publication.

## Device-grant policy and profile parity — 2026-09-26

Compared Python device PAT issuance with Node: Python has no separate device key daily/concurrency/RPM policy, but Node preview hardcoded 100000/5/60. New Node device grants now store zero extra key caps and use existing owner-level governance. Existing issued keys are untouched. Retained chat/profile scopes and 30-day TTL. Restored user data in poll success via the normal safe serializer. User/profile loading is inside the redemption transaction before key insertion, preventing a failed follow-up read from consuming authorization without returning credentials.

The authorization page now describes model/profile access and shared quota/limits rather than promising a fixed 100000-token allocation. Added a grant test that admits a 120000-token reservation under a 200000 shared budget, then separately verifies user concurrency, quota and RPM refusals; checks profile fields/no password and token lifetime/scopes. Added profile-read fault injection proving transaction rollback preserves approval, issues no key and permits retry. Four initial grant/decision cases passed; both new parity/fault-injection cases also pass in the full suite. Distributed polling and complete legacy/client acceptance remain open.

Typecheck, full API 1144 passed (2 skipped, 36 TODO), web 64 passed, build and gateway gate 936 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-device-grant-{focused,typecheck,tests,build,gate}.log. No schema change, supplier traffic, production writes, commit or publication.


## Shared device polling admission — 2026-09-26

Replaced the process-local device start/poll address map with PostgreSQL fixed windows (60 requests/minute/IP, at most 10000 current identities). Advisory-lock serialization covers admission and capacity; database time governs expiry. Four focused tests pass for two-pool contention, expiry/capacity reclamation, two application instances sharing limits, and explicit trusted proxy chains. The first handler test exposed inherited unconditional one-hop proxy trust: forged X-Forwarded-For could evade IP counters. Corrected this to the explicit TRUSTED_PROXIES IP/CIDR allowlist, default empty; configuration and deployment guidance are updated. The existing HTTPS cookie contract now explicitly configures its trusted loopback proxy. No schema/data migration is applied to Python.

Migration 0019 is additive; development head before upgrade was 0018 (19 ledger rows, 1790355012819). Full validation and post-upgrade schema evidence follow. Deployed multi-replica/load and full device-client acceptance remain open.

Typecheck, full API 1148 passed (2 skipped, 36 TODO), web 64 passed, build and gateway gate 940 passed (36 TODO; clean migration/bootstrap included). Development/test databases are at 0019 (20 migration rows, 1790355012820); development table columns and both primary/window indexes were inspected after the real upgrade. Compose config with disposable fixture values and git diff --check pass. Extra app/config lint finds the pre-existing unused resolveAiSqlUrl in config.ts (also present at HEAD); gateway-scoped lint passes via the gate. Logs: /tmp/coati-device-shared-{focused,migrate,typecheck,tests,build,gate,config-lint}.log. No supplier traffic, production writes, commit or publication.


## Personal usage query migration — 2026-09-26

Migrated GET /api/agent/me/usage using the existing PAT usage serializer and a shared owner-scoped repository query. Supports cross-key/rotation history, optional PAT/model/status/days filters, pagination, cached usage distinctions and personal-view redaction. The current session defines owner scope; query user_id is ignored, and foreign/unknown PAT filters return no records. PAT-specific endpoints retain path ownership/404 semantics. Two new cases plus both existing PAT cases passed in the initial focused run. Added a normal account with no management role to exercise login and owner isolation, alongside bearer-only rejection, invalid filters, reservation visibility, time window and fallback redaction. Full validation follows. Analytics/export/admin query and historical import remain open.

Typecheck, full API 1150 passed (2 skipped, 36 TODO), web 64 passed, build and gateway gate 942 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-mine-usage-{focused,typecheck,tests,build,gate}.log. No schema change, live supplier traffic, production writes, commit or publication.


## Personal usage export migration — 2026-09-26

Ported Python personal export field map, selection/filter behavior, Chinese labels and cache blank/zero handling. CSV/XLSX use existing table tools; actual BIFF8 XLS uses pinned official SheetJS CE 0.20.3 (Apache-2.0). Shared personal query/serializer enforce owner scope and internal-trace redaction. Added a separate gateway_my_usage_export permission and seeded it into the development database after confirming the chosen ID was free. No new table migration. Selected exports accept current string request IDs and explicitly cap selection at 5000; legacy numeric ID mapping remains pending.

Six focused personal-query/export cases pass: three formats decoded to the same fields/cells, XLS OLE signature, formula-text protection, selected IDs independent of date/model filters, foreign-ID omission, normal-user permission refusal, CSRF, default XLSX and invalid filters/selection. Full validation follows. UI export control, analytics/admin-query parity and historical migration remain open.

Validation found two integration issues beyond the focused export tests: missing export-permission translations, then seed order placing the button before its parent. Added en-US/ja-JP labels and moved the child after the request-log parent. The latter explains why development incremental seed passed while clean bootstrap failed. Full checks are being rerun after both corrections.

Typecheck, final full API 1154 passed (2 skipped, 36 TODO), web 64 passed, build and gateway gate 946 passed (36 TODO; clean migration/bootstrap included). The final rerun follows fixes for missing menu translations and parent-before-child RBAC ordering. Development incremental seed was applied and the 10041/gateway_my_usage_export/button/1004 row was inspected. git diff --check passes. Logs: /tmp/coati-usage-export-{focused,seed,typecheck,tests-fixed,build,gate}.log; earlier failed full runs are tests.log and tests-final.log. No table schema change, live supplier traffic, production writes, commit or publication.


## Personal usage console — 2026-09-26

Applied ui-craft as a focused query-list workflow. Added /agent/my-usage inside the authenticated layout and an entry in the user menu, independently of administrator request-log permissions. The page offers days/model/PAT/status filters, page-scoped selection, safe details, retry/reset/refresh and permission-gated CSV/XLSX/XLS export with field selection. Export uses applied filters, not unsubmitted edits; selection clears on page/filter/reload, and stale responses cannot overwrite newer queries. Added English/Japanese copy. Four component tests cover request parameters, safe details, applied-filter versus selected export, permission/error/retry and stale response suppression.

Browser evidence: existing local admin session at localhost:5175; 1280x720 list with a disposable, revoked fixture key and one synthetic usage row; 390x844 filter/table/export-dialog layout. Fixed initially inline numeric labels to align with other labels. Selected CSV submit closed the modal without error, but the in-app browser download event timed out, so OS file-save acceptance is not claimed. Download payloads are covered by preceding API format tests; component tests check the Blob download handoff. Fixture rows were deleted, viewport reset and temporary tab closed. User-menu entry was visibly present. Whole-suite import integrity caught one relative fields import and it was changed to the project alias. Scoped UI lint found synchronous effect state resets; moved them into user-action handlers, then lint passed. Full validation follows.

Typecheck, final API 1154 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 946 passed (36 TODO; clean migration/bootstrap included). Scoped frontend lint and git diff --check pass. Logs: /tmp/coati-mine-ui-{focused,lint,typecheck,tests-final,build,gate}.log; initial whole-suite failure is tests.log (relative import). No schema change, supplier traffic, production writes, commit or publication.


## Personal usage analytics migration — 2026-09-26

Implemented the personal analytics endpoint: Python-aligned summary, latency interpolation/truncation, local hour/day trend buckets, top-eight model breakdown with full-scope denominator, owner-only PAT/model options, and existing daily quota. Reused personal filter parsing. Added nullable cache totals with reported-request counts as explicit coverage metadata. Aggregation/option reads share a read-only repeatable-read transaction; quota remains a separate current read.

Three focused DB/handler cases pass for billable partials versus nonbillable failures, reservations, latency, cross-model drilldown, empty/invalid filters, full denominator above eight models and ordinary-user ownership/option isolation. Initial typecheck corrected Drizzle transaction configuration from readOnly to accessMode; initial SQL grouping failed because repeated parameterized bucket expressions do not match in PostgreSQL GROUP BY, fixed by grouping selected bucket columns. Added six local-bucket cases for offset/fold behavior; Python ZoneInfo was executed independently for New York overlap/gap and Lord Howe overlap, confirming expected offsets. Full validation follows. UI visualization, administrator statistics and historical import remain open.

Typecheck, full API 1162 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 954 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-analytics-{focused,typecheck,tests,build,gate}.log. No schema change, supplier traffic, production writes, commit or publication.


## Administrator usage analytics migration — 2026-09-26

Added the legacy administrator analytics route under session/RBAC, reusing summary/trend/model aggregation through explicit admin versus personal scopes. Added user_id validation, cross-user billable-token ranking, full-window user/model filter options and configured default quota. The model denominator/drilldown behavior remains shared with personal analytics. No schema or permission-seed changes: the route requires existing gateway_requests; old agent_usage mapping remains a data-import task.

Four focused analytics/owner-isolation cases pass. Extended the two-user fixture to verify global totals/ranking, user/PAT narrowing, global options under user filtering, ordinary-user 403 and unchanged personal isolation. A new case covers invalid/missing user filters and session/bearer-only 401 responses. Initial editing left an unterminated SQL template literal; fixed before passing typecheck/focused tests. Full validation follows. Administrator record-list parity, analytics presentation and historical data migration remain open.

Typecheck, full API 1163 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 955 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-admin-analytics-{focused,typecheck,tests,build,gate}.log. No schema change, supplier traffic, production writes, commit or publication.


## Administrator usage record query — 2026-09-26

Added the legacy administrator record-list path under session/gateway_requests permission. Shared the query and safe common serializer with personal/PAT lists through explicit admin/personal scope; admin adds owner/PAT identifiers, username, last recorded attempt account/name and stored diagnostic error. Supports user/PAT/model/status/time filters and pagination. Does not expose keys, secrets or raw payloads.

Four focused cases pass: extended the multi-user fixture for global/user-filtered lists and normal-user 403; added list diagnostics, personal redaction regression, cache zero/null, pagination/time/status/model filters, malformed filters and bearer-only refusal. This is intentionally recorded as incomplete field parity: immutable route/upstream-model/provider provenance is not present, so corresponding fields return null. Required next work includes new-execution provenance, legacy history mapping and remaining usage/quota presentation. Full validation follows.

Typecheck, full API 1164 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 956 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-admin-usage-{focused,typecheck,tests,build,gate}.log. No schema change, supplier traffic, production writes, commit or publication.


## Execution target snapshots — 2026-09-26

Migration 0020 adds nullable JSONB execution snapshots to requests and attempts. After acquiring fresh route/account configuration and preparing the actual payload, the service persists route ID, account ID/name, wire model and protocol before transport I/O. Each recorded attempt retains its own target; the request retains the last selected target. Persistence failure aborts before supplier traffic and settlement releases the reservation/lease. No secrets, URL or raw payload are included. This is target provenance, not a success assertion.

Tests cover preserved account/model values after configuration rename, null historical snapshots, retry-specific route IDs/final target, actual vision/text model selection, native SSE snapshots and persistence fault cleanup. Initial fault injection targeted an unused service instance and returned 200; corrected the spy to the repository prototype used by HTTP handlers before the focused run passed. Existing personal serializers remain allowlisted. route_name/provider are still unmodeled and null; legacy import/parent-child lineage remain separate work.

Development database was recorded at 0019 (20 ledger rows, max 1790355012820), then actually upgraded to 0020 (21 rows, max 1790364888852); both JSONB columns were queried in information_schema. Apply the additive migration before API rollout; older API rollback may retain the columns. This does not constitute deployed backup/restore or rollback acceptance. Full validation follows.

Typecheck, full API 1165 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 957 passed (36 TODO; migration-chain and empty bootstrap included). Development/test are at 0020, 21 ledger rows/max 1790364888852. git diff --check passes. Logs: /tmp/coati-execution-{focused,typecheck,migrate,tests,build,gate}.log. No live supplier traffic, production writes, commit or publication.


## Provider classification and route display provenance — 2026-09-26

Python source verification (model/__init__.py, crud/usage.py related_context) establishes provider as classification independent of upstream_protocol and route_name as the route model_name. Corrected the earlier assumption that a separate route-name configuration was required. Node now snapshots route.model as route_name and account provider; old execution JSON remains valid and absent fields return null without consulting current configuration.

Migration 0021 adds gw_upstreams.provider with the neutral openai-compatible default. API validates trimmed nonempty length <=64; omission on update preserves classification and omission on create uses the default. Request serialization/authentication still depends only on protocol. The existing model-service form/list adds classification plus explanatory copy and en/ja translations, using the existing components and layout (ui-craft local change).

A new DB/HTTP test checks default, custom trim, omission preservation, invalid input and transport independence; the admin-history case now verifies provider/alias remain stable after renaming and null legacy snapshots. Browser on localhost:5175 with existing admin session at 1280x720 verified empty-list column, create-form default/help text and scroll reachability of lower fields/fixed footer. No form submitted; no browser persistence or mobile acceptance claimed; temporary tab closed.

Development database before upgrade: 0020, 21 ledger rows/max 1790364888852. Ran db:migrate to 0021, 22 rows/max 1790365215151, then inspected provider text/not-null/default in information_schema. Additive migration must precede API rollout; previous API can leave column in place. Deployed rollback/backup testing remains open. Full validation follows.

Typecheck, full API 1166 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 958 passed (36 TODO; migration-chain and empty bootstrap included). Development/test are at 0021, 22 ledger rows/max 1790365215151. git diff --check passes. Logs: /tmp/coati-provider-{focused,typecheck,migrate,tests,build,gate}.log. No live supplier traffic, production writes, commit or publication.


## Legacy administrator quota query and editing — 2026-09-26

Implemented the two quota endpoints, searchable/paginated user list, settled business-day usage, default/override fields, dedicated write permission/CSRF and non-destructive restoration to inheritance. Daily-only updates preserve RPM and concurrency fields. Migration 0022 adds nullable quota update timestamps; unknown existing times are not backfilled. Existing full-limit updates also record the timestamp. Responses normalize recorded timestamps to UTC ISO.

Two focused cases (new quota flow plus extended normal-user isolation) pass: exhausted quota immediately rejects, zero admits, null/empty inherits, custom default summary, search/pagination/clamp, malformed payload/user, missing CSRF, bearer refusal and normal-user read/write refusal. The later UTC timestamp assertion is included in full validation. This is API/DB evidence; dedicated quota presentation, permission-code import mapping and historical data acceptance remain open.

Development DB upgraded from 0021 (22 rows/max 1790365215151) to 0022 (23/max 1790365482451); timestamp column inspected. Initial seed invocation omitted --incremental and entered full-rebuild mode; foreign-key rejection caused the encompassing transaction to roll back (transaction code inspected; existing user_roles=1 and role_menus=48 remained). Corrected to incremental synchronization; verified 10042/gateway_requests_quota_edit/1004. The failed chain did not start tests; full validation was then started after incremental sync. Logs preserve both seed attempts. No production database involved.

Typecheck, full API 1167 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 959 passed (36 TODO; migration-chain and clean bootstrap included). Development/test are at 0022 (23 ledger rows/max 1790365482451). git diff --check passes. Logs: /tmp/coati-quotas-{focused,typecheck,migrate,seed,seed-incremental,tests,build,gate}.log. No supplier traffic, production writes, commit or publication.


## Administrator quota console — 2026-09-26

Added User quotas alongside Requests using the existing table/dialog components. Search, paging, effective/default/source/billed/remaining values and exhausted state connect to the legacy list. Edit action requires the dedicated quota permission, offers inheritance/unlimited/positive cap and writes only daily_token_quota. Save failures preserve input; busy guard prevents duplicate writes; current-query refresh and stale-fetch cleanup protect the displayed list. Existing ui-craft local layout conventions are retained.

Five component cases pass (read permission/search, validation/failure retry, two distinct zero/null modes, error refresh/stale response). Scoped new-component lint and typecheck pass. Browser: localhost:5175 with existing admin, 1280x720 and 390x844; tab navigation, current inherited default, dialog modes/positive input and narrow layout inspected. Responsive shell remounted the page on viewport switch, so reopened quota tab before mobile inspection. No production or local quota was changed through the browser. Restored viewport and closed temporary tab. Ordinary-account browser, successful-save browser and failed-save browser remain component/API evidence only.

Initial whole-suite frontend locale scan found missing Remaining quota/Available translations; added both en/ja entries before rerunning. The failed pnpm test stopped the first chain before build/gate; no Vitest processes remained before the final sequential run. Full validation follows.

Typecheck, final full API 1167 passed (2 skipped, 36 TODO), web 73 passed, build and gateway gate 959 passed (36 TODO; migration-chain/clean bootstrap included). New Quotas component scoped lint and git diff --check pass. Logs: /tmp/coati-quota-ui-{focused,lint,typecheck,tests,tests-final,build,gate}.log; tests.log contains the corrected locale failure. No schema change, supplier traffic, user-quota mutation, production writes, commit or publication.


## Administrator request-log console migration — 2026-09-26

Requests now uses the legacy administrator list with submitted days/model/user/PAT/status filters and paging. Default explicitly labels finished requests; reserved requests are available through the in-progress filter. Node interrupted status is accepted by the shared filter schema. List includes user/PAT/account; query refresh invalidates pending detail opens and stale query responses cannot replace newer data.

Added session/gateway_requests-protected GET /api/admin/gateway/requests/:id (UUID, 404 absent) to load the complete existing Node ledger only on inspection. Detail loading fetches that row plus attempts together, retaining full cache TTL/reasoning/raw-usage fields without adding raw payloads to the compatibility list. Details show immutable route/account/provider/wire model, and prefer snapshot upstream protocol. Attempt rows display their own targets. The existing administrator-only native list already exposes the same ledger shape; this does not widen personal access.

Three component tests cover submitted filters and full detail, failed detail retry, obsolete-response suppression; two focused API cases cover detailed counters/provenance, missing/malformed IDs, bearer-only rejection and ordinary-user forbidden access. Scoped Requests lint passes. Browser: existing admin at localhost:5175, 1280x720 with a disposable revoked key and synthetic completed request, no supplier call. List/filters and side-sheet provenance/cache zero-versus-null inspected. Snapshot protocol precedence was corrected after initial inspection and verified after reload; an added component assertion checks it too. Fixture request/key removed transactionally and zero remaining marker keys verified. Tab closed. Narrow layout, interactive filter submission and failure states are component evidence only in this stage.

Typecheck, full API 1168 passed (2 skipped, 36 TODO), web 76 passed, build and gateway gate 960 passed (36 TODO; migration-chain/bootstrap included). After protocol precedence correction, three focused web cases passed; after adding interrupted-filter evidence, one focused API case passed. Scoped Requests lint and git diff --check pass. Logs: /tmp/coati-admin-log-{typecheck,api-focused,api-final,web-focused,web-final,lint,tests,build,gate}.log. No schema change, supplier traffic, production writes, commit or publication.


## Personal and administrator analytics console — 2026-09-26

Added a shared analytics view to personal usage and administrator Requests tabs, with separate endpoints/scopes. Submitted day/model/status plus personal PAT or administrator user/PAT filters drive requests. Personal requests strip user_id and never render user ranking. Model/PAT/user options come from authorized API responses; selected values remain visible if later absent from options. Loading hides old aggregates, failed loads show retryable errors, and stale responses are ignored.

Display includes request/token/success/latency/active-model summaries, daily personal quota, ECharts token/request trend with explicit axes and gateway-offset bucket labels, an expandable trend data table, nullable cache totals and reported-request counts, top-eight model shares with denominator/filter caveat, and administrator user ranking. Missing time buckets are not invented as zeros. Raw tooltips use richText; React escapes names. The chart supports the existing dark theme context and transparent background; dark-mode rendering was not browser-checked. Browser inspection moved the legend to the top to avoid the zoom slider and clarified the default status as finished requests.

Four component tests cover personal/admin scope/filter distinction, null/zero cache values, trend series, errors/empty data and stale response rejection. Initial JSX closure and unused-variable errors were fixed before focused tests/lint passed. The first full run found a missing personal Usage records translation; en/ja were added before the final passing run.

Browser: existing admin session, localhost:5175, administrator 1280x720 and personal 390x844. Used a disposable revoked key and three synthetic prior-day records; verified totals (3 requests, 72 tokens), local +08:00 buckets/tooltip, completed trend rendering, model distribution, cache zero with 3 reports versus unknown with 0 reports, and personal current-day quota. No supplier traffic. Restored viewport/closed tab; deleted all three fixture requests and key in a transaction, then verified zero marker keys. User-ranking section and scope-specific controls visible; normal-user browser access, dark mode, zoom manipulation and saved user preferences are not acceptance claims.

Typecheck, final API 1168 passed (2 skipped, 36 TODO), web 80 passed, build and gateway gate 960 passed (36 TODO; migration/bootstrap included). Scoped analytics lint and git diff --check pass. Logs: /tmp/coati-analytics-ui-{focused,lint,typecheck,tests,tests-final,build,gate}.log; tests.log records the corrected locale failure. No schema change, production writes, commit or publication.


## 路由覆盖与剩余账号池语义 — 2026-09-26

已补充路由说明与同源上游路径覆盖，保存及发送前均校验账号当前 origin；账号域名、协议或端口变化后，旧覆盖地址会阻断发送并释放租约/预算预留。未提供字段的更新保留原值，空字符串/null 清空。0023 为可空附加字段，不改变历史路由默认目标。

P2 仍未完成：Python 的公开模型唯一路由允许绑定账号或自动账号池，并有显式 fallback_enabled（默认关闭）、按实际上游模型回退、个人渠道优先与所有权约束。当前 Node 的多个候选路由不能直接视为这一语义。下一阶段需分离公开路由与账号候选关系，补齐绑定/未绑定/停用/回退开关/个人渠道矩阵、模型支持与 readiness、兼容管理接口及源 ID 映射；不得通过给每个候选加布尔标记就声明对齐。


## 账号模型声明基础 — 2026-09-26

已迁移账号 supported_models/default_model 的配置存储与管理表单；默认模型自动计入 API 返回的有效支持列表，显式空数组不代表通配，探测结果不会写入声明。更新省略字段保留旧值，空值可清除。0024 从当前 Node 路由实际模型/含图模型回填已配置支持列表（含停用路由，去重并去空白），不猜测默认模型。

这一步仅完成账号声明基础，现有候选路由运行逻辑尚未以支持列表筛选，不能宣称自动账号池或模型别名已实现。下一步需要在公开路由/账号候选结构调整时统一接入声明校验、实际模型匹配与租约获取前复核；空列表账号不得被自动池当作支持任意模型。随后迁移模型前缀、个人渠道、默认模型选择、模型画像/同步及兼容凭证接口。


## 账号声明接入显式路由执行 — 2026-09-26

上阶段配置声明现已参与路由保存和请求候选过滤。保存时检查实际/含图模型已被账号声明，生效路由不能绑定停用账号；默认模型计入支持范围，空列表不作通配。发送前在租约事务中持有最新账号/路由记录后再次检查声明，失效候选不发送、不计一次上游尝试，预算和租约按现有流程释放。初次无支持候选返回 422 unsupported_upstream_model，预留后全部候选失效返回 503。

这仍是现有显式候选路由的校验接入，不等于公开模型唯一配置、自动账号池、绑定账号 fallback_enabled 或个人渠道完成。后续池结构改造还需覆盖绑定亲和在账号声明/状态并发变化时重新选取与跨副本验证。


## 会话绑定动态失效重选 — 2026-09-26

租约事务现在重新读取绑定账号当前可用路由、冷却/启用状态和实际目标模型声明，而不只信任请求开始时的 eligible ID 快照。已失效绑定在 scope advisory lock 内按原账号 ID 删除，后续有效候选可以取得租约并重新绑定；健康绑定仍阻止其他候选抢占。五个 HTTP/真实隔离数据库用例覆盖预留后移除模型、停用账号、进入冷却、停用路由、移除含图目标，均只向替代账号发送一次并释放租约。原有双 repository 首写者并发用例继续通过。此证据不代表真实多进程/多副本压测完成。

P2 下一主项仍为公开路由/自动池结构与 Python fallback_enabled 语义，不能用当前显式候选的失效重选代替该功能。


## 公开路由与自动账号池运行核心 — 2026-09-26

0025 新增 gw_public_routes：每个公开模型唯一，可不绑定账号，或绑定账号并显式控制 fallback_enabled（默认关闭）。账号增加 priority（1–1000，默认 100），自动池按 Python 的高优先级优先，再用已有权重/负载选择；绑定主账号始终排在前面，绑定路由不使用会话亲和替代主账号。账号匹配使用实际上游模型/含图目标，回退账号只使用自身地址，不能继承主账号路径覆盖。租约事务重新读取公开配置和账号，预留后关闭回退会阻止备用账号发送。

新增原生 /api/admin/gateway/public-routes GET/POST/PUT/DELETE（现有路由 RBAC/CSRF），支持部分更新，删除需先停用。相同别名不能同时存在于公开路由与旧候选配置；两类写入共享模型 advisory lock，公开表另有唯一约束。已有 gw_routes 不被自动转换或删改，避免把旧候选列表误解释成 Python 的自动池范围。新执行快照含 route_kind 以区分公开/显式路由 ID；公开模型已进入模型发现列表。

已验证自动池、主账号优先、回退开关、主账号不可用、覆盖地址隔离、预留后开关变更、别名冲突、删除流程，以及九种协议组合的 JSON/SSE/缓存记账。自动池会话声明失效也能重选。仍待：控制台公开路由与账号优先级入口、旧候选配置显式迁移/冲突预检、Python routes_admin 兼容列表/摘要/readiness 与字段格式、个人渠道/模型前缀、账号错误惩罚窗口与配置化尝试数/环境回退等完整 P2 对齐。此处只完成公开池运行核心，不标记 P2 全部完成。


## 公开路由管理控制台 — 2026-09-26

模型与路由页面默认展示公开路由，原有候选配置放在独立标签页并继续生效。公开路由支持搜索/分页、创建/编辑、启停与停用后确认删除；自动池为默认选择，绑定后展示回退与同源地址覆盖，切回自动池时提交清除隐藏的绑定专属配置。表单显示账号支持模型并校验 coati-auto 实际模型、必填与长度；保存失败保留输入。账号列表读取失败时仍可查看公开路由、配置自动池，但禁用账号选择。写操作按原路由按钮权限控制，列表忽略过期响应。模型服务新增账号优先级输入/列（1–1000，默认100）。

已完成本地浏览器 1280×720/390×844 的空态、绑定/自动模式、表格横向滚动与长表单底部可达性检查；六项组件测试覆盖提交与错误/权限分支。浏览器未实际保存/删除配置，保存删除为组件/API 证据。旧配置迁移预检与 Python 兼容列表/摘要/readiness、个人渠道仍未完成。


## 旧候选配置迁移预检 — 2026-09-26

新增只读 GET /api/admin/gateway/route-migration/preflight，要求 gateway_routes 菜单权限。在 repeatable-read/read-only 事务中读取旧候选、无凭证的账号配置和公开路由，按公开模型输出 ready_for_review、manual_review 或 blocked。单候选建议保留绑定并关闭自动回退；多候选明确提示顺序/重试、实际模型/含图目标、独立覆盖路径及自动池范围扩张的差异，不自动合并。已有别名冲突、无效字段、失效绑定、未声明模型和非法覆盖地址阻止建议生成。

每项包含配置指纹，用于后续提交时重新比对；指纹不含账号密钥或临时健康/冷却状态。当前接口不写入、不归档、不切换路由，ready_for_review 仅表示可供复核的建议，不代表已经迁移。控制台入口、事务内重验与提交、归档/ID 映射及回滚仍待实现，P2/P6 不标记完成。


## 单候选迁移、归档与回滚 — 2026-09-26

0026 增加 gw_route_migrations，保留原候选完整配置/ID、公开路由结果/ID、操作者和回滚记录。原生 route-migration/apply 在短事务配置锁内重新计算预检并比对指纹；只应用 ready_for_review 单候选，自动回退仍关闭。归档、建立公开配置和移出旧活动表同事务完成。重复提交返回同一未变更结果；配置变化/锁超时返回409。history 提供记录；rollback 仅在公开配置未被修改/删除、旧名称和ID未占用时恢复原行，保留请求历史和记账。账号配置/凭证不由该回滚还原。

详见 [route-migration.md](route-migration.md)。已在隔离开发库和测试库应用至0026（27条迁移记录，max1790370687611）。控制台操作入口、多候选决策流程、Python数据导入与完整容器恢复仍待实现；不能据此标记P2/P6全量完成。


## 控制台路由迁移入口 — 2026-09-26

模型与路由新增“路由迁移”标签：预检结果按模型显示单候选可迁移、多候选需决策、配置阻塞；提供搜索、建议结果展开、确认提交及迁移记录/确认回滚。读取预检和历史独立处理失败，刷新/卸载忽略旧响应，重复操作受忙碌状态保护；gateway_routes_edit 控制写入口。成功后重新加载预检与历史，失败提示并保留确认框供取消复核。

六项组件测试覆盖提交载荷/确认取消、失败重试与回滚、只读权限/搜索、两类加载失败/空态、卸载旧响应。桌面1280×720和窄屏390×844检查了无数据、单候选、多候选差异、建议展开及确认框；浏览器未实际提交迁移/回滚（写入证据来自组件/API测试）。临时3条候选和1个无真实凭证的停用账号已清理并核验0残留。多候选策略选择、Python兼容管理接口和个人渠道等原目标仍待推进。


## Python 路由管理列表契约 — 2026-09-26

新增 GET /api/admin/agent/routes，读取公开路由而不是 Node旧候选行。保留 model_name/credential_id 等旧字段、绑定账号安全摘要、协议名称映射、effective_model/effective_base、selection_mode、readiness/warnings 与 usage_7d；分页默认20且最多100，支持搜索公开/实际模型、启停、provider、credential_id。include_summary 汇总全部路由，独立于列表筛选；自动池未绑定账号时按旧版返回ready，不冒充运行探测成功。权限映射为当前gateway_routes，拒绝PAT代替管理会话。

七日统计按公开模型汇总，排除reserved，失败请求计入次数而非全部计入Token；Node扩展终态沿用当前计费定义。无用量返回0/0/null。0027新增updated_at：旧行保持null（没有可靠的历史更新时间），新行默认数据库时间，原生编辑更新该字段。开发/测试库已升级至28条记录/max1790371770471。

旧路径POST/PUT/DELETE的输入规范及错误文案、Python凭证映射/个人渠道和完整数据导入仍待迁移；此处不以GET覆盖宣称四个接口全部完成。


## Python 路由写入接口 — 2026-09-26

已增加 /api/admin/agent/routes 的 POST、PUT/:id、DELETE/:id，映射到现有公开路由表及 gateway_routes_add/edit/delete 权限，不生成第二套路由数据。兼容 model_name/credential_id 字段、空文本归null、字符串布尔/账号ID、默认值、部分更新及未知字段忽略；写响应只返回旧route.to_dict字段，删除返回{ok:true}。保留缺失账号400、重复模型409、自动路由缺实际模型422、停用账号/不支持显式目标422、启用中删除409及不存在404等语义。

未显式给出实际模型时，旧版允许绑定后由readiness报告警告；兼容写入保留该行为，不复用原生保存的更严格隐式目标校验。地址覆盖需绑定账号及同源，继续执行当前网络/凭证URL防护。对象/数组作为文本字段返回400，而非复制Python的容器字符串化；这是显式校验边界。账号个人归属/模型映射/供应商可用性等尚未落到完整凭证模型的逻辑仍待后续，不将四路径可用视为P2全验收。


## 非便携控制参数与 Responses 会话状态 — 2026-09-26

补齐跨协议 logit_bias/container 拒绝和 Responses conversation 状态引用防护。原生 Chat/Messages 保留对应控制参数；Responses 原生也遵守无状态策略，不能把状态请求当成成功的无状态调用。新增 54 项矩阵用例覆盖 JSON/SSE、原生转发、转换拒绝、零计费/零上游副作用及 null/false 默认值；全量验证结果见 validation.md。未关闭其余 36 项协议矩阵 TODO，未增加真实供应商支持声明。


## 个人渠道归属与平台隔离基础 — 2026-09-26

新增 0028 账号 scope/owner/model_prefix 约束和索引；平台账号列表、管理写入、路由绑定、候选、模型目录、迁移预检和探活均排除个人账号，发送前重新验证归属。五项隔离测试覆盖平台接口 ID 猜测、池隔离、非法历史引用、选路后归属变化和数据库约束。本人 API/模型目录/选路/控制台尚待实现，不能视为个人渠道迁移完成；具体契约见 personal-channel-migration.md。


## 个人模型目录与网关执行 — 2026-09-26

按令牌所有者解析个人模型前缀，接入现有矩阵转换、配额、租约和结算流程。平台与个人候选保持隔离，个人匹配池冷却不转用同名平台路由；发送前重新核对归属/模型，快照区分 personal 来源。26 项专项测试覆盖全部三协议普通/流式工具往返、缓存用量、双用户同名与会话隔离、失败重试、授权和配额。本人管理 API/探活/控制台仍待补齐，全量结果见 validation.md。


## 本人渠道管理 API 与历史保留 — 2026-09-26

新增 Node 本人渠道列表/创建/局部编辑/删除，独立权限、会话/CSRF、数据库事务所有权隔离与并发五条上限。新增 0029 使删除渠道保留尝试记录与不可变执行快照；在途租约和路由引用阻止删除。12 项专项用例通过。已在开发库/测试库应用迁移并增量同步开发 RBAC；管理页面未开放，旧字段/路径兼容、探活、发现和控制台继续待办。全量结果见 validation.md。


## 个人渠道模型发现与检查 — 2026-09-26

补齐本人模型发现、手动检查、创建后探活和安全诊断字段。保存凭证不能覆盖目标/协议；草稿使用显式新密钥；检查采用带所有权的数据库认领和陈旧结果隔离，创建探测失败保留配置。新增8项验证并扩展双管理员拒绝场景，与 CRUD 合计20项专项通过。个人后台恢复探测、旧版字段/路径及控制台仍待完成；全量结果见 validation.md。


## 个人渠道后台恢复探测 — 2026-09-26

后台恢复队列现纳入个人账号并携带所有者重新认领，保持平台管理接口隔离、共享每批五条上限与十分钟静默期。四项 PostgreSQL/模拟 HTTP 验证覆盖跨服务实例单次探测、解除冷却、批次/停用/静默边界、Messages 未验证和归属变化零调用。真实多进程与部署故障演练仍属 P7；完整个人管理旧字段/路径和控制台尚待完成。


## 账号备注与自定义请求头 — 2026-09-26

新增0030 extra_headers/note，接通平台与个人管理、九组合 JSON/SSE 发送、保存/草稿模型发现、手动/后台探测；健康回写比较头配置，错误诊断脱敏自定义头值。31项初始专项通过，并追加平台管理保留字段/实际发送测试进入全量回归。开发/测试库已实际迁移。旧字段/路径/目录、代理、账号超时与控制台仍待完成；结果见 validation.md。

## 账号级请求超时 — 2026-09-26

新增0031 request_timeout_seconds，默认120秒、范围5–300秒；平台和个人管理、模型调用、发现与探测使用账号配置，编辑保留省略值并阻止旧探测回写。真实HTTP验证等待响应头、响应体停顿、持续传输、连接池账号隔离及取消；网关链路验证504/流内错误和资源释放。全局180秒请求期限、10秒连接上限及30秒发现上限仍有效。控制台、旧字段兼容与其他剩余项继续待办；完整检查结果见 validation.md。

## 账号出站代理 — 2026-09-26

新增0032加密代理地址与脱敏提示，平台/个人配置、模型调用、保存/草稿发现和探测接通代理。实际传输固定目标及代理DNS结果，CONNECT保留目标Host/TLS身份，认证信息不作为上游头发送；操作日志与错误路径脱敏。每请求独立代理连接，随响应完成/取消回收，不自动转直连。代理服务器需支持CONNECT；真实HTTPS代理及部署环境验收继续属于发布门禁。原生API已接入，控制台与旧接口完整字段兼容尚待完成。

代理迁移仍有一个明确兼容缺口：Python对HTTP目标使用代理绝对URI转发，当前Node实现统一使用CONNECT。需补齐只支持HTTP转发的代理路径，同时保持目标地址固定与认证隔离；不能将要求所有代理支持CONNECT视为最终等价迁移。

## HTTP转发代理兼容与本地TLS验收 — 2026-09-26

已补HTTP绝对URI转发，HTTPS继续CONNECT；两种方式固定目标IP并保留Host，代理连接也固定经校验的IP。此前“所有代理必须支持CONNECT”的限制已解除：HTTP目标可使用仅转发代理。新增本地TLS组合测试覆盖HTTP代理→HTTPS目标、HTTPS代理→HTTP/HTTPS目标，以及代理/目标证书名称不匹配和不可信证书拒绝。测试证书仅在隔离测试进程信任，不修改系统或Codex配置；真实部署与供应商验收仍单独待办。

## 供应商与上游协议目录兼容 — 2026-09-26

迁移平台及个人目录的8个原生/旧路径，保留Python目录顺序与字段；Node协议目录额外返回内部协议映射，Gemini预留与Messages发现不验证健康语义保持不变。11项专项覆盖源文件哈希、返回契约、匿名/无权限拒绝及个人权限不扩展到平台目录。旧账号CRUD/列表字段兼容及个人页面仍未完成。

目录迁移同时修正实际端点拼接：Messages根地址补/v1/messages，已有/v1补/messages，三协议完整端点不再重复追加路径。16项真实HTTP普通/流式测试通过，确保目录默认值和执行路径一致。

## 账号元数据与列表摘要基础 — 2026-09-26

0033补密钥提示/指纹和更新、使用、检查、成功、失败时间及延迟。新建/替换密钥计算真实元数据，普通编辑保留；旧记录未知值不伪造回填。发送前执行快照与使用时间同事务，健康/探测元数据沿用配置及时间防陈旧回写；个人创建返回探测后的当前记录。平台与个人原生列表增加按归属、独立于筛选的健康摘要。7项专项通过；旧路径CRUD/字段适配、历史凭证受控回填和个人页面仍待完成。

## 旧版平台账号与个人渠道列表 — 2026-09-26

已接入旧路径 GET credentials/my-channels，保留字段白名单、旧协议名称、默认模型、脱敏提示、可空历史时间及微秒精度。搜索覆盖名称/旧协议/默认模型，支持启停、协议、供应商和健康筛选；ID倒序分页，摘要独立于筛选。平台与个人归属在数据库条件中固定，超级管理员的个人列表仍仅返回本人，查询参数不能越权。6项真实数据库/API测试通过，首次测试发现非UTC数据库时间字符串的微秒丢失，已修正。旧写入/复制/检查/发现兼容和个人控制台仍待完成，全量门禁结果见validation.md。

## 账号管理 API 模块收口 — 2026-09-26

旧平台账号及个人渠道的新增、局部编辑、删除、发现、检查已接入，平台复制与批量探活同时补齐。保存保持加密和所有权隔离；创建探活失败保留账号；复制重置运行状态；删除检查停用、路由引用、探测和在途租约。平台批量操作不跨入个人账号，停用账号手动探测保持Node现有409约束。按用户最新要求采用模块交付与针对性验证，未重跑全量测试。当前完成账号管理后端接口，个人渠道页面和控制台新增字段仍待接入；不再以自动长期目标续跑。

## 模型能力档案 — 2026-09-26

已完成0034档案表、原生/旧管理路径、覆盖值清空、保留手动值的目录导入、模型候选、RBAC和控制台。模型列表新增上下文与最大输出上限，支持别名保守映射及个人模型优先级。按不用LiteLLM的决定不自动联网同步，目录采用显式导入；数据来源和默认值明确展示。开发/测试/全新隔离库均迁移至0034。详细契约见model-profiles.md；缓存验证、旧数据导入与bootstrap压缩扩展仍待完成。本次采用少量核心工作流验证，未重跑全量套件。

## 缓存验证功能 — 2026-09-26

已实现原生/旧路径别名、本人记录分页/详情/删除、可用令牌与模型选择、最多五轮相同请求、正常网关授权/路由/配额/日志链路，以及缓存未知/真实零/派生未命中和账号切换提示。控制台入口/gateway/cache-tests已增量播种。0035在开发/测试/新库安装验证通过。测试仅接本机模拟HTTP上游，无真实供应商调用。Node显式要求key_id；旧Python逐字段响应兼容及历史记录导入仍待数据与接口收口，详见cache-tests.md。下一项为服务端搜索/抓取与工具治理迁移。

## 服务端工具第一步：独立搜索/抓取适配层 — 2026-09-26

迁移Tavily search/extract客户端，复用受控出站传输；用户网页URL只交给供应商，网关不直接访问。补结果去重、域名边界、正文/响应大小上限、取消超时与安全错误。三项本地HTTP专项通过，未调用实际供应商。当前仅底层适配器，尚未接配置页、web-search公开接口、工具多轮、审计和额度，不能标为P5完成；下一步按server-tools.md接入配置及治理。


## 搜索服务管理配置 — 2026-09-26

已完成0036单行配置、逐字段环境回退、加密密钥和代理、保留/显式清除/恢复语义、原生与旧管理路径、权限、连接检查与控制台。开发/测试库和全新隔离安装均迁移通过，开发RBAC已增量同步。两项数据库/本地HTTP工作流验证配置生命周期和权限边界；无真实外部调用。公开搜索接口、授权额度审计、模型委托与多轮JSON/SSE工具执行仍待完成，P5未完成。

## Direct search API governance - 2026-09-26

Native and legacy search routes now enforce chat/model permissions and share existing owner/key atomic budgets, RPM and concurrency limits. Requests record estimated usage, provider attempt/result counts, failure/cancellation and request IDs. Results are bounded by the output reservation. Four local-HTTP/test-DB workflows passed; no real supplier calls or new schema. Missing/failed-provider model fallback, multi-round tool lineage and JSON/SSE orchestration remain pending.

## Master-key rotation and durable cache verification - 2026-09-26

Offline master-key rotation is implemented with default dry-run, transactional re-encryption of all gateway encrypted fields, bounded historical read keys and a production-image CLI. See credential-rotation.md. No actual deployed key/configuration was changed. Cache verification now persists running records and each round, protects active records from deletion and recovers stale records without replaying model requests. Four cache workflows and one rotation workflow pass against the isolated database. Python account passwords already use the PBKDF2 format supported by Node; no extra password algorithm was introduced.

Still open: model-delegated search/fetch fallback; multi-round server-tool JSON/SSE execution and attribution; full Python data export/import with ID/permission/history reconciliation; remaining legacy field/bootstrap parity; final SDK/replica/load/real-provider acceptance and publication. The original stage checkboxes are not a current completion count; dated entries record delivered slices.

## Delegated search, tool loop and offline migration - 2026-09-26

Implemented explicit web-search route delegation through native Responses/Messages, bounded cross-protocol server-tool loop with per-round accounting, native-path preference, cache aggregation, Messages JSON/SSE results, and encrypted read-only legacy export plus transactional fresh-database import.0037 journals checksums/counts/ID maps; identical imports are no-ops. New-database migration and source-format crypto fixture checks passed. See server-tools.md and legacy-data-migration.md for exact limits. Remaining gaps include native refusal fallback, full path filters/source presentation/all matrix tool cases, incremental multi-round streaming, deployment defaults and reverse migration reconciliation, plus release acceptance.


## 功能收尾前的roadmap快照（2026-09-26）

# Coati Node 当前交付状态

> 当前迁移行为状态以 [Python → Node 行为对照账本](behavior-parity.md) 为准。本文的已开发/历史阶段结论不等同于行为完全一致。

更新时间：2026-09-26。此文件取代旧版不断追加的待办；历史过程保留在 [progress-history.md](progress-history.md)。工作位于 `codex/node-gateway`，尚未提交或发布本批工作。

最新进展：[连续代码审计](code-audit.md#连续审计与页面收尾2026-09-26)修复缓存详情乱序/空页、重复提交、旧列表覆盖及工具循环协议和父子记录。62项前端、23项后端定向检查通过，API类型、静态门禁和工作区构建通过。最后列表改动另复查受影响12项，未重复全量或新增付费负载。

当前行为账本48项：29项限定一致、8项明确差异、11项待完整等价核实。T04部分用量累加差异已明确登记。页面已实现与双端全角色验收是两种状态；后者仍未完成，不因这次审计批量改成一致。具体范围及外部条件见代码审计记录末节。早期分批记录保留为历史证据。

## 产品范围

Coati 企业级模型网关与管理控制台；castor-kit 基础，Fastify/TypeScript/Drizzle/PostgreSQL + React/shadcn。自行实现 Chat Completions、Responses、Messages 的双向矩阵，不使用 LiteLLM/pi-ai。保留缓存缺失与真实零的区别。desktop、CLI、Agent 插件、运行环境安装器与公司服务不进入开源范围。Python `portal/` 保持不变用于对照；Node 使用独立数据库。

## 已落地的开发能力

- [x] 三协议九组合 JSON/SSE、工具多轮与并行、图片、推理/签名、结构化输出与能力拒绝策略。
- [x] 公开模型路由、显式候选、自动账号池、个人渠道、模型前缀、发现/检查、权重/优先级、会话亲和、并发租约、冷却与恢复探测。
- [x] 自定义请求头、账号超时、加密代理、HTTP 转发/HTTPS CONNECT，以及平台与个人出站策略隔离。
- [x] 用户/令牌共享预算、RPM/并发、预留/结算/恢复、令牌范围、生命周期、设备授权与跨实例共享限流。
- [x] 普通/缓存读取/写入/期限/未命中/推理用量、原始上游用量、估算标记、请求与尝试追踪、个人/管理员统计及导出。
- [x] 控制台账号、渠道、路由、模型能力档案、额度、缓存验证与搜索配置；翻译和导入路径问题已修复。
- [x] 缓存验证逐轮持久化、异常中断恢复、账号切换提示、历史记录导入后的字段适配。
- [x] Tavily 搜索/抓取、直接搜索 API、原生模型委托、原生工具优先、明确拒绝后的函数工具回退、受限多轮执行与父子记账。
- [x] 工具域名/路径过滤、跳转结果复查、取消、超时、次数/体积上限；JSON/SSE 保留真实搜索和抓取证据。
- [x] 离线主密钥轮换、历史读取密钥、事务重加密、默认 dry-run 和操作说明。
- [x] Python 数据只读加密导出、新库 dry-run/事务导入、密码和 PAT 摘要兼容、权限映射、源 ID/数量登记、幂等重跑及失败回滚。
- [x] 0041 迁移已应用开发/测试库；全新数据库安装验证通过，合计 42 个迁移。
- [x] 容器安装、控制台、健康、备份恢复与幂等重启；CI 接入同一检查，避免重复运行网关测试。
- [x] 官方 OpenAI 7.23.0 / Anthropic 0.128.0 SDK 通过真实本地网关端口调用三入口的 JSON/SSE。上游为本地模拟服务。

## 页面完整性复核

旧版统计页面存在遗漏，本轮重新对照后补齐，详见 [逐项复核](feature-parity-review.md)。以上开发能力勾选不代表所有页面或供应商验收完成。

## 本轮审查收尾

- [x] 补齐旧缓存接口字段，修复会话身份/改密失效、工具转换校验与结算、上游错误包识别、父请求关联和导入预检查。详见 [代码审查记录](code-audit.md)。
- [x] 复用现有集成用例作定向验证；未新增大批测试、未反复跑全量。

## 已明确的边界

- Responses 默认按 Python 强制 store:false，拒绝非空 previous_response_id；background/conversation 在原生路径透传，strict 可选提前拒绝。网关不提供存储、响应查询或跨请求续接，供应商是否接受后台参数由其决定。
- Messages服务端工具先完成循环再输出缓冲SSE；Responses原生工具保留实时SSE。Chat/Responses 无统一抓取结果结构时以明确标注的文本保留真实结果，不伪造原生引用。
- 模型委托优先使用 `web-search` / `web-fetch` 路由；没有显式配置时从平台原生能力账号池选择，DeepSeek 使用旧版已知的同源 Messages 路径。停用配置不被绕过。直接搜索要求 web-search 授权；内部工具子请求继承原模型授权，并验证同一令牌的真实父记录。
- 缓存验证默认按当前用户身份和用户预算执行，也可显式选择本人令牌；内部身份不可作为Bearer登录。见 [cache-tests.md](cache-tests.md)。
- 外部模型目录采用已核验数据显式导入，不依赖 LiteLLM 的自动目录同步。
- 历史数据只导入空的新 Node 库。未映射普通角色权限会中止；不能推断成管理员权限。上线后新增 Node 数据没有自动逆向导回 Python 的工具。

## 尚未完成的发布验收

- [ ] 使用指定的真实供应商/账号验证其工具、推理签名、缓存命中和费用行为。本轮真实文本矩阵 18 次、搜索 6 次、图片 6 次及配额拒绝通过；30 分钟、2 并发持续验收完成：180/180 成功、缓存读取占输入 93.45%、逐次记账一致，签名跨供应商与账单金额仍待验收，详见 live-acceptance.md。
- [ ] 真实来源数据库的权限、数量、用量与登录迁移对账；目前通过的是隔离样本和新库演练。
- [ ] 长时间/跨进程故障负载、Python/Node 同条件性能比较与目标容量。本轮 30 分钟低并发真实任务已通过（见 live-acceptance.md），仍不代表跨进程故障负载、性能比较或生产容量完成。
- [x] 18项广义unsupported-field占位已用具体九组合JSON/SSE检查替换并通过；任意供应商扩展不在此验收承诺内。
- [ ] 本批源码提交/远端 CI、最终发布差异审查、合并、版本/镜像发布与生产切换。未因开发授权自动执行这些操作。

上述发布验收不应被标成“功能全部验收完成”。性能优化仍放在完整迁移验收之后。具体证据见 [validation.md](validation.md)，部署/恢复见 [deployment.md](deployment.md)，迁移见 [legacy-data-migration.md](legacy-data-migration.md)。

### 协议收尾第一轮（2026-09-26）

- 慢客户端现有证据已复核，18 个占位关闭；覆盖范围和 JSON/SSE 区别见 protocol-contract.md 的第一轮协议收尾章节。
- 修复若干显式采样/输出控制参数在桥接时静默消失，同协议透传保持。
- 此轮当时剩余18个unsupported-field占位；已在第六批以具体wire检查替换，见batch-6-acceptance.md。不等同于完整供应商、工具、图片或持久负载验收。

## 额度与授权行为修正（2026-09-26）

新建令牌默认不过期/零独立限额、过期预留不计费、最终上游HTTP状态保留已修复；已有配置不改。详见 [第一批验收](batch-1-acceptance.md)。错误包格式与预留TTL仍分别保留为S12/Q04差异。

## 错误体与模型预留收尾（2026-09-26）

S12普通最终HTTP错误包、Q04新模型请求预留默认值/配置和过期准入已对齐限定基准，298项定向检查通过。动态改TTL对旧记录、跨日及工具子请求仍未宣称等价。见 [第二批验收](batch-2-acceptance.md)。

## 健康调度收尾（2026-09-26）

S07/S08限定规则已对齐；主账号被备用账号优先级抢占的边界已修复。S06与S10仍未完成。见 [第三批验收](batch-3-acceptance.md)。

第六批继续补齐：模型服务列表协议/健康筛选与分页，搜索多查询解析和逐条预算，原生工具能力确认及Responses约束回退，工具尝试次数返回。证据和剩余边界见batch-6-acceptance.md。
