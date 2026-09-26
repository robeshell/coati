# 第三批：平台账号池健康调度

2026-09-26。只改Node源码，不改现有账号/路由/环境配置，不调用真实供应商，不提交/推送。

## 已修复

- 平台候选优先排除健康惩罚窗口内的账号；有健康候选时避让近期失败账号，若全部在惩罚中仍保留兜底。硬冷却仍由数据库可用性筛选处理，过期冷却不再叠加软惩罚。
- unhealthy窗口默认300秒，软失败窗口默认10秒，支持AGENT_CREDENTIAL_UNHEALTHY_RETRY_SECONDS / AGENT_CREDENTIAL_SOFT_RETRY_SECONDS。按Python规则：unhealthy设0回默认300、负值关闭；soft设0关闭。
- AGENT_GATEWAY_SELECTION_POOL_SIZE默认7，最多50且不小于最大尝试数；选号窗口先于新会话负载排序，实际尝试仍有独立上限。
- AGENT_CREDENTIAL_FAILURE_THRESHOLD默认3，最少1；AGENT_CREDENTIAL_COOLDOWN_SECONDS默认60，最少1。硬错误冷却不少于1800秒，失败数沿用历史累计，不再清零成1。软失败只记录观测时间和错误，不累计硬失败数。
- 显式绑定主账号绕过软惩罚及初始负载重排，并优先于备用账号。此前备用账号priority=10000时可能抢在主账号前，本次利用既有测试补该边界。未开启回退仍不会加入备用账号。
- 个人渠道继续Python的独立选择策略，不套平台健康惩罚或平台候选窗口。

## 验证

gateway、selection、session三份既有文件300项通过。补强原公开池集成用例后定向1项通过，实际验证避开异常账号、全异常仍可尝试。覆盖自定义阈值2、冷却90秒、硬错误1800秒及不重置失败数，健康窗口到期和0值边界，极高优先级备用账号不抢占主账号。

类型检查、构建、静态网关门禁通过；前端既有chunk大小提示仍在。没有运行新的付费长测。日志：/tmp/coati-batch3-tests.log、/tmp/coati-batch3-pool.log、/tmp/coati-batch3-final-types.log、/tmp/coati-batch3-build.log、/tmp/coati-batch3-static.log。

## 仍未完成

S06：Python入口对长会话ID先做HMAC摘要，绑定键包含路由和实际模型；Node绑定身份尚未对齐。Python最近绑定按updated_at/id排序、且限定候选集合，Node按expires_at/scope排序；同分轮转行为仍有差异。续期窗口本身都是剩余半程触发，不能把其他差异误写为TTL算法完全不同。

S10：环境变量后备凭证仍未接入。数据库异常时Python会话亲和的降级行为、不同进程故障恢复仍需后续核实。这批通过不表示整个调度已完全等价。
