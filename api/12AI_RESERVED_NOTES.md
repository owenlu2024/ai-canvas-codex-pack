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

后期图片生成接口示意：

```text
POST https://cdn.12ai.org/v1/images/generations
Authorization: Bearer $API_KEY
Content-Type: application/json
```

请求体示意：

```json
{
  "model": "gpt-image-2",
  "prompt": "产品图，白色背景，商业摄影风格",
  "size": "1024x1024",
  "quality": "high",
  "response_format": "url"
}
```

后期图片编辑接口示意：

```text
POST https://cdn.12ai.org/v1/images/edits
Authorization: Bearer $API_KEY
Content-Type: multipart/form-data
```
