# 第二批：错误响应体和预留有效期

2026-09-26。未改Python、已有账号/令牌/路由、环境配置或数据库记录；未调用真实供应商；未提交/推送。

## S12：最终非硬上游错误

对照Python parse_upstream_error_body与provider normalize_response。Node新增有界JSON/SSE解析，最多剥两层message内JSON；保留原有字段和HTTP状态，不额外套gateway error。无可解析JSON时返回error原文前500字符。先脱敏后解析，不暴露已知账号/代理/自定义头凭证。响应以application/json发送，x-request-id对应请求账本。

硬账号错误使用同一解析器提取message，仍不透传完整账号错误对象。网关自行产生的认证、配额、协议、连接等错误继续使用自己的错误包；已开始的SSE响应不受此次改动影响。

## Q04：模型请求预留

新增AGENT_QUOTA_RESERVATION_TTL_SECONDS，默认3600秒，0/空值回退默认，最小300秒。仅计算模型请求的额度预留expires_at；HTTP硬超时、账号超时、并发租约时限独立保留。

准入事务在取得锁后读取数据库时钟，用户共享额度及令牌组额度、并发计数均忽略已到期reserved行；不会再等30秒清理周期后才释放容量。后台仍将过期记录标记为interrupted，用量未知、不计费。

范围说明：旧记录保持已有expires_at，改变配置不追溯重算旧行；Python按当前配置和created_at判断，动态调整配置仍存在这一持久化差别。Python的跨午夜预留口径与Node既有行为仍由U02核验。服务端工具子请求的独立125秒预留尚未改动，由T03一起对照。不能把本条限定一致解读为全部额度行为等价。

## 验证

- gateway.test、gateway-quota-policy、gateway-server-tools三份现有测试文件合计298项通过，一次定向运行。
- 补充覆盖：JSON错误字段、SSE错误帧、message套娃、纯文本脱敏、响应头/账本ID；后台尚未清理时过期预留不占额度/并发，活跃请求仍受限制；TTL默认值、下限和显式配置。
- 全工作区类型检查、构建、静态网关门禁通过。前端仍有既有chunk体积警告。
- 日志：/tmp/coati-batch2-tests.log、/tmp/coati-batch2-final-types.log、/tmp/coati-batch2-build.log、/tmp/coati-batch2-static.log。
