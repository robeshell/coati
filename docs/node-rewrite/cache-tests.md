# 缓存验证

控制台入口 `/gateway/cache-tests`。管理员/用户默认使用当前登录用户，也可选择本人的有效 chat 令牌，提交名称、模型、重复提示词、1–5轮和每轮1–512输出Token。按钮会真实调用配置的上游并消耗额度；开发自动化仅使用随机本机端口的模拟上游。

## 执行与数据

会话登录和 gateway_cache_tests_run 权限 → 获取内部用户身份或校验所选令牌 → 每轮复核身份 → GatewayService.execute → 原有权限、配额预留、路由、亲和、受控HTTP传输与结算 → 回读本人请求日志 → 保存逐轮结果。内部身份每用户复用一条不可用于Bearer认证的记录，不发行访问令牌；不允许传入任意目标URL或供应商密钥。

各轮发送相同请求体，使用同一随机 x-coati-session-id；实际账号及模型取已结算日志的执行快照，不根据配置猜测。上游未报告的缓存字段保留null，UI显示“—”。完整缓存读取/未命中字段才计算命中率，分母含缓存写入；派生未命中量注明来源。跨账号或实际模型时显示不可按同一缓存池比较的提示。失败停止后续轮次并保存已经取得的结果，结果状态为ok/partial/failed。

提示词只在本人验证记录详情保存，列表不返回长提示词/逐轮数据；操作审计对prompt脱敏。不保存模型回答。删除验证记录不删除计费用量日志。进程强制退出可能来不及保存验证记录，正常网关请求日志与已有结算仍保留；不提供后台任务恢复。页面请求期间显示运行状态；关闭连接会取消后续执行。

## 接口与边界

原生前缀 `/api/admin/gateway/cache-tests`，另有 `/api/admin/agent/cache-tests` 路径别名：GET列表、GET /keys、GET /models?key_id=、POST运行、GET /:id详情、DELETE /:id。分页和搜索仅查本人记录，超级管理员也不跨用户。按钮权限_run/_delete，读取使用gateway_cache_tests。

key_id可省略，按当前用户额度执行；显式选择PAT时额外执行令牌模型授权及额度。当前新页面消费summary/results字段，既有历史记录通过离线导入映射到新页面字段，并保留legacy原始摘要/逐轮数据；旧Python响应逐字段兼容仍以明确差异为限，不能将路径别名视为全部旧契约等价。

## 验证证据

隔离PostgreSQL + Fastify入站注入 + 真实本机HTTP模拟服务，覆盖相同请求/会话亲和、网关303Token实际入账、首轮缓存0与后续命中、缺失缓存量、首错保留部分结果、停用主账号后切换并告警、权限/归属/撤销/额度/预取消。这里验证网关处理规则，不证明任何真实供应商会产生缓存；真实供应商行为需用指定测试账号另行验收。

## Durable progress and interruption recovery (2026-09-26)

A run is saved as running before the first upstream call. Each completed/failed round checkpoints results and summary, followed by a conditional final status update. Runs have a 15-minute service deadline. The API recovery timer and list/detail reads mark running records older than 16 minutes interrupted, preserving completed rounds. Late workers cannot overwrite a recovered terminal record. Running records cannot be deleted. No new schema is required.

A crash after supplier settlement but before a checkpoint can still leave that last round absent from the verification record; the normal gateway request ledger retains its accounting. Interrupted runs are not automatically replayed (avoids duplicate paid calls). The UI exposes running/interrupted status. An isolated database case verifies recovery, retained results, live-run protection and rejected late writes; the existing three cache workflows still pass.

### 旧接口返回字段（2026-09-26）

`/api/admin/agent/cache-tests` 的列表、详情和创建返回保留 `round_details`、`rounds_total` / `rounds_ok`、冷暖延迟、缓存覆盖率及账号名称等旧字段；原生接口继续使用 `results`。历史导入记录优先保留归档内原始字段。未知缓存计数仍为 `null`，不会把缺失当作零。运行和模型列表仍需明确选择现有 `key_id`，不生成绕过额度的内部令牌。
