<p align="center"><img src="portal/frontend/public/logo.svg" width="80" alt="Coati"></p>

# Coati

**可自行部署的企业级模型网关。** 为团队集中管理模型接入、账号凭证、请求路由、访问权限、配额与用量。

Coati 提供统一的模型 API 和管理控制台，现有应用与 AI 工具可通过兼容协议接入。

## 核心能力

- **多协议接入**：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。
- **模型与路由管理**：上游账号池、模型映射、凭证调度、故障处理和个人渠道。
- **权限与配额**：用户、角色权限、访问令牌和用户用量限制。
- **用量可观测性**：请求记录、Token 消耗、路由与错误信息、运维看板。
- **服务端工具**：网关侧网页搜索与抓取，以及跨协议工具转换。
- **自行部署**：Flask + React + PostgreSQL，提供 Docker 部署方式。

本项目仅开源模型网关与管理控制台。**桌面客户端、CLI、Agent 插件和本机运行环境安装工具均不在开源范围内。**

## 快速部署

需要 Docker Engine/Desktop 和 Docker Compose。

```bash
git clone https://github.com/robeshell/coati.git
cd coati/portal
bash setup.sh
```

脚本询问管理员密码和端口，生成本地配置，然后构建并启动 PostgreSQL 与网关。默认访问 **http://localhost:8080**，账号 `admin`，密码为安装时设置的值。容器启动会执行数据库迁移和权限初始化。

登录管理控制台，配置上游模型账号与路由，再创建具有模型调用权限的访问令牌。公网部署请通过 HTTPS 反向代理访问。

## 接入模型 API

网关提供以下接口：

| 协议 | 接口 |
| --- | --- |
| OpenAI Chat Completions | `POST /api/agent/v1/chat/completions` |
| OpenAI Responses | `POST /api/agent/v1/responses` |
| Anthropic Messages | `POST /api/agent/v1/messages` |

使用网关颁发的访问令牌进行鉴权，上游模型密钥由服务器保管。不同客户端对 Base URL 的拼接方式不同，请确保最终请求地址对应上述接口。

```bash
export COATI_BASE_URL=http://localhost:8080
# COATI_API_TOKEN 为网关访问令牌，MODEL 为管理员配置的模型名。
curl "$COATI_BASE_URL/api/agent/v1/chat/completions" \
  -H "Authorization: Bearer $COATI_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}"
```

## 开发与验证

本地环境设置见 [Portal README](portal/README.md)。

```bash
npm --prefix portal/frontend ci
npm --prefix portal/frontend test
npm --prefix portal/frontend run build
cd portal
python -m pytest backend/tests -q
python backend/scripts/verify_feature.py --module agent
```

真实上游模型验证需要配置测试账号；单元测试不代表已验证全部供应商或部署环境。

## 目录

```text
portal/       模型网关、管理控制台与数据库迁移
docker/       使用预先构建镜像的服务器部署编排
.github/      后端验证、前端测试与构建 CI
```

## 许可证

[Apache License 2.0](LICENSE)。第三方依赖保留各自的许可证与声明。
