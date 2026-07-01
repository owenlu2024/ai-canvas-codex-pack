# AI Canvas 技术架构 v1.0

## 1. 技术栈

推荐：

```text
Next.js
React
TypeScript
Tailwind CSS
React Flow
Lucide React
Zustand
```

后期桌面端：

```text
Tauri
```

## 2. 本地运行

必须支持：

```bash
npm install
npm run dev
```

默认访问：

```text
http://localhost:3000
```

## 3. 推荐目录结构

```text
ai-canvas/
├── app/
│   ├── page.tsx
│   └── settings/page.tsx
├── components/
│   ├── layout/
│   │   ├── TopBar.tsx
│   │   ├── LeftToolbar.tsx
│   │   └── ZoomControl.tsx
│   ├── canvas/
│   │   ├── Canvas.tsx
│   │   ├── PortDot.tsx
│   │   ├── ConnectionLine.tsx
│   │   └── AddNodePopover.tsx
│   └── nodes/
│       ├── BaseNode.tsx
│       ├── ImageNode.tsx
│       ├── PromptNode.tsx
│       ├── ImageChatNode.tsx
│       └── MultiGenerateNode.tsx
├── lib/
│   ├── nodeTypes.ts
│   ├── connectionRules.ts
│   ├── zIndex.ts
│   └── apiProvider.ts
├── store/
│   └── canvasStore.ts
├── styles/
│   └── globals.css
└── .env.local.example
```

## 4. 状态管理

建议使用 Zustand。

核心状态：

```ts
nodes: CanvasNode[]
edges: CanvasEdge[]
selectedNodeIds: string[]
selectedEdgeId?: string
zoom: number
pan: { x: number; y: number }
gridEnabled: boolean
globalZIndex: number
```

## 5. 节点数据结构

```ts
type NodeType = "image" | "prompt" | "imageChat" | "multiGenerate";

type PortType = "image" | "text";

interface CanvasNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  selected: boolean;
  data: Record<string, unknown>;
}
```

## 6. 连线数据结构

```ts
interface CanvasEdge {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  type: PortType;
  selected: boolean;
}
```

## 7. 图层实现

每次点击或拖动节点：

```ts
globalZIndex += 1;
node.zIndex = globalZIndex;
```

渲染前按 zIndex 排序。

## 8. 连接实现

连接前检查：

```ts
if (sourcePort.type !== targetPort.type) return false;
```

必须使用端口中心坐标绘制贝塞尔曲线。

## 9. 代码原则

第一版不要过度封装 API。

但要把 UI、交互、节点数据结构拆干净，方便后期接 AI。
