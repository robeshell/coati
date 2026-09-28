# 模型接口与转换策略

推荐接口前缀为 /api/agent/v1；也提供 /v1 接入别名。访问密钥通过 Authorization: Bearer 发送，Messages 接口亦支持约定的 API key 鉴权。模型名由公开路由定义，上游凭证不会返回给调用方。

支持 Chat Completions、Responses、Messages 的 JSON 与 SSE 路径。协议间不能表达的字段必须遵循明确策略，不能伪造工具结果、签名或计费用量。

## 推理内容

X-Coati-Reasoning-Policy 默认为 preserve。支持的签名和加密推理字段保留；Chat 没有可移植的签名字段，无法无损表达时拒绝。调用方可显式使用 text-only 接受签名丢失并保留可用文本。不同供应商对签名的验证不由网关保证。

## 请求约束

X-Coati-Compatibility-Policy 默认为 standard，也支持 strict。standard 使用网关定义的字段处理规则；strict 对不能满足的存储语义等请求明确报错。标准策略不启用 Responses 服务端持久化。

错误和终止由各协议的响应结构表达。流中的上游错误、协议错误、客户端取消和进程中断分别记录；结束帧不能代表未经确认的成功。缓存读取、写入、输入、输出及推理用量按供应商已报告值统计，缺失字段保持未知。

## 授权与管理

设备授权入口为 /api/agent/auth/device/start 和 /api/agent/auth/device/poll，浏览器确认页为 /agent/device-confirm。设备码有时效和轮询间隔，拒绝或过期不会颁发令牌。访问密钥支持有效期、模型权限、轮换和吊销。

控制台的路由整合可将候选配置整理为公开路由：先检查差异，按版本执行，保留操作记录并提供回滚。它不复制数据库或导入外部应用。

完整路径、字段和权限以 [OpenAPI](../apifox-full.openapi.json) 为准。
