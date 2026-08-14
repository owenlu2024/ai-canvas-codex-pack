# AI Canvas UI Design System v1.1

## 1. 设计目标

界面必须是高保真桌面专业软件风格，不要做成普通网页后台。

关键词：

```text
Clean / Minimal / Professional / Apple-like / Figma-like
```

参考：

- Figma
- FigJam
- Lovart
- Linear
- Raycast

禁止风格：

- Ant Design Pro 后台
- Bootstrap 后台
- 低代码平台后台
- 传统流程图软件

## 2. 色彩规范

```text
App Background: #F7F8FB
Canvas Background: #F8FAFC
Node Background: #FFFFFF
Node Border: #E6E9F0
Primary Text: #111827
Secondary Text: #8A94A6
Selected Purple Blue: #6C63FF
Image Port Green: #2ECC71
Text Port Yellow: #FFC928
Connection Line: #BFC6D4
Danger Red: #FF4D4F
Toolbar Background: #FFFFFF
Content Area: #F5F6FA
Grid Dot: #D6DBE6
```

## 3. 字体规范

```text
English: Inter
Chinese: PingFang SC / system-ui
```

CSS 建议：

```css
font-family: Inter, "PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

## 4. 顶部栏

高度：64px
背景：白色
底部边框：1px solid #E6E9F0

只保留：

- Logo
- 项目名称
- Undo
- Redo

不要出现：

- 保存
- 导出
- 分享
- 全局运行
- 顶部 Zoom 百分比
- 顶部 Fullscreen / 适配视图按钮

## 5. 左侧工具栏

位置：左侧浮动，始终垂直居中
宽度：58px
背景：白色 / 95% 不透明
圆角：29px，胶囊工具条
阴影：柔和浅阴影
图标：Lucide React

工具条只常驻显示图标，不常驻显示文字。鼠标悬停图标时，在工具条右侧显示功能文字提示。

图标按钮：

```text
按钮尺寸：44px × 44px
按钮形状：圆形
Active 背景：#6C63FF
Active 图标：#FFFFFF
Inactive 图标：#374151
Inactive 背景：transparent
Hover 背景：#F4F6FA
点击反馈：按钮短暂缩放至 94%
选择工具常驻 Active，空白处按住左键拖拽即框选
```

Hover 文字提示：

```text
形状：两头跑道圆 / pill
背景：#6C63FF
文字：#FFFFFF
字号：13px
字重：500
内边距：8px 14px
阴影：0 10px 24px rgba(108, 99, 255, 0.24)
位置：工具条右侧 54px，垂直对齐当前图标中心
```

顺序：

1. 选择
2. 添加节点
3. 群组
4. 取消群组
5. 删除
6. 设置

图标建议：

```text
MousePointer2
CirclePlus
Group
Ungroup
Trash2
Settings
```

## 6. 右下控制栏

内容：

- Collapse >
- -
- Zoom %
- +
- 9-dot Grid

规则：

```text
整体外形：白色跑道圆胶囊，高度 52px，圆角 26px
内部图标按钮：40px × 40px，圆形，点击有轻微压感
Zoom % 主按钮：高度 40px，宽度约 118px，两头跑道圆，字号 18px，与节点标题字号一致
Zoom %：中间主按钮，点击展开菜单
左侧 >：点击后整条向右收起为 52px 圆形按钮，并显示 <
收起态 <：点击后向左还原完整控制条
收起 / 展开：使用宽度过渡，不能突然跳变
Grid 图标：9 个小点
Zoom 数字：使用固定宽度和 tabular-nums，避免缩放时文字抖动
一个 Grid 开关即可。
Grid 开 = 显示网格 + 节点吸附。
Grid 关 = 隐藏网格 + 自由拖动。
```

Zoom 菜单：

```text
缩放至 100%
适合屏幕
选中内容最大化 (Z)
```

## 7. 画布

背景：#F8FAFC
默认显示点阵网格。
网格为浅灰小圆点，间距 32px。
网格必须无限延伸。

层级顺序：

```text
1. 网格
2. 连接线
3. 节点
4. 选中框
5. 浮动按钮 / 弹窗
```

网格永远不能覆盖节点。

## 8. 节点卡片

标准节点尺寸：

```text
width: 320px
height: 260px
```

节点样式：

```text
背景：#FFFFFF
圆角：18px
边框：1px solid #E6E9F0
阴影：0 4px 20px rgba(15, 23, 42, 0.06)
```

标题：

```text
所有节点标题字号统一：18px
字重：700
颜色：#111827
Generate Image / Image / Prompt / Image Chat 等节点标题不得单独放大。
```

内容区：

```text
背景：#F5F6FA
圆角：16px
```

AI 节点 Run 按钮：

```text
背景统一使用 Selected Purple Blue：#6C63FF
Hover：#5B54E8
文字：#FFFFFF
形状：两头跑道圆 / pill
不得使用其他蓝色作为 Run 主按钮颜色
```

AI 节点运行态：

```text
点击 Run 后，节点边框出现一段蓝紫色灯带，沿节点边框逆时针循环移动，表示 AI 正在工作。
跑马灯颜色使用 Selected Purple Blue：#6C63FF。
生成完成后，节点边框恢复正常选中 / 未选中状态。
动画不得改变节点尺寸或挤压内容。
```

## 9. 节点选中

选中样式：

```text
1px #6C63FF 描边
0 0 0 4px rgba(108, 99, 255, 0.12) 外发光
```

不要粗边框。

## 10. 连接点

绿色 = 图片 Image
黄色 = 文本 Text / Prompt

连接点样式：

```text
直径：14px
白色描边：2px
轻微阴影
```

图片点：#2ECC71
文本点：#FFC928

## 11. 连接线

```text
颜色：#BFC6D4
粗细：2px
类型：Bezier 曲线
```

连接线必须从圆点中心到圆点中心，不能偏移。

## 12. 图标规范

全部使用 Lucide React。
不要自己画 SVG。

图标统一：

```text
size: 20px
strokeWidth: 1.75
```

推荐图标：

```text
MousePointer2
CirclePlus
Group
Ungroup
Trash2
Settings
Undo2
Redo2
Grid3X3
Hand
Play
X
MinusCircle
ChevronDown
```

## 13. 动画

```text
Hover: 120ms
拖动/置顶视觉反馈: 150ms
弹窗出现: 120ms
```

不要花哨动画。

## 14. 可运行节点统一运行态（强制规范）

本节适用于所有带“运行 / 停止”能力的 AI 节点，包括现有节点和以后新增的节点。

### 14.1 统一原则

```text
所有可运行节点必须复用项目现有运行态组件、CSS 类名和连线逻辑。
新增节点不得单独设计、复制或修改运行特效。
不得为某一种节点增加独有的跑框、闪烁、渐变、呼吸、粒子或连线动画。
如果需要调整运行特效，必须作为全局设计系统修改，并同步影响全部可运行节点。
```

### 14.2 节点运行边框

```text
运行时：显示一段蓝紫色流光，沿节点圆角边框连续循环移动。
颜色：#6C63FF
形式：单段长流光，不使用密集短虚线，不使用多段闪烁。
运动周期：1.15s，linear，无限循环。
边框路径必须贴合节点 18px 圆角。
不得改变节点宽高，不得挤压节点内容。
结束、失败或停止后：立即恢复普通节点边框。
```

统一实现：

```text
组件：components/nodes/shared/NodeShell.tsx
容器运行类：ai-node-running
边框 SVG 类：ai-node-running-border
动画：ai-node-border-run
```

### 14.3 运行状态栏

```text
运行前：状态显示“就绪”，按钮显示“运行”+ Play 图标。
运行中：状态显示“运行中”，按钮显示“停止”+ Square 图标。
完成后：状态显示“已完成”。
失败后：状态显示“失败”，错误信息使用现有错误样式。
按钮、状态标签、字号、颜色、圆角必须复用 NodeHeader 和 NodeStatusBadge。
```

统一实现：

```text
components/nodes/shared/NodeHeader.tsx
components/nodes/shared/NodeStatusBadge.tsx
```

### 14.4 运行连线

```text
节点运行时，与该节点相连的输入线和输出线统一进入运行态。
运行线颜色：#AEB7C8
运行线形式：灰色流动虚线。
虚线节奏：9 8。
运动周期：0.9s，linear，无限循环。
透明度：0.72。
停止、完成或失败后：恢复普通连接线样式。
不得为新增节点使用不同颜色、不同方向或不同速度的连线动画。
```

统一实现：

```text
组件：components/canvas/ConnectionLine.tsx
CSS 类：ai-canvas-edge-running
动画：ai-edge-running
```

### 14.5 运行期间交互锁定

```text
运行中的节点不可删除、复制、移动或修改参数。
运行中的输入端口和输出端口不可重新连接。
运行中的连接线不可删除。
仍然允许点击“停止”终止任务。
停止后恢复全部正常交互。
```

### 14.6 新增节点接入检查表

每次新增可运行节点，必须同时完成以下项目：

```text
[ ] NodeShell 的 running 属性绑定 runState === "running"
[ ] 使用统一 NodeHeader 和 NodeStatusBadge
[ ] 加入 ConnectionLine 的运行节点识别名单
[ ] 加入 Canvas 的运行锁定识别名单
[ ] 加入 PortDot 的运行锁定识别名单
[ ] 加入 SelectionToolbar 和 CanvasContextMenu 的运行锁定识别名单
[ ] 加入 canvasStore 的运行锁定识别名单
[ ] 验证运行边框与既有节点一致
[ ] 验证全部输入线和输出线均显示相同流动虚线
[ ] 验证停止、完成、失败后动画和锁定均正确解除
```

验收标准：将新增节点与任意一个现有稳定 AI 节点同时运行，两者的节点边框、状态栏、停止按钮、连线动画和交互锁定必须完全一致。
