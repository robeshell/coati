# Node 网关部署、备份与升级

Node 版本使用独立 PostgreSQL；不得对 Python 数据库运行 Node migration。镜像启动时执行迁移和增量权限同步，再启动 API。生产配置缺失时应中止启动。

## 全新部署

复制仓库 `.env.example` 为部署环境文件，设置独立的 `POSTGRES_PASSWORD`、`SECRET_KEY`、`GATEWAY_ENCRYPTION_KEY`、`ADMIN_PASSWORD`。秘密信息不要提交进 Git。默认仅绑定本机 8080；公网通过 HTTPS 反向代理。

```sh
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
```

`/health` 会检查数据库。可选恢复探测工作进程：`docker compose --env-file .env.production --profile recovery up -d`。手动或后台模型探测可能产生上游调用，应按实际账号费用启用。

## SSE 反向代理

Nginx 的网关 location 应使用 HTTP/1.1、关闭响应缓存和缓冲，并允许请求持续超过网关 180 秒期限：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 210s;
    proxy_send_timeout 210s;
}
```

仅将实际反向代理地址加入 `TRUSTED_PROXIES`。Compose 的 `stop_grace_period: 210s` 留出在途请求退出时间；不要用立即 kill 作为日常发布方式。服务端工具回退先执行、结算，再输出缓冲 SSE，不能将首包延迟等同于网关失效。

## 备份和恢复

备份数据库、应用 instance 持久卷，以及单独保管的加密密钥和会话密钥。数据库备份本身不包含解密密钥；丢失密钥无法恢复供应商凭证。

```sh
docker compose --env-file .env.production exec -T db pg_dump -U coati -d coati -Fc > coati.dump
```

恢复到新的隔离数据库，使用 `pg_restore --exit-on-error`，检查迁移版本、用户/权限/凭证数量，再启动匹配版本的应用。恢复后的真实凭证调用需单独安排；仅能解密不证明供应商仍接受密钥。主密钥变更见 [credential-rotation.md](credential-rotation.md)。

## 升级和回滚

先备份，再构建带固定版本的候选镜像，在副本库执行迁移和运行检查，确认后替换应用。启动脚本可重复执行，不重复生成管理员。不要让多个未知版本的写进程共享同一个数据库。Python → Node 的导出、dry-run、导入、权限映射和对账见 [legacy-data-migration.md](legacy-data-migration.md)。

回滚窗口内保留旧镜像和升级前数据库。Node 已产生新写入后，不能直接恢复旧备份或切回 Python：先停止写入，导出/对账新数据，再决定恢复方案。项目没有宣称提供自动的 Node → Python 逆向转换。

## 镜像本地门禁

```sh
docker build -t coati-node:check .
node scripts/smoke-container.mjs coati-node:check
```

脚本生成随机临时凭证，创建独立网络和数据库容器，检查全新迁移、管理员、控制台静态资源、健康端点、pg_dump/pg_restore 与重启幂等，然后删除自己创建的容器和网络。不会挂载现有数据库、公开宿主端口或调用真实模型。CI 运行同一流程；容器成功不代表真实供应商、长时间负载或生产切换验收。
