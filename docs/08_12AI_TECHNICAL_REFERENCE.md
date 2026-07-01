# 12AI 技术接口参考

来源：

- https://doc.12ai.org/docs/api/gpt-image
- https://doc.12ai.org/docs/api/gemini-image
- https://doc.12ai.org/docs/api/async-image
- 用户截图：`NanoBanana 图片  12API.png`
- 用户截图：`异步图片任务  12API.png`
- 用户截图：`GPT Image 2  12API.png`

本文档记录 AI Canvas 当前接入 12AI 图片生成时需要遵守的接口契约。它不是产品 UI 文案，供应商品牌不得出现在前台界面。

## 基础约定

- API Base URL 由设置页保存，服务端会归一化到 `/v1`。
- 请求认证使用 `Authorization: Bearer <API Key>`。
- 模型列表兼容 OpenAI 风格接口：`GET /v1/models`。
- 图片生成使用异步任务接口，不再直接依赖同步图片生成接口。
- 前台 UI 不展示 12AI、NanoBanana、Gemini、GPT Image 等供应商品牌以外的额外说明；模型下拉可按产品规格显示模型 ID。

## 截图核对结论

三张截图覆盖了三类接口：

- NanoBanana 图片：原生 Gemini `generateContent` 接口，路径是 `/v1beta/models/{model}:generateContent`，Base URL 是 `https://cdn.12ai.org`，返回图片在 `candidates[].content.parts[].inlineData.data`。
- 异步图片任务：长任务接口，提交路径是 `/v1/task/submit`，查询路径是 `/v1/task/{task_id}`，任务完成后图片 URL 在 `outputs`。
- GPT Image 2：OpenAI 图片兼容接口，同步路径是 `/v1/images/generations` 和 `/v1/images/edits`，返回可用 `b64_json` 或 `url`。

AI Canvas 画布必须优先走异步图片任务，因为前台需要长时间 Running、轮询、停止、追加输出 Image 节点和写入本地备份。同步接口只作为参数和返回结构参考，不作为画布默认调用路径。

## 三模型适配矩阵

三个前台模型必须按三个独立内核处理。不要因为两个模型都在 Gemini/NanoBanana 截图页里，就把它们合并成同一个业务适配器；也不要把 GPT Image 2 的 OpenAI 图片参数套给 Gemini。

| 前台模型 | 内核/接口族 | 画布提交路径 | 请求格式 | 关键参数 | 结果位置 |
| --- | --- | --- | --- | --- | --- |
| `gpt-image-2` | GPT Image 2 / OpenAI 图片兼容 | `/v1/task/submit` | `multipart/form-data` | `model`、`prompt`、重复 `image`、像素 `size`、`quality`、`n`、`response_format=url` | 轮询任务 `outputs` |
| `gemini-3.1-flash-image-preview` | NanoBanana / Gemini 3.1 Flash 图片 | `/v1/task/submit` | JSON, `model + input` | `input.prompt`、`input.images`、`input.aspect_ratio`、`input.image_size`、`input.n` | 轮询任务 `outputs` |
| `gemini-3-pro-image-preview` | NanoBanana / Gemini 3 Pro 图片 | `/v1/task/submit` | JSON, `model + input` | `input.prompt`、`input.images`、`input.aspect_ratio`、`input.image_size`、`input.n` | 轮询任务 `outputs` |

同步文档路径也不同：

- GPT Image 2 同步参考：`/v1/images/generations`、`/v1/images/edits`。
- Gemini 3.1 Flash 原生参考：`/v1beta/models/gemini-3.1-flash-image-preview:generateContent`。
- Gemini 3 Pro 原生参考：`/v1beta/models/gemini-3-pro-image-preview:generateContent`。

代码层面也必须保持三个入口函数，允许后续分别调整尺寸、数量、质量、搜索、思考模式、参考图上限、错误处理和返回解析。

## 本项目采用的连接方式

AI Canvas 画布运行需要长任务、轮询、返回 URL、写入备份库，所以统一走异步图片任务接口：

- 提交：`POST /v1/task/submit`
- 查询：`GET /v1/task/{task_id}`
- GPT 图片模型用 multipart/form-data 提交。
- Gemini 图片模型用 JSON 提交，采用异步任务文档里的 `model + input` 写法。

不要把 Gemini 的 `prompt` 放到任务顶层；顶层 `prompt` 是 GPT Image 2 的 native prompt format，Gemini 会报错。Gemini 图片任务必须把提示词放在 `input.prompt`。

文生图时不要发送空 `images: []`；生成数量为 1 时不要发送默认 `n: 1`，让上游走默认值。多张生成时才发送 `input.n`，任务可能返回 `partial_completed`。

服务端内部按模型拆成独立适配器：

- `gpt-image-2`: `buildGptImage2Submit`
- `gemini-3.1-flash-image-preview`: `buildGemini31FlashImageSubmit`
- `gemini-3-pro-image-preview`: `buildGemini3ProImageSubmit`

## GPT Image 2

截图页说明 GPT Image 2 兼容 OpenAI 图片接口：

- 图片生成：`POST /v1/images/generations`，请求格式 `application/json`。
- 图片编辑：`POST /v1/images/edits`，请求格式 `multipart/form-data`。
- 模型固定使用 `gpt-image-2`。
- `response_format` 可为 `b64_json` 或 `url`。
- 常见 `size`：`auto`、`1024x1024`、`1536x1024`、`1024x1536`、`2048x2048`、`3840x2160`。

画布当前不直接调用 `/v1/images/generations`，而是使用异步任务包装 GPT Image 2：

提交任务：

```http
POST /v1/task/submit
Content-Type: multipart/form-data
Authorization: Bearer <API Key>
```

表单字段：

- `model`: `gpt-image-2`
- `prompt`: 提示词
- `image`: 可选，参考图文件；多图时重复该字段
- `size`: 实际像素尺寸，例如 `1024x1024`、`1536x1024`
- `quality`: `auto`、`low`、`medium`、`high`
- `n`: 图片数量
- `response_format`: `url`

示例：

```bash
curl https://cdn.12ai.org/v1/task/submit \
  -H "Authorization: Bearer $API_KEY" \
  -F "model=gpt-image-2" \
  -F "prompt=保留主体，把背景改成明亮的现代办公室" \
  -F "image=@input.png" \
  -F "size=1024x1024" \
  -F "quality=high"
```

GPT 同步页 `/v1/images/generations` 的参数格式可用于理解 `size`、`quality` 和返回格式，但本项目提交长任务时使用上面的异步表单方式。

## Gemini 图片模型

截图页说明 NanoBanana/Gemini 原生接口：

- 方法：`POST`
- 路径：`/v1beta/models/{model}:generateContent`
- Base URL：`https://cdn.12ai.org`
- 请求格式：`application/json`
- 认证：`?key=$API_KEY` 或 SDK 配置 API Key
- 请求体核心字段：
  - `contents`: 文本、图片或多轮上下文。
  - `generationConfig.responseModalities`: 建议 `["IMAGE"]` 或 `["TEXT", "IMAGE"]`。
  - `generationConfig.imageConfig.aspectRatio`: 例如 `1:1`、`16:9`、`9:16`。
  - `generationConfig.imageConfig.imageSize`: `512px`、`1K`、`2K`、`4K`，不同模型支持范围不同。
- 原生响应图片在 `candidates[0].content.parts[].inlineData.data`，是 base64。

截图页推荐模型：

- `gemini-3.1-flash-image-preview`: 日常图片生成首选，质量、速度和成本比较均衡。
- `gemini-3-pro-image-preview`: 专业素材、复杂指令、高分辨率输出。
- `gemini-2.5-flash-image`: 低延迟、大批量、基础图片任务；AI Canvas 当前 UI 暂不展示。

截图页尺寸与参考图限制：

- `gemini-2.5-flash-image`: 约 1K，最多 3 张参考图。
- `gemini-3.1-flash-image-preview`: `512px`、`1K`、`2K`、`4K`，最多 14 张参考图。
- `gemini-3-pro-image-preview`: `1K`、`2K`、`4K`，最多 14 张参考图。
- 常用宽高比：`1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`16:9`、`9:16`、`21:9`。

画布当前通过异步任务提交 Gemini 图片任务，使用异步文档推荐的 `model + input` JSON：

提交任务：

```http
POST /v1/task/submit
Content-Type: application/json
Authorization: Bearer <API Key>
```

JSON 结构：

```json
{
  "model": "gemini-3.1-flash-image-preview",
  "input": {
    "prompt": "一张极简产品海报，白色背景，柔和棚拍光",
    "aspect_ratio": "1:1",
    "image_size": "1K"
  }
}
```

参考图放在 `input.images` 里，支持 URL、data URI 或纯 base64；文生图不传该字段：

```json
{
  "model": "gemini-3-pro-image-preview",
  "input": {
    "prompt": "保留主体，把背景改成雨夜霓虹街道",
    "images": ["data:image/png;base64,<BASE64_IMAGE_DATA>"],
    "aspect_ratio": "1:1",
    "image_size": "4K",
    "n": 2
  }
}
```

支持模型：

- `gemini-3.1-flash-image-preview`
- `gemini-3-pro-image-preview`

异步任务完成后返回图片 URL 在任务查询响应的 `outputs` 中。Gemini 原生同步页使用 `client.models.generate_content(...)`，返回图片在 `candidates[0].content.parts[].inline_data`；本项目只保留该结构用于解析兼容，不作为默认提交格式。

异步任务 `input` 写法如下：

```json
{
  "model": "gemini-3.1-flash-image-preview",
  "input": {
    "prompt": "一张极简产品海报，白色背景，玻璃质感水杯，柔和棚拍光",
    "aspect_ratio": "1:1",
    "image_size": "1K",
    "n": 1
  }
}
```

截图里 `input` 参数含义：

- `prompt`: 必填，图片生成或编辑提示词。
- `images`: 可选，参考图 URL、data URI 或 base64；文本生图不传。
- `aspect_ratio`: 可选，默认 `1:1`。
- `image_size`: 可选，默认 `1K`。
- `n`: 可选，默认 `1`，目前异步截图写明可用于生成数量。

## 任务查询

查询任务：

```http
GET /v1/task/{task_id}
Authorization: Bearer <API Key>
```

查询响应常见顶层字段：

- `id`
- `status`
- `created_at`
- `completed_at`
- `outputs`
- `error`

## 状态处理

继续轮询：

- `queued`
- `pending`
- `running`
- `processing`
- `in_progress`
- 空状态但没有图片时

可以返回图片：

- `completed`
- `success`
- `succeeded`
- `done`
- `partial_completed`，只要 `outputs` 已经包含可用图片

失败：

- `failed`
- `error`
- `cancelled`
- `canceled`

轮询间隔保持 3 秒左右，单次上游请求超时 60 秒，整体生成超时 10 分钟。

## 输出图片解析

优先只解析任务查询响应里的成品输出字段，避免把输入参考图、缩略图或中间字段误当成返图：

1. `outputs`
2. `output`
3. `images`
4. `result`
5. `results`
6. `data.outputs`
7. `data.output`
8. `data.images`
9. `data.result`
10. `data.results`

支持的图片形式：

- 远程 URL：`https://...`
- Data URL：`data:image/...;base64,...`
- Base64 字符串：转成 `data:image/png;base64,...`
- OpenAI 风格对象：`{ "url": "..." }` 或 `{ "b64_json": "..." }`

解析完成后应按 URL 去重，并最多返回本次请求的 `n` 张图片，避免同一任务里多个候选字段导致画布追加过多图片。

## 图片返回前台协议

服务端 `/api/ai/generate-image` 不直接修改画布，也不返回 React Flow 节点。它只负责把不同上游模型的结果统一成前台可消费的 JSON：

```json
{
  "debug": {
    "mode": "task",
    "model": "gemini-3.1-flash-image-preview",
    "taskId": "task_xxx",
    "status": "completed"
  },
  "images": [
    { "url": "https://img.12ai.org/images/example.png" }
  ]
}
```

失败时返回：

```json
{
  "debug": {
    "mode": "task",
    "model": "gpt-image-2",
    "status": "failed"
  },
  "error": "AI 任务失败。"
}
```

前台调用链路：

1. Generate Image 节点点击 `Run`，`BaseNode` 生成一次性 `generationId`，把节点设为 `runState: "running"`。
2. `store/canvasStore.ts` 的 `runGenerateImageNode` 收集输入边：
   - 连接的 Prompt 节点合并成 `prompt`。
   - 连接的 Image 节点收集 `imageUrl` 作为参考图。
   - 当前 Generate Image 节点的 `modelId` 和 `modelParams` 作为模型参数。
3. 前台 `fetch("/api/ai/generate-image")`，请求体为：

```json
{
  "model": "gpt-image-2",
  "prompt": "提示词",
  "images": ["data:image/png;base64,..."],
  "params": {
    "aspectRatio": "1:1 Square",
    "resolution": "1K",
    "quality": "Auto",
    "imageCount": "1"
  }
}
```

4. 服务端提交 12AI 任务并轮询，拿到 `outputs` 后归一化成 `images: [{ url }]`，并同步写入 `.ai-canvas/generated-images.local.json` 备份。
5. 前台收到 `images` 后先做安全校验：
   - 当前节点的 `generationId` 必须仍然等于发起时的 `generationId`。
   - 当前节点必须仍然是 `runState: "running"`。
   - 如果用户已经点 Stop 或重新 Run，旧响应不得写入画布。
6. 前台在画布上追加 Image 节点：
   - 每张返回图创建一个 `kind: "image"` 节点。
   - `imageUrl` 使用服务端返回的 URL 或 data URL。
   - `generatedBy` 记录源 Generate Image 节点 ID。
   - `imageNumber` 使用全局 Image 编号规则，最多 100 个。
   - `runState` 设为 `"completed"`。
7. 前台同时创建连线：
   - `source`: Generate Image 节点 ID。
   - `sourceHandle`: `image-out`。
   - `target`: 新 Image 节点 ID。
   - `targetHandle`: `image-in`。
   - `type`: `deletable`。
8. Generate Image 节点自身更新：
   - `runState` 从 `"running"` 改成 `"completed"`。
   - 清空 `generationId` 和 `errorMessage`。
   - `prompt` 字段显示本次模式：`Text to Image`、`Image to Image`、`Multi Image Reference` 或 `Image + Text`。

Image 节点布局规则：

- 第一轮输出放在 Generate Image 节点右侧，初始间距约 `56px`。
- 多张输出按最多两行的网格自动排列，避免一列过长。
- 如果右侧候选位置会覆盖已有节点，自动向右或上下寻找空位。
- 同一个 Generate Image 再次 Run 时，新输出追加到已有输出右侧并继续避让，不覆盖、不删除旧图。
- 如果 Image 编号已达到 100 个上限，前台把 Generate Image 节点置为 failed，并显示错误。

前台展示图片时直接把 `imageUrl` 传给 `<img src={imageUrl}>`。远程 URL 下载时走 `/api/canvas/image-download` 代理；data URL 直接作为下载 href。

## 前台参数映射

通用：

- `prompt`：连接的 Prompt 文本。
- `images`：连接的 Image 图框图片。对于本地 `/reference-assets/...`，服务端转成 Data URL。
- `n`：前台 Image Count，范围 1-4。

GPT：

- `size`：`宽x高`，例如 `1024x1024`、`2048x2048`、`3840x2160`。
- `quality`：`auto`、`low`、`medium`、`high`。
- `aspect_ratio` 不直接提交；前台 AR 会在服务端转换成 `size`。
- 自定义尺寸按 GPT 规则处理：最长边不超过 `3840px`，宽高是 `16px` 的倍数，长短边比例不超过 `3:1`。

Gemini 异步任务：

- 当前代码发送顶层 `model` 和 `input`。
- `input.prompt`: 连接的 Prompt 文本。
- `input.images`: 连接的参考图；文生图时不发送空 `images`。
- `input.aspect_ratio`: 从 AR 选择项提取并转成模型支持的比例，如 `1:1`、`16:9`、`9:16`。
- `input.image_size`: 前台 Res，保留 `512`、`1K`、`2K`、`4K`。
- `input.n`: 当前不用于 Gemini 多图。真实测试发现上游批量拆分偶发整单失败；服务端会把 Gemini Image Count 拆成多个 `n=1` 异步任务，逐张轮询并合并结果。
- `Thinking Mode`、`Google Search`、`Image Search` 当前不展示；除非文档明确给出异步 `input` 对应字段，避免出现 UI 可选但请求不生效。

## 尺寸限制

不同模型不要共用同一套分辨率换算。

GPT 需要提交实际像素 `size`：

- 1K 方图：`1024x1024`。
- 1K 横图或竖图：长边按 `1536` 换算，例如 `3:2` 是 `1536x1024`。
- 2K：长边按 `2048` 换算。
- 4K：长边按 `3840` 换算，但还必须满足总像素上限。

Gemini 异步任务不提交像素 `size`。当前代码提交 `input`：

- `image_size`: `512`、`1K`、`2K`、`4K`。
- `aspect_ratio`: 模型支持的比例。

异步 `input` 写法对应字段是 `image_size` 和 `aspect_ratio`，不要和 Gemini 原生同步接口的 `generationConfig.imageConfig` 混用。

本地日志已记录 GPT 上游限制：

- 最长边不能超过 `3840px`。
- 总像素不能超过 `8,294,400`。

因此 GPT 4K 不能简单映射成 `4096x4096`，也不能和 Gemini 的 `4K` 枚举混为一谈。服务端应按模型、比例压到合法范围：

- 1:1 4K：约 `2880x2880`。
- 16:9 4K：`3840x2160`。
- 9:16 4K：`2160x3840`。

前台包含一些极宽/极高比例。服务端需要转换成对应模型能接受的最近合法比例：

- GPT：最大长短边比 `3:1`，例如 `4:1`、`8:1` 转成 `3:1`，`1:4`、`1:8` 转成 `1:3`。
- Gemini：按模型支持比例就近匹配，极宽接近 `21:9`，极高接近 `9:16`。

## AI Canvas 实现注意事项

- 前台 Running 状态允许再次点击停止，停止后旧请求返回不得写入画布。
- 成功返图后追加新的 Image 图框，不覆盖旧图。
- 同时调用 `/api/canvas/generated-images` 写入备份库。
- 备份库和画布图框相互独立，删除任一方不影响另一方。
- Image 图框总数上限是 100，AI 返图也必须共用编号规则。
- 调试日志写入 `.ai-canvas/ai-generate-debug.local.json`，只记录安全字段，不持久化 API Key。
