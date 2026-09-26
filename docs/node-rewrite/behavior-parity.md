# Python → Node 当前行为对照账本

更新：2026-09-26。本表是迁移行为状态的唯一汇总入口，roadmap 的“已开发”不再作为等价验收结论。基准是本仓 `portal/`，不包含 desktop、CLI、插件和公司内部发行服务。对照工作区有未提交修改，不能仅用 Git HEAD 代表本次源码。

**不能宣称完整等价迁移。** “一致”只覆盖该行明确描述的行为；证据栏区分本轮源码核实、隔离测试、历史报告、真实链路。其他状态：有差异=已找到两端行为不同；缺失=已找到旧行为且新入口没有对应实现；尚未核实=证据不足。未知项不会计入完成率。

默认按 Python 业务语义修复差异；新安全拒绝策略、计费策略和限制不能冒充等价。涉及凭证保护的实现细节不机械退回不安全写法，但其对外行为差异必须在本表保留。纯Node架构变化不等于业务差异已获批准。

## 当前计数

一致：29、有差异（实现边界已收尾）：7、已验收：8、暂缓：1、尚未核实：3，合计48项。三个未核实编号归入两项交付工作：真实历史数据迁移（D01/D02）和发布交付（D03）。S06由用户明确冻结。此表不是完成率。

“已验收”表示明确列出的业务契约已通过源码对照、隔离运行或页面检查，不宣称全部Python操作字节等价。“有差异”保留已完成实现的可见契约边界，不再与待开发混淆。最终范围与证据见[功能收尾验收](final-functional-acceptance.md)。

## 当前剩余工作

仅真实历史数据迁移与发布交付。候选路由冻结待未来重新设计；协议不可表达内容、探测显式启用等已固定边界见功能收尾验收，不再挂成无限期功能待办。下方历史批次中的未完成措辞只描述当时状态。

## 逐项对照

| 编号 / 功能 | Python 实际行为 | Node 当前行为 | 状态 | 用户影响 / 后续 | 证据 |
|---|---|---|---|---|---|
| S01 平台新会话分配 | 按优先级分桶，(绑定数+活跃数+1)/权重，分数低优先 | 相同公式；公开账号优先级转换为 1000-priority | **一致** | 仅此分配公式，不涵盖全部候选过滤 | [Python](../../portal/backend/app/agent/service/session_affinity_service.py) · [Node](../../apps/api/src/modules/gateway/selection.ts)；本轮源码对照；gateway-selection |
| S02 个人会话亲和 | personal:用户:会话:模型 的 SHA256 加权 rendezvous，不写平台绑定 | 本轮由数据库绑定改为相同原始排序键的 rendezvous | **一致** | 修复后同一组候选稳定排序；数据库 ID 不同仍会影响赢家 | [Python](../../portal/backend/app/agent/service/gateway_service.py) · [Node](../../apps/api/src/modules/gateway/service.ts)；本轮修复；gateway-selection 哈希基准，个人运行时所有者隔离/软失败回退检查通过 |
| S03 个人无会话且有负载 | (活跃数+1)/权重；同分加权随机 | 本轮补 personalCandidates，替换同分按 ID 偏置 | **一致** | 避免同分时持续偏向小 ID | [Python](../../portal/backend/app/agent/service/gateway_service.py) · [Node](../../apps/api/src/modules/gateway/selection.ts)；本轮修复；已有测试文件补 1 个回归 |
| S04 平台亲和开关/有效期 | AGENT_SESSION_AFFINITY_ENABLED；TTL 默认3600，60至604800秒 | 本轮接入相同环境变量和范围；关闭平台绑定及平滑调度 | **一致** | 个人渠道的无状态亲和不受平台开关影响 | [Python](../../portal/backend/app/agent/service/session_affinity_service.py) · [Node](../../apps/api/src/modules/gateway/service.ts)；源码/类型检查及120秒TTL、关闭亲和的隔离数据库调用通过 |
| S05 最大实际尝试次数 | AGENT_GATEWAY_MAX_ATTEMPTS 默认3，范围1至10 | 本轮由固定3改为同名配置 | **一致** | 上限相同不等于重试候选序列相同 | [Python](../../portal/backend/app/agent/service/gateway_service.py) · [Node](../../apps/api/src/modules/gateway/service.ts)；本轮修复；失败切换现有门禁 |
| S06 绑定身份/续期及最近绑定排序 | 入口将长session摘要为64字符；绑定键含route/请求模型/实际模型；最近绑定按updated_at/id排序 | 已补长ID摘要、Unicode计数、route/pool实际模型命名空间、排序与续期；落库仅保存HMAC | **暂缓** | 用户本轮明确冻结候选路由及其兼容设计，后续重做；本轮不修改用户配置 | session-affinity.ts；batch-5-acceptance.md |
| S07 平台健康惩罚/候选窗口 | unhealthy默认300秒、软失败10秒避让；全受罚仍兜底；新会话候选默认7、最多50且不少于尝试上限 | 已补相同健康筛选/配置与选号窗口；显式主账号和个人渠道不套用池惩罚 | **一致** | 限此筛选与窗口规则；哈希键/最近绑定排序仍由S06核实 | [Python](../../portal/backend/app/agent/service/credential_service.py) · [Node](../../apps/api/src/modules/gateway/scheduling-policy.ts)；本轮隔离验证见batch-3-acceptance.md |
| S08 健康策略配置 | 失败阈值/冷却秒数可配，默认3/60；硬错误至少1800秒，失败数继续累计 | 已接入同名环境配置，硬错误累计历史失败数，不再重置为1 | **一致** | 未更改已有账号配置；软失败不增加硬失败数、不触发硬冷却 | [Python](../../portal/backend/app/agent/service/credential_service.py) · [Node](../../apps/api/src/modules/gateway/repository.ts)；阈值2/冷却90秒/硬错误1800秒落库验证 |
| S09 最终上游HTTP状态 | 耗尽尝试后返回上游状态；硬错误只提取message | 已保留实际状态；硬错误脱敏后仅提取message | **一致** | 状态码对齐，完整错误包格式另见S12；流开始后的HTTP200不改变 | [Python](../../portal/backend/app/agent/service/gateway_service.py) · [Node](../../apps/api/src/modules/gateway/service.ts)；定向错误状态/账本检查 |
| S10 环境变量后备账号 | 无可用存储账号时，显式key/base/model环境变量形成临时OpenAI兼容凭证 | 支持AGENT_LLM_* / AI_*；仅无候选且模型匹配时使用；不持久化账号 | **一致** | 限普通模型及允许回退的公开路由；个人池、停用公开路由、禁止回退绑定不被绕过 | environment-fallback.ts；隔离执行/账本/模型目录检查；batch-5-acceptance.md |
| S11 多进程故障恢复/并发抢占 | 数据库reserved加本地计数 | 数据库租约/行锁；SIGKILL后期限外事务回收请求及租约，不计伪造用量 | **已验收** | 两个真实子进程竞争、SIGKILL、到期回收及API重新成功已通过；隔离库推进TTL，不宣称生产容量 | gateway.test.ts；final-functional-acceptance.md；既有实例租约/探测token fencing |
| P01 三协议文本JSON/SSE | Chat/Responses/Messages双向转换 | 九组合已实现 | **一致** | 限基础文本和已验收用量字段 | [Python](../../portal/backend/app/agent/service/protocol_bridge.py) · [Node](../../apps/api/src/modules/gateway/protocol/bridge.ts)；既有矩阵；本轮前18次真实调用见 live-acceptance.md |
| P02 thinking配置桥接 | Messages thinking enabled/adaptive到Responses近似reasoning medium；到Chat忽略配置 | 移除统一拒绝，沿用转换器相同近似 | **一致** | 不承诺跨供应商预算等价或签名可重放；签名另见P05 | protocol/request-controls.ts；gateway-protocol；batch-5-acceptance.md |
| P03 未知请求/响应扩展 | 按识别字段生成，部分未知扩展丢弃；原生透传 | 默认python字段兼容，strict可选明确拒绝 | **一致** | 限当前声明的未知请求及响应扩展策略；opaque及状态型请求分别见P04/P05 | batch-6-acceptance.md；18个JSON/SSE具体wire检查取代广义TODO |
| P04 状态型Responses | 拒绝非空previous_response_id；provider强制store:false；其余原生参数透传 | 默认强制store:false、拒绝非空previous_response_id；background/conversation原生透传，strict可选拒绝 | **一致** | 限请求转发策略，不提供网关存储、查询或跨请求续接；供应商可自行拒绝后台参数 | provider_adapters.py与gateway_service.py源码对照；batch-6-acceptance.md |
| P05 工具/图片/推理签名全字段 | 图片/函数工具转换；Chat丢弃不可表达签名，部分未知块静默忽略 | 相同主要转换；默认拒绝Chat签名丢失和redacted_thinking；工具strict/parallel单独校验 | **有差异** | text-only可显式选择有损推理；不能把默认拒绝称为Python行为等价 | protocol/opaque-content.ts、tool-controls.ts；当前JSON/SSE矩阵及batch-6-acceptance.md |
| A01 旧PAT创建 | 默认不过期，chat/profile，无每key新增限额 | legacy /api/agent/auth/pat维持默认不过期/零额外限额 | **一致** | 仅旧接口默认值；不含所有参数错误格式 | [Python](../../portal/backend/app/agent/service/auth_service.py) · [Node](../../apps/api/src/modules/gateway/legacy-pat.ts)；本轮create_pat与legacy创建对照 |
| A02 新控制台Token创建默认值 | 默认不过期，不加独立令牌限额 | 已改为不过期、独立日额度/RPM/并发默认0；显式有效期支持1–3650天；表单同步 | **一致** | 只影响新建默认值，已有令牌不修改；用户/账号限制仍生效 | [Python](../../portal/backend/app/agent/service/auth_service.py) · [Node](../../apps/api/src/modules/gateway/schema.ts)；本轮修复，验证见batch-1-acceptance.md |
| A03 Token轮换/撤销/旧记录权限 | 有效令牌原子替换，保留名称/类型/范围/备注/到期时间；旧令牌撤销，限本人 | 相同字段保留，附加的模型/额度策略及quota_group也保留 | **一致** | 限轮换/撤销与归属规则；数据库ID结构另见U03 | auth_service.rotate_pat与repository.rotateKey逐字段核对；gateway现有并发轮换、插入失败回滚、权限、历史及预算验证通过 |
| A04 设备授权生命周期 | 可配TTL/轮询间隔/确认路径，用户码4-4；错误响应沿用旧包装 | 已接入配置/用户码与旧轮询error说明、error_code；新增主动拒绝状态 | **有差异** | 旧确认端点成功包及中文错误已对齐；Node额外IP共享限流和主动拒绝仍是显式差异 | device-policy.ts、routes.ts；设备15项定向检查 |
| A05 权限/角色/个人隔离 | Python RBAC菜单权限、所有者过滤 | 网关读写/探测/设备确认逐入口映射；个人导出独立分组，接口强制本人隔离 | **一致** | 限现有网关权限契约及隔离验证；真实来源角色分配和账号登录仍归D01/D02 | Python各api权限逐项对照；普通角色个人导出允许/全员数据拒绝、只读服务不能新增或探测、设备确认与PAT创建独立；既有跨用户隔离；batch-7-acceptance.md |
| Q01 默认日额度 | 默认额度/用户覆盖，零不限额 | defaultDailyQuota/用户覆盖/零不限额 | **一致** | 仅默认及覆盖规则 | [Python](../../portal/backend/app/agent/service/usage_service.py) · [Node](../../apps/api/src/modules/gateway/quota-policy.ts)；源码及既有quota-policy检查 |
| Q02 预留不足时输出预算 | 剩余额度缩减completion allowance；默认输出4096、最小空间可配 | 输入预估按Python字段及UTF8字节/4；用户与令牌锁内原子缩减输出并据此发出请求 | **一致** | 限本日普通模型请求预算；跨日及多轮工具不凭此宣称全等价 | token-estimate.ts、repository.reserve；100预算缩减至80与最小空间拒绝检查 |
| Q03 过期中断预留的计费 | 过期reserved不计入后续可用额度 | 已停止把预留值当作输入Token；interrupted退出计费聚合，保留预留量、unknown用量标记 | **一致** | 限过期后的扣额语义；回收期限另见Q04；不改写历史原始计数 | [Python](../../portal/backend/app/agent/crud/usage.py) · [Node](../../apps/api/src/modules/gateway/repository.ts)；定向额度/统计检查 |
| U01 缓存未知与零 | 缓存读取/写入/未命中保留可空值 | normalizeUsage保留null并区别derived/reported | **一致** | 限已支持的用量字段，新增供应商字段另验 | [Python](../../portal/backend/app/agent/service/usage_service.py) · [Node](../../apps/api/src/modules/gateway/usage.ts)；已有归一化用例；真实180次对账无差异 |
| U02 计费状态/日期桶/时区 | ok/stream_error/client_error计费，业务时区分桶，旧日预留不占新日日额 | cancelled映射client_error；同计费筛选，时区/DST分桶，已修正旧日预留日额 | **一致** | 限状态/日期桶及普通模型本日预留规则；真实历史迁移另见D01 | constants.py、usage.reserve_quota与Node源码核对；午夜/DST/RPM定向9项通过，既有统计隔离检查通过；不是双端真实数据库全量对账 |
| U03 请求与用量ID | 事件数字ID，另有request_id | 请求UUID，历史legacy ID显式映射 | **有差异** | 旧外部引用不能直接当新ID；保留映射并列为结构迁移差异 | [Python](../../portal/backend/app/agent/crud/usage.py) · [Node](../../apps/api/src/modules/gateway/legacy-import.ts)；既有迁移设计；上线引用方未验收 |
| U04 个人日志隐藏内部信息 | mine错误摘要隐藏账号调用链，按本人过滤 | 同摘要替换；个人列表/导出不包含执行快照和内部账号配置 | **一致** | 限该字段投影、归属与导出规则；未知供应商错误内容不因此保证无敏感信息 | mine_error_summary与legacyUsageItem源码对照；个人历史/筛选/导出/跨用户隔离既有集成检查通过 |
| T01 服务端搜索次数默认 | 未填max_uses默认5 | 未填默认5 | **一致** | 仅默认次数 | [Python](../../portal/backend/app/agent/service/server_tools.py) · [Node](../../apps/api/src/modules/gateway/server-tool-loop.ts)；本轮常量对照 |
| T02 搜索次数/轮数上限 | max_uses整数解析，下限0，非法值默认5；循环min(10,max(2,min(max_uses)+2)) | 相同解析与轮数上限，最后一轮移除服务端工具声明 | **一致** | 接受0和大于8的值；外部调用仍受声明次数、超时、工具授权和总轮数控制 | server-tool-loop.ts；gateway-server-tools 9项通过 |
| T03 搜索/抓取/原生工具回退 | Tavily与模型委托；仅确认会执行的账号走原生，否则函数回退 | 已对齐能力确认、多查询预算及自动能力账号选择；DeepSeek同源Messages端点可派生 | **已验收** | 原生确认、明确拒绝回退、账号错误切换、超时取消、域名/字节限制及父子授权按有限契约验收；不承诺任意供应商扩展 | gateway-server-tools/search-delegation/search-provider/search-settings及既有真实搜索；final-functional-acceptance.md |
| T04 搜索流式与证据格式 | 多轮累加已出现的usage字段；各入口返回引用/结果块 | 缓冲SSE/显式文本证据；已报告usage累加，coati_usage标明轮数与不完整字段 | **有差异** | 核心数值累计已对齐；附加partial_fields保留诚实语义，跨协议证据不伪造成原生citation。已收尾，非待开发 | gateway-server-tools三入口JSON/SSE部分缓存回归；final-functional-acceptance.md |
| C01 缓存验证任务 | 缓存任务由内部用户身份执行 | 默认内部用户身份，也可选本人PAT；正常用户额度与并发、逐轮持久化 | **一致** | 限不需要PAT及用户预算执行语义；内部记录不发行Bearer凭证 | batch-6-acceptance.md；5项隔离检查及表单浏览器核对 |
| C02 模型发现与恢复探测 | 自动线程默认启用；间隔/批量/静默期可配；按last_checked_at避让 | 独立worker显式启用；300/5/600兼容；已补last_checked_at与last_probe_at双静默检查 | **有差异** | 静默语义已修复；部署启动方式不同，未擅自启动网络探测 | probe-runner.ts；batch-6-acceptance.md；recovery-probes.md |
| C03 账号代理/头/超时 | 账号代理、自定义头、账号超时 | 平台/个人网络策略及全局请求期限叠加，DNS/重定向保护 | **有差异** | 网络允许范围和总超时可能更严格；保持既有防护，不隐含宣布等价 | egress-policy.md；隔离HTTP/CONNECT/TLS检查见现有全量运行 |
| C04 模型能力目录 | 外部目录及模型覆盖配置 | 显式目录导入与能力档案，不引入LiteLLM自动更新 | **有差异** | 用户已明确不采用LiteLLM/pi-ai；目录来源差异保留可见 | model-profiles.md；模型目录与能力档案既有隔离检查 |
| V01 网关总览 | 旧页面交互与字段为基准 | 已完成对应页面操作清单及本轮缺陷修复 | **已验收** | 以功能收尾记录中的操作/权限/失败恢复为验收范围；写入用隔离库/组件，浏览器只读或取消草稿。V04候选路由冻结 | [Python](../../portal/frontend/src/modules/agent/pages/ops_dashboard_page/index.jsx) · [Node](../../apps/web/src/modules/gateway/pages/overview/index.jsx)；feature-parity-review.md是上一轮证据；第六批含Node浏览器筛选/下钻/详情检查与隔离回归；无Python真实数据全角色验收 ；final-functional-acceptance.md为当前验收，早期未完整双端浏览器措辞不再作为无限期待办 |
| V02 全员统计/请求日志 | 旧页面交互与字段为基准 | 已完成对应页面操作清单及本轮缺陷修复 | **已验收** | 以功能收尾记录中的操作/权限/失败恢复为验收范围；写入用隔离库/组件，浏览器只读或取消草稿。V04候选路由冻结 | [Python](../../portal/frontend/src/modules/agent/pages/usage_page/index.jsx) · [Node](../../apps/web/src/modules/gateway/pages/requests/index.jsx)；feature-parity-review.md是上一轮证据；第六批含Node浏览器筛选/下钻/详情检查与隔离回归；无Python真实数据全角色验收 ；final-functional-acceptance.md为当前验收，早期未完整双端浏览器措辞不再作为无限期待办 |
| V03 个人用量看板 | 旧页面交互与字段为基准 | 已完成对应页面操作清单及本轮缺陷修复 | **已验收** | 以功能收尾记录中的操作/权限/失败恢复为验收范围；写入用隔离库/组件，浏览器只读或取消草稿。V04候选路由冻结 | [Python](../../portal/frontend/src/modules/agent/pages/my_usage_page/index.jsx) · [Node](../../apps/web/src/modules/gateway/pages/my-usage/index.jsx)；feature-parity-review.md是上一轮证据；第六批含Node浏览器筛选/下钻/详情检查与隔离回归；无Python真实数据全角色验收 ；final-functional-acceptance.md为当前验收，早期未完整双端浏览器措辞不再作为无限期待办 |
| V04 账号/个人渠道/路由编辑 | 旧页面交互与字段为基准 | 已完成对应页面操作清单及本轮缺陷修复 | **已验收** | 以功能收尾记录中的操作/权限/失败恢复为验收范围；写入用隔离库/组件，浏览器只读或取消草稿。V04候选路由冻结 | [Python](../../portal/frontend/src/modules/agent/pages/keys_page/index.jsx) · [Node](../../apps/web/src/modules/gateway/pages/upstreams/index.jsx)；feature-parity-review.md是上一轮证据；第六批含Node浏览器筛选/下钻/详情检查与隔离回归；无Python真实数据全角色验收 ；final-functional-acceptance.md为当前验收，早期未完整双端浏览器措辞不再作为无限期待办 |
| V05 模型能力/缓存验证/搜索设置 | 旧页面交互与字段为基准 | 已完成对应页面操作清单及本轮缺陷修复 | **已验收** | 以功能收尾记录中的操作/权限/失败恢复为验收范围；写入用隔离库/组件，浏览器只读或取消草稿。V04候选路由冻结 | [Python](../../portal/frontend/src/modules/agent/pages/model_profiles_page/index.jsx) · [Node](../../apps/web/src/modules/gateway/pages/model-profiles/index.jsx)；feature-parity-review.md是上一轮证据；第六批含Node浏览器筛选/下钻/详情检查与隔离回归；无Python真实数据全角色验收 ；final-functional-acceptance.md为当前验收，早期未完整双端浏览器措辞不再作为无限期待办 |
| V06 访问令牌/设备确认 | 旧页面交互与字段为基准 | 已完成对应页面操作清单及本轮缺陷修复 | **已验收** | 以功能收尾记录中的操作/权限/失败恢复为验收范围；写入用隔离库/组件，浏览器只读或取消草稿。V04候选路由冻结 | [Python](../../portal/frontend/src/modules/agent/pages/tokens_page/index.jsx) · [Node](../../apps/web/src/modules/gateway/pages/keys/index.jsx)；feature-parity-review.md是上一轮证据；第六批含Node浏览器筛选/下钻/详情检查与隔离回归；无Python真实数据全角色验收 ；final-functional-acceptance.md为当前验收，早期未完整双端浏览器措辞不再作为无限期待办 |
| D01 历史数据迁移 | 现有Python部署和数据库为验收源 | 已有迁移/部署工具与隔离演练 | **尚未核实** | 独立新库导入和ID/角色映射需真实源对账；不可标为完成 | [Python](../../portal/backend/app/agent/service/auth_service.py) · [Node](../../apps/api/src/modules/gateway/legacy-import.ts)；legacy-data-migration.md / deployment.md：历史演练证据 |
| D02 密码/PAT/密钥迁移 | 现有Python部署和数据库为验收源 | 已有迁移/部署工具与隔离演练 | **尚未核实** | 算法兼容与加密包不等于真实用户登录全验收 | [Python](../../portal/backend/app/agent/service/auth_service.py) · [Node](../../apps/api/src/modules/gateway/legacy-archive.ts)；legacy-data-migration.md / deployment.md：历史演练证据 |
| D03 部署/备份恢复/生产切换 | 现有Python部署和数据库为验收源 | 已有迁移/部署工具与隔离演练 | **尚未核实** | 开发容器演练不等于生产切换；尚未提交发布 | [Python](../../portal/backend/app/agent/service/auth_service.py) · [Node](../../apps/api/src/modules/gateway/service.ts)；legacy-data-migration.md / deployment.md：历史演练证据 |

| S12 最终非硬错误响应体格式 | 返回解析后的上游错误包；支持SSE data及最多两层message解包；无法解析时原文摘要 | 已实现同样解析，转发脱敏后的字段，request ID在响应头 | **一致** | 限进入最终HTTP错误分支的普通错误；硬错误继续仅提取message，不透出完整账号错误包 | [Python](../../portal/backend/app/agent/service/gateway_service.py) · [Node](../../apps/api/src/modules/gateway/upstream-error-body.ts)；JSON/SSE/套娃/纯文本回归通过 |
| Q04 新模型请求的预留期限 | AGENT_QUOTA_RESERVATION_TTL_SECONDS默认3600，至少300秒；时效外不占额度 | 已接入同名配置，过期预留在额度/并发准入时即时忽略，无须等后台清理 | **一致** | 限新模型请求和配置不变时的时效判断；已有记录期限不追溯修改，跨日/动态改配置和工具子请求另待核实 | [Python](../../portal/backend/app/agent/service/usage_service.py) · [Node](../../apps/api/src/modules/gateway/quota-policy.ts)；过期未清理/活跃并发回归通过 |

| S13 无别名的直接模型池 | 没有路由别名时匹配已声明模型的平台账号 | 已补自动候选、实时复核、账号租约与亲和；不创建持久路由 | **一致** | 限明确模型名；已有公开/旧候选配置优先，停用配置不会被自动池绕过；coati-auto仍需配置路由 | pool-route.ts、repository.ts；直接模型两次执行/目录/绑定/停用覆盖检查 |

## 本轮验证

- 修复仅在 Node；Python 源码不改，既有账号、路由、密钥和数据库配置不改。
- 不再执行真实付费负载。先前30分钟真实报告只支持该场景稳定性，不作为以上尚未核实项的替代证据。
- 全量网关门禁运行一次：40个测试文件通过；gateway.test.ts最初有2个个人渠道旧行为断言失败，已按Python无状态语义调整，而非保留Node独有粘性。
- 调整后复跑受影响的gateway/selection/session文件：290项通过；新增TTL/开关用例最初有测试调用参数/加密配置错误，修正fixture后单项通过。没有再次跑整套门禁冒充新增证据。
- 最终API类型检查、静态网关门禁通过；全工作区类型检查及构建通过（构建有既有前端chunk体积提示）。本轮仅新增2个针对调度偏差的用例，其他复用既有检查。
- 第六批已用18项明确wire检查关闭广义unsupported-field占位；不扩展为所有供应商字段兼容。
- 首轮源码指纹见 behavior-parity-snapshot.json，可判断后续修改是否已使本表证据过期。

## 维护规则

每次发现差异追加/更新编号、复现触发、用户影响、修复位置与验证结果。只有明确对照双方行为的证据才能改为一致。旧文档中的 pending/done 按时间保留为历史，不覆盖本表当前结论；表内仍未核实的旧宣称不得用于发布验收。

## 第一批额度与授权修正

A02/Q03/S09 的限定行为已修复；拆出 S12（错误包）和 Q04（预留期限），避免把局部修复扩大成完整等价。详细结果见 [第一批验收](batch-1-acceptance.md)。

## 第二批收尾

S12与Q04上述限定行为已修复；详情见 [第二批验收](batch-2-acceptance.md)。不将跨日、配置动态变更及工具子请求TTL混入已核实范围；U02/T03继续保留尚未核实。

## 第三批：健康调度

S07/S08已按限定规则对齐，显式主账号优先级边界一并修复；S06绑定身份/最近绑定排序和S10环境后备仍未完成。见 [第三批验收](batch-3-acceptance.md)。

## 第四批：最近绑定排序

已修正 S06 中最近绑定排序、续期更新时间及候选统计范围。身份键仍待对齐，S10 环境后备仍缺失，状态计数不变。见 [第四批验收](batch-4-acceptance.md)。

## 第五批补齐与审计（2026-09-26）

[第五批证据](batch-5-acceptance.md)记录本轮源码修复、隔离验证和浏览器走查。V01–V06保留“尚未核实”，表示未完成双端所有操作/角色的等价验收；本轮已在Node端核对统计、日期、模型选择、令牌和缓存空态、搜索配置。S11增加了真实子进程强杀证据，但不扩大为生产故障容量证明。

## 第六批继续审计

见 [第六批证据](batch-6-acceptance.md)。补齐缓存内部身份、Messages流式工具闭环与历史回放、权限映射和统计筛选。P04原生参数策略已补齐限定一致；P05继续保留有证据的保护差异，并非宣称完整等价。A05增加普通角色隔离和空库迁移证据，页面及真实来源验收继续按证据逐项处理。

第六批继续证据：原生工具确认与约束表达、多查询词解析、逐查询次数与Messages工具usage，及页面筛选分页修复，详见batch-6-acceptance.md。全量兼容状态不因局部修复自动变更。


## 第八批搜索边界

见[第八批证据](batch-8-acceptance.md)：补齐独立搜索/工具子请求配置期限；统一原生抓取与Tavily的UTF-8预算；原生搜索和抓取能力独立观察。25项隔离检查通过，T03/T04仍未宣称所有供应商等价。Q04新增工具预留期限的限定证据，跨日和动态更改配置对活跃请求的语义仍单独保留。
