# AI Canvas Codex 开发包

目标：让 Codex 先完成「本地可运行的高保真空框架」，包含美工、画布、节点、连接、基础交互。第一版不要接真实 AI，不要做登录/保存/分享/支付。

## 文件结构

```text
AI-Canvas-Codex-Pack/
├── docs/
│   ├── 01_PRODUCT_PRD.md
│   ├── 02_UI_DESIGN_SYSTEM.md
│   ├── 03_INTERACTION_SPEC.md
│   ├── 04_NODE_SPEC.md
│   ├── 05_TECH_ARCHITECTURE.md
│   ├── 06_API_LOGIC_RESERVED.md
│   └── 07_ACCEPTANCE_CHECKLIST.md
├── prompts/
│   ├── 01_CODEX_MASTER_PROMPT.md
│   ├── 02_FIGMA_MCP_PROMPT.md
│   ├── 03_NEXTJS_IMPLEMENTATION_PROMPT.md
│   ├── 04_FIX_AND_REVIEW_PROMPT.md
│   └── 05_API_PHASE_PROMPT.md
├── references/
│   └── 高保真参考图与问题参考图
├── prototypes/
│   └── 之前的 HTML 交互原型
├── api/
│   └── 12AI_RESERVED_NOTES.md
└── figma/
    └── README_FIGMA.md
```

## 开发顺序

1. 让 Codex 读取整个文件夹，先看 `prompts/01_CODEX_MASTER_PROMPT.md`。
2. 如果 Codex 已连接 Figma 插件/MCP，先执行 `prompts/02_FIGMA_MCP_PROMPT.md`，创建 Figma Design System 与高保真页面。
3. Figma 通过后，再执行 `prompts/03_NEXTJS_IMPLEMENTATION_PROMPT.md`，生成本地 Next.js 项目。
4. 本地运行 `npm install && npm run dev`。
5. 截图给 ChatGPT 检查 UI 与交互。
6. 用 `prompts/04_FIX_AND_REVIEW_PROMPT.md` 让 Codex 修正。
7. 框架满意后，再进入 API 阶段，使用 `prompts/05_API_PHASE_PROMPT.md`。

## 第一版必须达成

- 高保真 UI 框架完成
- 无限点阵画布完成
- 左侧工具栏完成
- 顶部栏完成
- 右下角缩放/网格控制完成
- Image / Prompt / Image Chat / Multi Generate 节点完成
- 节点可拖动、选中、多选、删除、置顶
- 同色连接点才能连接
- 连接线从圆点中心到圆点中心
- 点击连接线显示红色减号，点击后断连
- 图片拖入画布自动生成 Image 节点
- 粘贴图片自动生成 Image 节点

第一版不要接真实 AI。
