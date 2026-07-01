# Codex Master Prompt

你正在开发 AI Canvas 项目。

请先完整阅读以下文件：

```text
docs/01_PRODUCT_PRD.md
docs/02_UI_DESIGN_SYSTEM.md
docs/03_INTERACTION_SPEC.md
docs/04_NODE_SPEC.md
docs/05_TECH_ARCHITECTURE.md
docs/06_API_LOGIC_RESERVED.md
docs/07_ACCEPTANCE_CHECKLIST.md
```

同时参考：

```text
references/
prototypes/
```

第一阶段目标：

```text
只开发本地可运行的高保真空框架。
```

必须完成：

- 高保真 UI
- 无限点阵画布
- 左侧工具栏
- 顶部栏
- 右下缩放/网格控制
- Image / Prompt / Image Chat / Multi Generate 节点
- 节点拖动、选择、多选、框选、删除、置顶
- 同色连接点连接
- 连接线删除
- 图片拖入/粘贴自动创建 Image 节点
- 设置页空壳

禁止开发：

- 登录
- 保存
- 分享
- 导出
- 支付
- 真实 AI API
- 云端同步

技术栈：

```text
Next.js + React + TypeScript + Tailwind CSS + React Flow + Lucide React + Zustand
```

本地运行：

```bash
npm install
npm run dev
```

视觉要求：

```text
必须接近 references 中的高保真参考图。
不要做成普通后台系统。
不要自己发挥重设计。
```
