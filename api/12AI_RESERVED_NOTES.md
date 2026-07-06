# 12AI API 预留说明

项目第一版不接真实 API，只预留配置与代码结构。

后期接口逻辑遵循官方文档：

```text
https://doc.12ai.org/docs
```

重要规则：

- UI 不显示 12API 字样
- UI 不显示 NanoBanana / GPT Image 2 等供应商名称
- UI 只显示 AI 服务、AI 引擎、API 地址、API Key
- 代码内部可以命名 provider_12ai

环境变量：

```env
AI_API_BASE_URL=https://cdn.12ai.org
AI_API_DIRECT_URL=https://api.12ai.org
AI_API_KEY=sk-xxxx
AI_DEFAULT_IMAGE_MODEL=gpt-image-2
```

图片生成接口示意：

```text
POST https://cdn.12ai.org/v1/task/submit
Authorization: Bearer $API_KEY
Content-Type: application/json
```

请求体示意：

```json
{
  "model": "gpt-image-2",
  "input": {
    "prompt": "产品图，白色背景，商业摄影风格",
    "size": "1024x1024",
    "quality": "high",
    "response_format": "url"
  }
}
```

带参考图时，把图片 URL、data URI 或 base64 放在 `input.images`，生成结果通过任务查询获取：

```text
GET https://cdn.12ai.org/v1/task/{task_id}
Authorization: Bearer $API_KEY
```
