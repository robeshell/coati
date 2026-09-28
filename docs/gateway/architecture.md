# 网关架构

后端位于 apps/api，前端位于 apps/web。Node.js 进程拥有连接、请求取消、流传输、供应商调用和后台任务；PostgreSQL 保存账号、路由、密钥摘要、请求记录、配额预留和审计数据。

## 服务边界

- app.ts 装配 Fastify 插件，main.ts 启动 HTTP 服务并处理退出信号。
- modules/gateway/routes.ts 注册协议和控制台接口。协议接口与管理 Cookie、CSRF、翻译、审计 hook 隔离。
- gateway/runtime.ts 管理请求准入、总缓冲预算、退出与恢复任务。
- gateway/request-lifecycle.ts、runtime-http.ts、execution.ts 负责取消、超时、HTTP 连接及一次模型请求的执行。
- gateway/protocol 负责 Chat、Responses、Messages 的 JSON 和 SSE 转换。
- repository.ts 负责业务持久化与事务；db/schema/gateway 定义数据结构。
- 管理接口通过 common/auth 校验权限；前端通过 shared/api/request 发起请求。

## 一次模型请求

鉴权与模型权限校验 → 解析上下文 → 选择公开路由与候选账号 → 原子预留配额 → 调用上游 → 输出 JSON 或流 → 记录实际用量并结算预留。失败重试不能重复计费；未知用量保持未知，不能填成零。客户端断开需要取消上游，慢速下游不能让缓冲无限增长。

请求结束与停机共享资源回收路径。收到退出信号后停止准入，允许在途请求在期限内完成，取消超时任务并结算，最后关闭数据库连接。默认活动请求上限为 256，总编码流预算为 64 MiB，退出宽限期为 10 秒；配置以源码与环境变量为准。

## 控制台

模型服务、公开路由、候选配置、模型能力、个人渠道、访问授权、日志、用量统计、缓存验证和网页搜索均由网关模块维护。系统管理提供用户、角色、部门、会话、设置、通知和审计。组件示例代码保留作参考，其根菜单默认禁用。

项目不包含桌面客户端、Agent Runtime、供应商账号安装器或公司私有服务。
