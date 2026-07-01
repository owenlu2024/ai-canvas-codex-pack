# API Phase Prompt

现在进入 API 预留开发阶段，但仍不要把供应商品牌显示在 UI 上。

请阅读：

```text
docs/06_API_LOGIC_RESERVED.md
api/12AI_RESERVED_NOTES.md
```

目标：

- 完成设置页中的 API 配置表单
- 完成 .env.local.example
- 完成 provider adapter 结构
- 完成 AI 节点 Run 调用的代码框架
- 允许后期接入真实 API

UI 显示名称只能使用：

```text
AI 服务地址
API Key
默认图片模型
默认文本模型
连接测试
AI 引擎
```

禁止在 UI 中显示：

```text
12API
NanoBanana
GPT Image 2
cdn.12ai.org
api.12ai.org
```

内部代码可以使用：

```text
provider_12ai
```

API 逻辑需遵循：

```text
https://doc.12ai.org/docs
```

但不要在第一步真实调用，先做 mock + adapter。
