# 设备授权示例

一个只依赖 Python 3.11+ 标准库的接入示例，不依赖原 CLI、Agent、插件或 dsh。门户已启动，并配置了可用的上游模型时运行：

```bash
python3 examples/device-auth/device_auth.py --portal http://localhost:8080
```

远程门户必须使用 HTTPS。可加 `--model 模型名` 指定模型，或用 `--no-browser` 在无桌面环境中手动打开授权链接。

## 实际流程

1. `POST /api/agent/auth/device/start` 申请设备码。
2. 浏览器登录门户，核对终端显示的用户码，再确认授权。
3. 按服务端 `interval` 轮询 `/api/agent/auth/device/poll`，处理等待、减速与过期。
4. 用访问令牌请求 `/api/agent/me`、`/api/agent/v1/models`。
5. 发送一次非流式 Chat Completions 请求，最多请求 64 个输出 Token。**这会调用已配置的模型并产生相应用量。**
6. 在门户“访问令牌”中撤销 `device-<本次用户码>`，回终端按 Enter；用原令牌请求 `/api/agent/me`，仅收到 401 才判定撤销成功。

授权确认需要 `agent_device_confirm_action` 权限；查看与撤销令牌需要 `agent_pat`、`agent_pat_delete` 权限。设备令牌只有 `chat`、`profile`，不能自行调用需要浏览器 Session 的管理删除接口，因此撤销由用户在门户完成。

令牌仅保存在进程内存，不输出或落盘。示例拒绝 HTTP 重定向，也不自动打开不同来源的授权页面。中途退出或模型请求失败后，仍应在门户撤销本次令牌；退出程序本身不会撤销服务器中的授权。

## 自动验证

在仓库根目录、安装门户 Python 依赖后执行：

```bash
python -m pytest portal/backend/tests/test_device_auth_example.py -q
```

测试使用真实的 Flask 授权路由、数据库令牌状态与网关路由；浏览器 Session/RBAC 和外部模型响应由测试夹具替代。它不证明浏览器登录页面或真实上游账号已经验收。
