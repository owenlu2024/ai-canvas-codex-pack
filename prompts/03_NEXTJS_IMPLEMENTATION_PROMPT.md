# Next.js Implementation Prompt

请基于当前项目文档和 references，高保真实现 AI Canvas 本地原型。

技术栈：

```text
Next.js
React
TypeScript
Tailwind CSS
React Flow
Lucide React
Zustand
```

请创建完整项目，并确保：

```bash
npm install
npm run dev
```

可以在：

```text
http://localhost:3000
```

运行。

必须实现：

1. Layout
   - TopBar
   - LeftToolbar
   - Canvas
   - ZoomControl

2. Canvas
   - Infinite canvas
   - Dotted infinite grid
   - Middle mouse pan
   - Cmd/Ctrl + wheel zoom
   - Grid toggle controls grid visibility and snap behavior

3. Nodes
   - Image
   - Prompt
   - Image Chat
   - Multi Generate

4. Selection
   - Click select
   - Shift click multi-select
   - Esc deselect
   - Box select
   - Selected node has 1px blue-purple outline

5. Z-Index
   - Last clicked node must always be on top
   - Selected nodes must never be hidden behind unselected nodes

6. Connections
   - Green image port only connects to green image port
   - Yellow text port only connects to yellow text port
   - Bezier curve from port center to port center
   - Click edge to show red minus delete button
   - Click red minus to delete edge

7. Image drag/paste
   - Drag image file to canvas creates Image node
   - Paste image creates Image node
   - Multiple images create multiple Image nodes

8. Settings shell
   - Empty settings page for future API config

禁止：

- Do not implement real AI API
- Do not implement login
- Do not implement save/export/share
- Do not show onboarding hint text on canvas
- Do not show 12API brand in UI

完成后请对照 docs/07_ACCEPTANCE_CHECKLIST.md 自检。
