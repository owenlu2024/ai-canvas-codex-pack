# Figma 工作说明

如果 Codex 已连接 Figma 插件/MCP，请先让 Codex 做 Figma Design System，再写代码。

推荐顺序：

1. 创建 Figma 文件：AI Canvas Design System
2. 建立设计变量：颜色、字体、间距、圆角、阴影
3. 建立组件：TopBar、LeftToolbar、ZoomControl、NodeCard、PortDot、ConnectionLine、AddNodePopover
4. 创建高保真页面：AI Canvas Main Frame
5. 对照 references 文件夹中的图片做 1:1 还原
6. 设计通过后，再生成 Next.js 代码

要求：

- 不要重新设计风格
- 不要改成后台系统
- 严格使用 UI_DESIGN_SYSTEM.md
- 严格参考 references 中的高保真图片
