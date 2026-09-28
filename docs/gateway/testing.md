# 测试与验收

自动测试使用 TEST_DATABASE_URL 指定的隔离 PostgreSQL，不允许指向生产库。创建空库后运行 pnpm test，测试工具会建立所需结构。pnpm verify 检查类型、权限约定、数据库结构版本、OpenAPI、文档、构建和前后端测试；pnpm verify:gateway 覆盖网关协议、取消、限流、用量、初始化和数据库结构链。

```sh
createdb coati_node_test
TEST_DATABASE_URL=postgresql://localhost/coati_node_test pnpm test
pnpm lint
pnpm typecheck
pnpm openapi:generate -- --strict
pnpm build
TEST_DATABASE_URL=postgresql://localhost/coati_node_test pnpm verify
TEST_DATABASE_URL=postgresql://localhost/coati_node_test pnpm verify:gateway
node --test examples/device-auth/device-auth.test.mjs
```

协议回归数据是独立的 JSON 契约样例，测试由 Vitest 执行，无需其他语言运行时或外部源码。供应商调用均由本地模拟服务承接。

容器检查：docker build -t coati . 后运行 node scripts/smoke-container.mjs coati。检查脚本创建临时容器和数据库。性能测量工具为 pnpm bench:gateway，使用 BENCH_DATABASE_URL 指定的本地可创建数据库连接，并只创建/清理工具自己生成的测试库。

单元测试、浏览器流程、容器启动和真实供应商验收是不同证据；本地测试通过不代表生产容量或所有供应商行为已得到验证。
