<p align="center"><img src="apps/web/public/logo.png" width="80" alt="Coati"></p>

# Coati

Coati 是可自行部署的企业级模型网关，使用 **Node.js、TypeScript、Fastify、Drizzle、PostgreSQL、React 和 shadcn/ui**。它提供统一的模型 API 与管理控制台，集中管理模型接入、账号凭证、路由、权限、配额和用量。

## 核心能力

- OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 接入及协议转换。
- 模型账号池、公开路由、候选配置、个人渠道、健康探测与故障重试。
- 用户与角色权限、个人访问密钥、设备授权、共享配额和并发限制。
- 请求日志、Token 与缓存用量统计、缓存验证、搜索与网页抓取。
- 审计、通知、文件、系统设置和可选定时任务。

项目范围为网关与管理控制台；桌面客户端、产品 CLI、Agent 插件和本机运行环境安装器由各自项目维护。

## 本地开发

需要 Node.js 22.19+、pnpm 11、PostgreSQL 14+。

```sh
pnpm install --frozen-lockfile
createdb coati_node_dev
createdb coati_node_test
cp apps/api/.env.example apps/api/.env.development
# 根据本机环境填写数据库地址；设置独立的 SECRET_KEY 和 GATEWAY_ENCRYPTION_KEY。
pnpm setup-once
pnpm dev
```

控制台为 http://localhost:5175，API 为 http://localhost:5004。开发默认账号为 admin / admin123；生产部署必须设置管理员密码和独立密钥。测试使用 TEST_DATABASE_URL 指定的隔离数据库。

## Docker 部署

```sh
git clone https://github.com/robeshell/coati.git
cd coati
bash setup.sh
```

安装脚本生成本地配置并启动 PostgreSQL 和网关，默认地址为 http://localhost:8080。公网部署使用 HTTPS 反向代理；SSE 需关闭代理缓冲。详见 [部署与运维](docs/gateway/operations.md)。

## 接入模型 API

先在控制台配置模型服务和公开路由，再创建访问密钥。

| 协议 | 接口 |
| --- | --- |
| Chat Completions | POST /api/agent/v1/chat/completions |
| Responses | POST /api/agent/v1/responses |
| Messages | POST /api/agent/v1/messages |

```sh
curl "$COATI_BASE_URL/api/agent/v1/chat/completions" \
  -H "Authorization: Bearer $COATI_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"your-model","messages":[{"role":"user","content":"Hello"}]}'
```

[协议说明](docs/gateway/protocol.md) · [设备授权示例](examples/device-auth/README.md) · [OpenAPI](docs/apifox-full.openapi.json)

## 验证

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm openapi:generate -- --strict
pnpm build
pnpm verify
pnpm verify:gateway
```

测试使用本地模拟上游，不调用真实模型。[测试说明](docs/gateway/testing.md)介绍隔离数据库和容器检查。

## 项目结构

- apps/api：Fastify 服务、Drizzle 数据模型、网关和管理模块。
- apps/web：React / TypeScript 管理控制台。
- docs：架构、接口、开发规范和运维文档。
- examples：独立的 Node.js 接入示例。
- scripts：验证、安装和容器检查工具。

## 许可证

Coati 使用 [Apache-2.0](LICENSE)。基础框架 castor-kit 使用 MIT，声明见 [第三方许可证](THIRD_PARTY_LICENSES/castor-kit.txt) 和 [NOTICE](NOTICE)。
