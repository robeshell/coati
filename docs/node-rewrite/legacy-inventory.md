# 旧版 Agent API 迁移清单

静态扫描 Node 分支保留的 Python 参考代码；仅表示路由存在，不证明运行行为。每个 HTTP 方法独立计数。系统管理基础由 castor-kit 提供，仍需 P3/P4 权限验收。

| 源文件 | 方法 | 路径 | 阶段 | 处置 |
| --- | --- | --- | --- | --- |
| `auth.py` | POST | `/api/agent/auth/pat` | P3/P4 | 保留登录授权/PAT 语义，保留旧接口兼容与业务语义 |
| `auth.py` | GET | `/api/agent/auth/pat` | P3/P4 | 保留登录授权/PAT 语义，保留旧接口兼容与业务语义 |
| `auth.py` | POST | `/api/agent/auth/pat/<int:pat_id>/rotate` | P3/P4 | 保留登录授权/PAT 语义，保留旧接口兼容与业务语义 |
| `auth.py` | PUT | `/api/agent/auth/pat/<int:pat_id>` | P3/P4 | 保留登录授权/PAT 语义，保留旧接口兼容与业务语义 |
| `auth.py` | GET | `/api/agent/auth/pat/<int:pat_id>/usage` | P3/P4 | 保留登录授权/PAT 语义，保留旧接口兼容与业务语义 |
| `auth.py` | DELETE | `/api/agent/auth/pat/<int:pat_id>` | P3/P4 | 保留登录授权/PAT 语义，保留旧接口兼容与业务语义 |
| `auth.py` | POST | `/api/agent/auth/device/start` | P3/P4 | 保留登录授权/PAT 语义，保留旧接口兼容与业务语义 |
| `auth.py` | POST | `/api/agent/auth/device/poll` | P3/P4 | 保留登录授权/PAT 语义，保留旧接口兼容与业务语义 |
| `auth.py` | POST | `/api/agent/auth/device/confirm` | P3/P4 | 保留登录授权/PAT 语义，保留旧接口兼容与业务语义 |
| `auth.py` | GET | `/api/agent/me` | P3/P4 | 保留登录授权/PAT 语义，保留旧接口兼容与业务语义 |
| `bootstrap.py` | GET | `/api/agent/bootstrap` | P4 | 退役客户端启动配置；通用模型/配额信息由网关 API 提供 |
| `cache_test.py` | GET | `/api/admin/agent/cache-tests/models` | P2/P5 | 保留模型缓存验证、记录与查询 |
| `cache_test.py` | GET | `/api/admin/agent/cache-tests` | P2/P5 | 保留模型缓存验证、记录与查询 |
| `cache_test.py` | POST | `/api/admin/agent/cache-tests` | P2/P5 | 保留模型缓存验证、记录与查询 |
| `cache_test.py` | GET | `/api/admin/agent/cache-tests/<int:test_id>` | P2/P5 | 保留模型缓存验证、记录与查询 |
| `cache_test.py` | DELETE | `/api/admin/agent/cache-tests/<int:test_id>` | P2/P5 | 保留模型缓存验证、记录与查询 |
| `credentials_admin.py` | GET | `/api/admin/agent/credentials` | P2 | 迁移账号/凭证管理；保留发现、检测、健康探测 |
| `credentials_admin.py` | GET | `/api/admin/agent/providers` | P2 | 迁移账号/凭证管理；保留发现、检测、健康探测 |
| `credentials_admin.py` | GET | `/api/admin/agent/upstream-protocols` | P2 | 迁移账号/凭证管理；保留发现、检测、健康探测 |
| `credentials_admin.py` | POST | `/api/admin/agent/credentials/discover-models` | P2 | 迁移账号/凭证管理；保留发现、检测、健康探测 |
| `credentials_admin.py` | POST | `/api/admin/agent/credentials/<int:cred_id>/copy` | P2 | 迁移账号/凭证管理；保留发现、检测、健康探测 |
| `credentials_admin.py` | POST | `/api/admin/agent/credentials/<int:cred_id>/check` | P2 | 迁移账号/凭证管理；保留发现、检测、健康探测 |
| `credentials_admin.py` | POST | `/api/admin/agent/credentials/health-probe` | P2 | 迁移账号/凭证管理；保留发现、检测、健康探测 |
| `credentials_admin.py` | POST | `/api/admin/agent/credentials` | P2 | 迁移账号/凭证管理；保留发现、检测、健康探测 |
| `credentials_admin.py` | PUT | `/api/admin/agent/credentials/<int:cred_id>` | P2 | 迁移账号/凭证管理；保留发现、检测、健康探测 |
| `credentials_admin.py` | DELETE | `/api/admin/agent/credentials/<int:cred_id>` | P2 | 迁移账号/凭证管理；保留发现、检测、健康探测 |
| `desktop_updates.py` | GET | `/api/agent/desktop-updates/<platform>/<metadata_name>` | 排除 | 退役：桌面更新不属于开源网关范围 |
| `desktop_updates.py` | GET | `/api/agent/desktop-updates/<platform>/<version>/<path:file_name>` | 排除 | 退役：桌面更新不属于开源网关范围 |
| `desktop_updates.py` | GET | `/api/agent/gitea-updates/<channel>/<platform>/<arch>/<metadata_name>` | 排除 | 退役：桌面更新不属于开源网关范围 |
| `desktop_updates.py` | GET | `/api/agent/gitea-updates/<channel>/<platform>/<arch>/download/<ticket>/<path:file_name>` | 排除 | 退役：桌面更新不属于开源网关范围 |
| `desktop_updates.py` | GET | `/api/agent/minio-updates/<ticket>/<channel>/<platform>/<arch>/<metadata_name>` | 排除 | 退役：桌面更新不属于开源网关范围 |
| `desktop_updates.py` | GET | `/api/agent/minio-updates/<ticket>/<channel>/<platform>/<arch>/<version>/<path:file_name>` | 排除 | 退役：桌面更新不属于开源网关范围 |
| `gateway.py` | GET | `/api/agent/v1/models` | P1 | 保留三协议及别名；状态型接口明确拒绝直至实现 |
| `gateway.py` | POST | `/api/agent/v1/messages` | P1 | 保留三协议及别名；状态型接口明确拒绝直至实现 |
| `gateway.py` | POST | `/api/agent/anthropic/v1/messages` | P1 | 保留三协议及别名；状态型接口明确拒绝直至实现 |
| `gateway.py` | POST | `/api/agent/v1/messages/count_tokens` | P1 | 已迁移本地估算、chat 权限、请求 ID；19 组 Python 对照和三路径 HTTP 验证，见 gateway-token-estimate.test.ts / gateway-matrix.test.ts |
| `gateway.py` | POST | `/api/agent/anthropic/v1/messages/count_tokens` | P1 | 已迁移本地估算、chat 权限、请求 ID；19 组 Python 对照和三路径 HTTP 验证，见 gateway-token-estimate.test.ts / gateway-matrix.test.ts |
| `gateway.py` | POST | `/api/agent/v1/chat/completions` | P1 | 保留三协议及别名；状态型接口明确拒绝直至实现 |
| `gateway.py` | POST | `/api/agent/v1/responses` | P1 | 保留三协议及别名；状态型接口明确拒绝直至实现 |
| `gateway.py` | GET | `/api/agent/v1/responses/<response_id>` | P1 | 保留三协议及别名；状态型接口明确拒绝直至实现 |
| `gateway.py` | POST | `/api/agent/v1/web-search` | P1 | 保留三协议及别名；状态型接口明确拒绝直至实现 |
| `model_profiles_admin.py` | GET | `/api/admin/agent/model-profiles` | P1/P2 | 保留能力配置、候选与同步 |
| `model_profiles_admin.py` | GET | `/api/admin/agent/model-profiles/candidates` | P1/P2 | 保留能力配置、候选与同步 |
| `model_profiles_admin.py` | POST | `/api/admin/agent/model-profiles/sync` | P1/P2 | 保留能力配置、候选与同步 |
| `model_profiles_admin.py` | POST | `/api/admin/agent/model-profiles` | P1/P2 | 保留能力配置、候选与同步 |
| `model_profiles_admin.py` | PUT | `/api/admin/agent/model-profiles/<int:profile_id>` | P1/P2 | 保留能力配置、候选与同步 |
| `model_profiles_admin.py` | DELETE | `/api/admin/agent/model-profiles/<int:profile_id>` | P1/P2 | 保留能力配置、候选与同步 |
| `my_channels.py` | GET | `/api/admin/agent/my-channels/providers` | P2/P3 | 保留个人渠道，验证所有权隔离 |
| `my_channels.py` | GET | `/api/admin/agent/my-channels/upstream-protocols` | P2/P3 | 保留个人渠道，验证所有权隔离 |
| `my_channels.py` | GET | `/api/admin/agent/my-channels` | P2/P3 | 保留个人渠道，验证所有权隔离 |
| `my_channels.py` | POST | `/api/admin/agent/my-channels/discover-models` | P2/P3 | 保留个人渠道，验证所有权隔离 |
| `my_channels.py` | POST | `/api/admin/agent/my-channels/<int:channel_id>/check` | P2/P3 | 保留个人渠道，验证所有权隔离 |
| `my_channels.py` | POST | `/api/admin/agent/my-channels` | P2/P3 | 保留个人渠道，验证所有权隔离 |
| `my_channels.py` | PUT | `/api/admin/agent/my-channels/<int:channel_id>` | P2/P3 | 保留个人渠道，验证所有权隔离 |
| `my_channels.py` | DELETE | `/api/admin/agent/my-channels/<int:channel_id>` | P2/P3 | 保留个人渠道，验证所有权隔离 |
| `routes_admin.py` | GET | `/api/admin/agent/routes` | P2 | 迁移路由模型与管理操作，保持外部行为 |
| `routes_admin.py` | POST | `/api/admin/agent/routes` | P2 | 迁移路由模型与管理操作，保持外部行为 |
| `routes_admin.py` | PUT | `/api/admin/agent/routes/<int:route_id>` | P2 | 迁移路由模型与管理操作，保持外部行为 |
| `routes_admin.py` | DELETE | `/api/admin/agent/routes/<int:route_id>` | P2 | 迁移路由模型与管理操作，保持外部行为 |
| `usage.py` | GET | `/api/admin/agent/usage` | P3/P4/P6 | 已接入管理权限、用户/PAT/模型/状态/时间分页查询与账号诊断；gateway.test.ts 的 admin usage；新请求/每次尝试已记录路由 ID、账号名、实际模型/协议快照；路由名称（公开模型名）/provider 分类已接入新快照；历史导入未完成，不代表全量字段对齐 |
| `usage.py` | GET | `/api/admin/agent/usage/analytics` | P3/P4/P6 | 已迁移管理权限、全局/用户/PAT 筛选、用户排行、趋势和模型分布；gateway.test.ts 的 admin analytics/多用户回归；管理列表与统计标签页已接入；历史对账另行验收 |
| `usage.py` | GET | `/api/admin/agent/quotas` | P3/P4/P6 | 已迁移用户搜索/分页、覆盖与默认额度、当日用量和剩余额度；管理配额标签页已接入；历史迁移对账待验收 |
| `usage.py` | GET | `/api/agent/me/usage` | P3/P4/P6 | 已迁移会话鉴权、当前用户隔离、跨令牌分页/筛选与个人脱敏；gateway.test.ts 的 personal usage 用例；历史 ID 导入仍待完成 |
| `usage.py` | GET | `/api/agent/me/usage/analytics` | P3/P4/P6 | 已迁移当前用户汇总、时区趋势、Top 8 模型/全量分母、个人筛选选项及配额；gateway.test.ts 的 personal analytics 与 gateway-usage-bucket.test.ts；个人统计标签页已接入；历史迁移对账仍待完成 |
| `usage.py` | POST | `/api/agent/me/usage/export` | P3/P4/P6 | 已迁移 CSV/XLSX/XLS、字段/筛选/选中导出、会话/CSRF/独立权限、所有权与脱敏；gateway.test.ts 的 personal usage export 用例；历史 ID 映射仍待完成 |
| `usage.py` | PUT | `/api/admin/agent/quotas/<int:user_id>` | P3/P4/P6 | 已迁移独立权限/CSRF、恢复默认与显式不限额、修改后准入生效；管理配额模式编辑已接入；旧权限映射待验收 |
| `websearch_admin.py` | GET | `/api/admin/agent/web-search` | P5 | 保留工具配置与测试，重新应用网络访问限制 |
| `websearch_admin.py` | PUT | `/api/admin/agent/web-search` | P5 | 保留工具配置与测试，重新应用网络访问限制 |
| `websearch_admin.py` | POST | `/api/admin/agent/web-search/test` | P5 | 保留工具配置与测试，重新应用网络访问限制 |

共 69 个方法/路径条目。

非路由能力：`protocol_bridge.py` → P1；`provider_adapters.py`、`session_affinity_service.py`、`credential_probe.py` → P2；`bearer.py`、`auth_service.py`、`usage_service.py`、`credential_crypto.py` → P3/P6；`server_tools.py`、`search_providers.py` → P5。

验收关联：P1 使用 `gateway-protocol.test.ts` 的矩阵义务；P2 使用账号故障/恢复/亲和场景；P3 使用多密钥预算与权限撤销场景；P4 使用设备兑换与 SDK 接入场景；P5 使用工具往返场景；P6 使用导入对账场景。逐接口自动化尚未全部实现，不能据此宣称旧版管理 API 兼容。


路由增量（2026-09-26）：Node 原生路由已支持 description 与同源 upstream_base，运行时再次检查 origin；对应 0023 和 gateway.test.ts 三项 route override 用例。上表四个 Python routes_admin 兼容路径及公开路由/账号池回退、个人渠道语义仍未完成，不能视作已迁移。

账号声明增量（2026-09-26）：原生 upstream 管理接口与表单具备 supported_models/default_model；按 Python supported_models() 合并默认模型，探测不覆盖声明。0024 回填 Node 既有路由所配置实际/含图模型。运行候选过滤、公开路由/个人渠道、默认模型选择及旧 credentials API 仍需迁移；当前不作账号池全量验收声明。

账号声明执行增量（2026-09-26）：显式路由保存验证实际/含图模型与绑定账号启用状态，请求初选按实际目标过滤，租约事务内再次验证最新声明。四项 gateway.test.ts 用例覆盖空声明、默认模型、停用绑定、预留后移除模型与其他支持候选。自动账号池/公开路由/个人渠道和亲和失效重选仍未验收。

会话亲和增量（2026-09-26）：租约事务会复查绑定账号当前启用/冷却、路由启用及目标模型声明，失效绑定允许重选。五种预留后变更场景已用 HTTP/真实隔离数据库验证；首写者争用用例仍通过。真实多副本和公开路由自动池仍待验收。

公开池核心增量（2026-09-26）：gw_public_routes + 原生 public-routes CRUD 已运行；支持自动池、绑定主账号、默认关闭的显式回退、按实际模型筛选、账号优先级、主账号覆盖路径隔离、租约前复核和自动池亲和重选。原有候选配置保留并拒绝别名冲突。Python routes_admin 的兼容分页/摘要/readiness 及控制台、旧配置迁移仍未交付，不能把原生 CRUD 视为兼容 API 全部完成。

公开路由控制台（2026-09-26）：已接入原生 public-routes CRUD 与账号优先级；旧候选配置保留单独标签页。六项组件测试与桌面/窄屏浏览器检查完成。Python 兼容列表/摘要/readiness、旧配置迁移流程仍待实现。

旧候选预检（2026-09-26）：原生 route-migration/preflight 提供只读配置差异与指纹，不等于 Python routes_admin 兼容或 Python 数据导入。单候选仅生成关闭回退的绑定建议；多候选需要人工选择迁移策略。实际应用、旧记录归档、ID 映射及回滚待实现。

Node 旧候选迁移增量（2026-09-26）：单候选预检可通过原生 apply 事务提交，归档源行/ID与公开ID；history/rollback支持带冲突保护的还原。多候选不自动合并。此为 Node 内部配置升级，仍不是 Python数据库导入或 routes_admin 兼容，控制台入口待实现。

控制台迁移入口（2026-09-26）：已接入只读预检、单候选确认迁移、历史与冲突保护回滚；组件/API覆盖写操作，浏览器只检查渲染与确认取消。多候选仍展示差异，不提供静默合并策略。

Python路由GET（2026-09-26）：/api/admin/agent/routes 已提供旧字段列表、分页/筛选、独立全局summary、绑定账号readiness及七日usage。映射到gw_public_routes和gateway_routes权限；旧更新时间未知时返回null，后续编辑追踪。仍未实现该旧路径POST/PUT/DELETE规范，个人渠道/凭证映射及全量数据迁移也未验收。

Python路由写入（2026-09-26）：POST/PUT/DELETE已接入同一公开路由表，旧字段/部分更新/空值/布尔归一化、校验错误和停用后删除有API测试。创建路由实际通过模拟上游执行；并发同名写入只有一次成功。当前账号均为平台模型；个人渠道约束、账号映射与供应商适配可用性仍未全迁移，复杂容器文本输入采取400验证边界。
