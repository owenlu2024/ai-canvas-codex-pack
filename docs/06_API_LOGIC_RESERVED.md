# API 逻辑文档 v1.1

## 1. 第一版原则

当前版本已开放真实 AI 跑图测试。

已实现：

- 设置页保存 AI 服务地址 / API Key
- 连接测试读取 `/v1/models`
- Generate Image 节点调用内部 `/api/ai/generate-image`
- 图片生成统一提交到异步任务 `/v1/task/submit`
- 任务完成后从 `/v1/task/{task_id}` 读取输出图片
- 返回图片后在画布右侧追加 Image 节点
- 接口返回前，Generate Image 节点保持 running 灯带状态
- 接口失败时，Generate Image 节点显示错误并停止 running

## 2. 界面命名原则

界面中不要出现第三方 API 品牌字样。

不要显示：

```text
12API
NanoBanana
GPT Image 2
cdn.12ai.org
api.12ai.org
```

界面只显示：

```text
AI 服务
AI 引擎
API 地址
API Key
模型选择
连接测试
```

内部代码可以使用：

```text
provider_12ai
```

## 3. 设置页字段

```text
AI 服务地址
API Key
连接测试
保存设置
```

连接测试行为：

```text
填写 AI 服务地址和 API Key 后，调用内部 /api/ai/models。
内部接口转发到兼容 /v1/models 的模型列表接口。
读取成功后，保存可用图片模型 / 文本模型列表。
设置页不提供默认模型选择，具体模型在节点内选择；节点未选择时默认使用该类型可用列表的第一个。
AI 服务地址、API Key、已读取模型列表会保存在浏览器 localStorage。
同一份配置也会通过 /api/ai/settings 保存到项目本地 .ai-canvas/api-settings.local.json。
重启 dev server 或启动端口变化后，设置页优先从项目本地配置文件恢复。
保存结构使用版本化 key，保留旧 key 迁移，用于正式版前的长期调试和本机恢复。
```

## 3.1 工作区保存

```text
画布工作区通过 /api/canvas/workspace 保存到项目本地 .ai-canvas/workspace.local.aicanvas。
工作区文件格式为 .aicanvas，内部使用版本化结构化数据。
保存内容包括项目名、节点、连接线、节点内容、节点位置、视口、缩放、网格状态。
设置页或画布所在端口变化后，前端优先从项目本地工作区文件恢复。
顶部项目名下拉菜单提供“保存”，同时画布变化会自动保存。
```

## 4. 环境变量预留

```env
AI_API_BASE_URL=https://cdn.12ai.org
AI_API_DIRECT_URL=https://api.12ai.org
AI_API_KEY=sk-xxxx
AI_DEFAULT_IMAGE_MODEL=gpt-image-2
AI_DEFAULT_TEXT_MODEL=
```

## 5. 12AI 兼容接口预留

后期 API 逻辑遵循：

```text
https://doc.12ai.org/docs
```

GPT Image 2 在画布里使用异步任务接口，提交路径为：

```text
POST /v1/task/submit
```

查询路径为：

```text
GET /v1/task/{task_id}
```

所有请求认证：

```text
Authorization: Bearer $API_KEY
```

12AI Base URL：

```text
https://cdn.12ai.org/v1
```

请求体使用 JSON：

```json
{
  "model": "gpt-image-2",
  "input": {
    "prompt": "提示词",
    "images": ["data:image/png;base64,..."],
    "size": "1024x1024",
    "quality": "auto",
    "response_format": "url"
  }
}
```

## 6. 后期节点映射

界面显示：

```text
图片分析
Prompt 优化
快速生成
高质量生成
多图生成
图片编辑
```

内部映射：

```text
Image Chat -> 多模态文本模型
Multi Generate -> 图片生成接口
Image Edit -> 图片编辑接口
```

## 7. apiProvider.ts 预留结构

```ts
export interface ImageGenerationRequest {
  prompt: string;
  images?: File[];
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
  n?: number;
}

export interface ImageGenerationResult {
  images: Array<{ url?: string; b64_json?: string }>;
  revisedPrompt?: string;
}

export async function generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
  throw new Error("Not implemented in v1 prototype");
}
```
