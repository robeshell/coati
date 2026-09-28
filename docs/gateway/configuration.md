# 配置与凭证

配置入口为 apps/api/.env.example 和仓库根目录 .env.example。运行环境由 NODE_ENV 决定。

- DEV_DATABASE_URL / TEST_DATABASE_URL：开发与测试隔离数据库；生产使用 DATABASE_URL。
- SECRET_KEY：会话及框架加密根密钥。
- GATEWAY_ENCRYPTION_KEY：模型供应商凭证的 AES-256-GCM 主密钥，必须独立备份。
- ADMIN_PASSWORD：生产初始化管理员密码。
- APP_NAME：服务端产品显示名，默认为 Coati。
- TRUSTED_PROXIES：允许提供转发来源信息的代理 IP/CIDR；空值不信任转发头。
- GATEWAY_ALLOW_PRIVATE_UPSTREAMS：显式允许私有网络模型地址；连接仍执行地址策略检查。
- AGENT_TIMEZONE：业务日边界，默认 Asia/Shanghai。
- AGENT_DAILY_TOKEN_QUOTA：默认用户日额度，0 为无限额；用户覆盖值与密钥限制共同生效。
- GATEWAY_ENABLE_PROBES：独立探测工作进程开关，探测可能调用供应商并产生费用。

访问令牌只展示一次，数据库保存摘要。不要在日志、截图或配置示例中写入真实令牌。修改加密主密钥前使用 gateway:rotate-key 工具在隔离副本验证；仅覆盖环境变量会导致凭证不可解密。

生产 AI SQL 需要 AI_SQL_DATABASE_URL 指向专用只读角色，未配置时使用该功能会失败，不会回退到网关业务库。系统设置、邮件、存储和 AI 助手使用框架设置注册表。
