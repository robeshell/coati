# Node.js 设备授权示例

需要 Node.js 22，无第三方依赖。

```sh
node examples/device-auth/device-auth.mjs --url http://localhost:8080
```

在打印的同源确认地址登录并批准设备码。示例按服务端间隔轮询，显示当前用户和可用模型；访问令牌只保存在进程内存，不输出或写文件。结束后在控制台“访问与授权”吊销该 device- 令牌。只有显式提供 --model 才会调用模型，此操作可能产生供应商费用。

```sh
node examples/device-auth/device-auth.mjs --url https://gateway.example --model your-model --prompt Hello
node --test examples/device-auth/device-auth.test.mjs
```

远程地址必须使用 HTTPS，仅本机允许 HTTP。请求不跟随重定向，确认地址必须与网关同源。单元测试使用内存模拟，不连接供应商。
