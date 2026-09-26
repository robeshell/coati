# 标准 SDK 接入

使用管理员发布的公开模型名和自己的网关访问令牌。以下示例会产生真实模型调用，请自行选择测试账号与额度。示例不需要 Coati 私有 CLI。

```sh
npm install openai @anthropic-ai/sdk
export COATI_BASE_URL=https://gateway.example.com
export COATI_MODEL=your-public-model
export COATI_API_KEY=your-gateway-token
```

```js
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

const base = process.env.COATI_BASE_URL.replace(/\/$/, '')
const apiKey = process.env.COATI_API_KEY
const model = process.env.COATI_MODEL
const openai = new OpenAI({ baseURL: base + '/v1', apiKey, maxRetries: 0 })
const anthropic = new Anthropic({ baseURL: base, apiKey, authToken: null, maxRetries: 0 })

const chat = await openai.chat.completions.create({
  model, messages: [{ role: 'user', content: 'Hello' }],
})
console.log(chat.choices[0]?.message.content)

const response = await openai.responses.create({ model, input: 'Hello', store: false })
console.log(response.output_text)

const stream = await anthropic.messages.create({
  model, max_tokens: 256, stream: true,
  messages: [{ role: 'user', content: 'Hello' }],
})
for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text)
  }
}
```

`authToken: null` 防止 SDK 读取本机其他项目的 `ANTHROPIC_AUTH_TOKEN`，不会修改本机配置。关闭 SDK 隐式重试便于核对单次请求与网关尝试日志；是否在业务中重试应结合幂等性与费用决定。

本仓库使用 OpenAI 7.23.0 / Anthropic 0.128.0 的真实 SDK 验证三种入口的普通/流式响应，SDK 通过真实 TCP 连接 Node 网关，再由网关访问本地模拟 Chat 上游。它证明客户端与网关的解析/传输互通，不证明任意供应商的工具、签名或缓存特性。九组合转换细节另由矩阵测试覆盖。

Responses 的 `store: true`、后台任务与状态续接当前明确拒绝；完整限制见 [protocol-contract.md](protocol-contract.md)。设备登录示例见仓库 [examples/device-auth](../../examples/device-auth)。
