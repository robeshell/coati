# 模型能力档案

Node 控制台入口：`/gateway/model-profiles`。管理上下文窗口与最大输出 Token；目前是模型目录元数据，不是请求截断器，也不会自动修改客户端压缩策略。

## 数值优先级

每个字段独立采用：管理员覆盖值 → 导入目录值 → 默认值（128000 / 8192）。清空覆盖值会提交 null，恢复目录或默认值。导入只更新目录字段和来源，不覆盖手动值、备注或启停状态。默认值不代表模型能力已经验证。

网关模型列表优先使用启用的同名档案；公开别名没有档案时，按目标文本/视觉模型取保守最小值，缺少目标档案时回到默认值。个人渠道按个人目标模型取值，优先于同名平台路由。显式多候选路由合并其目标上限。模型权限过滤不变。

## 管理接口

`/api/admin/gateway/model-profiles`，兼容路径 `/api/admin/agent/model-profiles`：

- GET：分页、search、enabled。
- POST / PUT `/:id`：新增和局部编辑；context_window_override / max_output_tokens_override 可清空。兼容旧 context_window / max_output_tokens 写入覆盖值。
- DELETE `/:id`：先停用再删除。
- GET `/candidates`：平台账号、路由和档案的模型名候选；不暴露他人个人账号模型。
- POST `/sync`：导入以下 JSON；没有 items 时返回 disabled，不发起隐式联网同步。

```json
{
  "source": "供应商官方文档，核验日期",
  "items": [
    {"model_name": "example-model", "context_window": 128000, "max_output_tokens": 8192}
  ]
}
```

列表/候选使用 gateway_model_profiles 权限；新增、编辑/导入、删除分别使用对应 _add、_edit、_delete 按钮权限。单次最多1000条；重复模型名以本次最后一项为准；非法条目拒绝整批。模型名1–128字符，Token上限为1–1000000。

## 与 Python 的明确差异和后续

按项目不用 LiteLLM 的决定，移除了旧版读取 LiteLLM 目录的自动同步；不会冒充已经同步外部模型目录。旧表的 LiteLLM 数值迁移需在数据导入阶段显式映射到 catalog 字段并保留来源。客户端 bootstrap 的压缩比例扩展尚未在此模块实现。

缓存验证的运行、逐轮统计、账号切换提示和记录管理已另行实现，见 cache-tests.md；真实供应商验收、旧响应字段兼容及历史数据导入仍待完成。模型档案完成不表示整体迁移已完成。
